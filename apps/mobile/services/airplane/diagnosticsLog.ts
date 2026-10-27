// SPDX-License-Identifier: Apache-2.0
// Automatic diagnostics log file (LOG queue item, 2026-10-27).
//
// The diagnostics collector (diagnostics.ts) already gathers everything
// the Diagnostics screen shows, but only in memory: it vanishes on
// restart and cannot be sent to anyone. This module persists that same
// data, and nothing else, to a log file the user can share.
//
// Privacy boundary, enforced by construction, not by review:
// - Log lines are built ONLY from collector hook arguments (states,
//   peer tag ids as shown on screen, sizes, outcomes, stage-tagged
//   failure codes). No collector hook receives post text, location
//   coordinates, cell ids, or full pubkeys, so none can reach the file.
// - The message hook deliberately drops the message id: direction, size,
//   final status and attempt outcomes are logged, the id is not.
// - formatDiagnosticsLogLine strips newlines and truncates detail, so
//   a rogue detail string cannot smuggle a second line into the file.
//
// No React Native or Expo import here: the formatter, rotation and
// writer run in Node tests against an in-memory port. The real file
// port and the share sheet live in diagnosticsLogExpo.ts.

import { setDiagnosticsLogSink } from './diagnostics';

/** Rotation cap: newest lines are kept, oldest are dropped first. */
export const MAX_DIAGNOSTICS_LOG_LINES = 5000;
/** Rotation cap: about 2 MB of text. Both caps apply, whichever hits first. */
export const MAX_DIAGNOSTICS_LOG_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_CHARS = 240;

export interface DiagnosticsLogFilePort {
  /** Existing file content, or null when the file does not exist yet. */
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

/** One timestamped line. Detail is sanitized: no newlines, truncated. */
export function formatDiagnosticsLogLine(atMs: number, kind: string, detail: string): string {
  const clean = detail.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  const stamp = new Date(atMs).toISOString();
  return clean.length > 0 ? `${stamp} ${kind} ${clean}` : `${stamp} ${kind}`;
}

/** Drop oldest lines until both caps hold. Pure, for tests and the writer. */
export function rotateDiagnosticsLogLines(lines: string[]): string[] {
  const kept = lines.slice();
  while (kept.length > MAX_DIAGNOSTICS_LOG_LINES) kept.shift();
  let bytes = kept.reduce((sum, line) => sum + line.length + 1, 0);
  while (kept.length > 0 && bytes > MAX_DIAGNOSTICS_LOG_BYTES) {
    bytes -= kept[0].length + 1;
    kept.shift();
  }
  return kept;
}

/**
 * Append-only writer over a file port. Writes are coalesced: an append
 * during an in-flight write marks the buffer dirty and flushes again
 * after, so no event is lost and concurrent writes never interleave.
 * A failed write never throws to the caller: logging must never break
 * the app it is diagnosing. The failure is visible only as a stale
 * file, never as a crash.
 */
export class DiagnosticsLogWriter {
  private readonly port: DiagnosticsLogFilePort;
  private lines: string[] = [];
  private byteCount = 0;
  private flushing = false;
  private dirty = false;
  private loaded = false;

  constructor(port: DiagnosticsLogFilePort) {
    this.port = port;
  }

  /** Load the surviving file (if any) so lines survive a restart. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const content = await this.port.read();
      if (content !== null && content.length > 0) {
        this.lines = rotateDiagnosticsLogLines(content.split('\n').filter((l) => l.length > 0));
      }
    } catch {
      this.lines = [];
    }
    this.byteCount = this.lines.reduce((sum, line) => sum + line.length + 1, 0);
  }

  getLineCount(): number {
    return this.lines.length;
  }

  getByteCount(): number {
    return this.byteCount;
  }

  /** Test seam: the current lines, oldest first. */
  getLines(): string[] {
    return [...this.lines];
  }

  append(line: string): void {
    this.lines.push(line);
    this.byteCount += line.length + 1;
    this.lines = rotateDiagnosticsLogLines(this.lines);
    this.byteCount = this.lines.reduce((sum, l) => sum + l.length + 1, 0);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      this.dirty = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.dirty = false;
        const content = this.lines.length > 0 ? `${this.lines.join('\n')}\n` : '';
        await this.port.write(content);
      } while (this.dirty);
    } catch {
      // Logging never breaks the app; the next append retries.
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Attach a writer as the collector sink. From this point every
 * collector event becomes one timestamped log line, with no call-site
 * changes beyond the hooks already in diagnostics.ts.
 */
export function attachDiagnosticsLogWriter(writer: DiagnosticsLogWriter): void {
  setDiagnosticsLogSink((kind: string, detail: string) => {
    writer.append(formatDiagnosticsLogLine(Date.now(), kind, detail));
  });
}

export function detachDiagnosticsLogWriter(): void {
  setDiagnosticsLogSink(null);
}
