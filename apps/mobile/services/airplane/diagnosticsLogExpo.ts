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

export const DIAGNOSTICS_LOG_FILE_NAME = 'airplane-diagnostics.log';

function logFileUri(): string {
  const dir = FileSystem.documentDirectory ?? '';
  return `${dir}${DIAGNOSTICS_LOG_FILE_NAME}`;
}

function createExpoDiagnosticsLogPort(): DiagnosticsLogFilePort {
  const uri = logFileUri();
  return {
    read: async () => {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) return null;
      return FileSystem.readAsStringAsync(uri);
    },
    write: async (content: string) => {
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
 * Start automatic logging. Idempotent: a second start (StrictMode
 * double-mount in dev, or a second launch effect) is a no-op, so the
 * app-start line is written once per real launch. The first line is
 * the app-start marker; collector events follow from the sink.
 */
export async function startDiagnosticsLogFile(): Promise<void> {
  if (started) return;
  started = true;
  writer = new DiagnosticsLogWriter(createExpoDiagnosticsLogPort());
  await writer.load();
  attachDiagnosticsLogWriter(writer);
  writer.append(formatDiagnosticsLogLine(Date.now(), 'app', 'started'));
  // A disabled Sentry client is otherwise invisible: one log line per
  // launch says so plainly instead of looking like "no errors happened".
  if (takeSentryDisabledNote()) {
    writer.append(formatDiagnosticsLogLine(Date.now(), 'sentry', 'disabled'));
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
  /** Sentry client state at status time: false means disabled, never throwing. */
  sentryEnabled: boolean;
  fileName: string;
  fileUri: string;
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
    sentryEnabled: isSentryEnabled(),
    fileName: DIAGNOSTICS_LOG_FILE_NAME,
    fileUri: logFileUri(),
  };
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
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('sharing unavailable');
  await Sharing.shareAsync(logFileUri(), {
    mimeType: 'text/plain',
    dialogTitle: 'Share diagnostics log',
  });
}
