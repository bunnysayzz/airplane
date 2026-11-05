// SPDX-License-Identifier: Apache-2.0
// Expo port for the automatic diagnostics log file (LOG queue item).
//
// The file lives in the app documents directory, so it survives a
// restart and is reachable by the Android share sheet. Sharing uses the
// system share sheet: the user can save the file to Files while
// offline and send it later when online. Nothing here uploads anything
// on its own; sharing only happens on the user's tap of the Share
// button on the Diagnostics screen.

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { isSentryEnabled, takeSentryDisabledNote } from '../../src/sentry';
import {
  attachDiagnosticsLogWriter,
  detachDiagnosticsLogWriter,
  DiagnosticsLogWriter,
  formatDiagnosticsLogLine,
  type DiagnosticsLogFilePort,
} from './diagnosticsLog';
import { getKv } from './kv';
import { initializeLogInboxWatermarkIfNeeded } from './logInbox';

export const DIAGNOSTICS_LOG_FILE_NAME = 'airplane-diagnostics.log';
/** Status marker when no document directory exists: never a bare filename. */
export const DIAGNOSTICS_LOG_FILE_UNAVAILABLE = 'unavailable';

function logFileUri(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) return DIAGNOSTICS_LOG_FILE_UNAVAILABLE;
  return `${dir}${DIAGNOSTICS_LOG_FILE_NAME}`;
}

function createExpoDiagnosticsLogPort(): DiagnosticsLogFilePort {
  const uri = logFileUri();
  return {
    read: async () => {
      // No directory: skip the read instead of probing a bare filename.
      if (uri === DIAGNOSTICS_LOG_FILE_UNAVAILABLE) return null;
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) return null;
      return FileSystem.readAsStringAsync(uri);
    },
    write: async (content: string) => {
      // No directory: fail loudly so the write status reports it,
      // instead of silently pretending the flush landed.
      if (uri === DIAGNOSTICS_LOG_FILE_UNAVAILABLE) {
        throw new Error('document directory unavailable');
      }
      // Atomic replace on the same volume: a kill mid-write leaves
      // either the old file or the new file, never a truncation.
      // The tmp name is constant, so no user input reaches the path.
      const tmpUri = `${uri}.tmp`;
      await FileSystem.writeAsStringAsync(tmpUri, content);
      await FileSystem.moveAsync({ from: tmpUri, to: uri });
    },
  };
}

let writer: DiagnosticsLogWriter | null = null;
let started = false;
/**
 * A failed log start used to vanish into a swallowed catch in _layout:
 * the app ran with no logging and nothing said so. The failure is kept
 * here and surfaced through getDiagnosticsLogStatus, so the Diagnostics
 * screen can show it instead of a silently empty file.
 */
let startError: string | null = null;

/**
 * Start automatic logging. Idempotent: a second start (StrictMode
 * double-mount in dev, or a second launch effect) is a no-op, so the
 * app-start line is written once per real launch. The first line is
 * the app-start marker; collector events follow from the sink.
 */
export async function startDiagnosticsLogFile(): Promise<void> {
  if (started) return;
  started = true;
  try {
    writer = new DiagnosticsLogWriter(createExpoDiagnosticsLogPort());
    await writer.load();
    // First launch after the delta-upload version ships: anchor the
    // upload watermark at the current end of file, so the first Send
    // after upgrade uploads only lines appended after the upgrade
    // and never re-dumps the history the tester already sent. Best
    // effort only: a KV failure must never break logging startup,
    // and the send flow falls back to one full upload instead.
    try {
      const head = getDiagnosticsLogWatermarkHead();
      if (head !== null) {
        await initializeLogInboxWatermarkIfNeeded(getKv(), head.byteCount, head.headLine);
      }
    } catch {
      // Ignore: the watermark stays absent and Send falls back to full.
    }
    attachDiagnosticsLogWriter(writer);
    writer.append(formatDiagnosticsLogLine(Date.now(), 'app', 'started'));
    // A disabled Sentry client is otherwise invisible: one log line per
    // launch says so plainly instead of looking like "no errors happened".
    if (takeSentryDisabledNote()) {
      writer.append(formatDiagnosticsLogLine(Date.now(), 'sentry', 'disabled'));
    }
  } catch (error: unknown) {
    startError = String(error instanceof Error ? error.message : error)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 120);
    writer = null;
  }
}

export function stopDiagnosticsLogFile(): void {
  if (!started) return;
  started = false;
  detachDiagnosticsLogWriter();
  void writer?.flush();
  writer = null;
}

/** Foreground/background markers, wired from AppState in _layout. The
 * background marker awaits flush quiescence (see flushComplete) so
 * the marker and the unflushed tail get their best chance to land
 * before the OS suspends the app. Honest limit: a kill during the
 * grace window can still lose the tail, because Expo FileSystem
 * offers no synchronous write and a native background task is not
 * justified for a diagnostics marker. */
export async function recordDiagnosticsLogAppState(state: string): Promise<void> {
  if (writer === null) return;
  if (state === 'active') {
    writer.append(formatDiagnosticsLogLine(Date.now(), 'app', 'foreground'));
  } else if (state === 'background') {
    writer.append(formatDiagnosticsLogLine(Date.now(), 'app', 'background'));
    await writer.flushComplete();
  }
}

export interface DiagnosticsLogFileStatus {
  lineCount: number;
  byteCount: number;
  /** Lines the file held when it was loaded. 0 on a fresh install or when the file could not be read. */
  loadedFromFile: number;
  /** False when the file could not be read at load time, null before loading. */
  loadOk: boolean | null;
  /** Null until the first write attempt finishes. */
  lastWriteOk: boolean | null;
  lastWriteAtMs: number | null;
  lastWriteError: string | null;
  /** Lines confirmed on disk by the last successful flush. */
  flushedLineCount: number;
  /** Log start failure, when starting itself failed. Null otherwise. */
  startError: string | null;
  /** Sentry client state at status time: false means disabled, never throwing. */
  sentryEnabled: boolean;
  fileName: string;
  fileUri: string;
}

/**
 * Head of the current log for the upload watermark: the byte length
 * of the loaded file plus its first line, the generation fingerprint.
 * Null when the writer never started or the load failed: the
 * watermark must not anchor on a file that could not be read, or a
 * later Send would delta against the wrong head. TESTING ONLY with
 * the test inbox upload.
 */
export function getDiagnosticsLogWatermarkHead(): {
  byteCount: number;
  headLine: string;
} | null {
  if (writer === null || writer.getLoadOk() !== true) return null;
  const lines = writer.getLines();
  return { byteCount: writer.getByteCount(), headLine: lines.length > 0 ? lines[0] : '' };
}

export function getDiagnosticsLogStatus(): DiagnosticsLogFileStatus {
  const lastWrite = writer?.getLastWriteStatus() ?? { ok: null, atMs: null, error: null };
  return {
    lineCount: writer?.getLineCount() ?? 0,
    byteCount: writer?.getByteCount() ?? 0,
    loadedFromFile: writer?.getLoadedFromFileCount() ?? 0,
    flushedLineCount: writer?.getFlushedLineCount() ?? 0,
    loadOk: writer?.getLoadOk() ?? null,
    lastWriteOk: lastWrite.ok,
    lastWriteAtMs: lastWrite.atMs,
    lastWriteError: lastWrite.error,
    startError,
    sentryEnabled: isSentryEnabled(),
    fileName: DIAGNOSTICS_LOG_FILE_NAME,
    fileUri: logFileUri(),
  };
}

/**
 * Read the current log file text for the test inbox upload. Same file
 * the Share button shares, already redacted by the collector, flushed
 * first so the tail is included. TESTING ONLY, REMOVE AFTER TESTING
 * with the test inbox button. Throws when the file cannot be read.
 */
export async function readDiagnosticsLogText(): Promise<string> {
  if (writer === null) {
    await startDiagnosticsLogFile();
  }
  await writer?.flushComplete();
  if (logFileUri() === DIAGNOSTICS_LOG_FILE_UNAVAILABLE) {
    throw new Error('log file unavailable');
  }
  return FileSystem.readAsStringAsync(logFileUri());
}

/**
 * Open the Android share sheet for the log file. Throws when sharing
 * is unavailable on the device, so the Diagnostics screen can say so
 * plainly instead of pretending the sheet opened.
 */
export async function shareDiagnosticsLogFile(): Promise<void> {
  if (writer === null) {
    await startDiagnosticsLogFile();
  }
  await writer?.flushComplete();
  if (logFileUri() === DIAGNOSTICS_LOG_FILE_UNAVAILABLE) {
    throw new Error('log file unavailable');
  }
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('sharing unavailable');
  await Sharing.shareAsync(logFileUri(), {
    mimeType: 'text/plain',
    dialogTitle: 'Share diagnostics log',
  });
}
