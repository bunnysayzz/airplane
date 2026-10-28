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

/** A complete log line starts with an ISO timestamp and a kind token. */
const TIMESTAMPED_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S+/;

/** Byte length of a line in UTF-8, not UTF-16 code units. */
function utf8ByteLength(line: string): number {
  const encoder = (
    globalThis as { TextEncoder?: new () => { encode(input: string): Uint8Array } }
  ).TextEncoder;
  if (encoder === undefined) return line.length;
  return new encoder().encode(line).length;
}

/** Drop oldest lines until both caps hold. Pure, for tests and the writer. */
export function rotateDiagnosticsLogLines(lines: string[]): string[] {
  const kept = lines.slice();
  while (kept.length > MAX_DIAGNOSTICS_LOG_LINES) kept.shift();
  let bytes = kept.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0);
  while (kept.length > 0 && bytes > MAX_DIAGNOSTICS_LOG_BYTES) {
    bytes -= utf8ByteLength(kept[0]) + 1;
    kept.shift();
  }
  return kept;
}

/**
 * Append-only writer over a file port. Writes are coalesced: an append
 * during an in-flight write marks the buffer dirty and flushes again
 * after, so no event is lost and concurrent writes never interleave.
 * A failed write never throws to the caller: logging must never break
 * the app it is diagnosing. Two rules keep a failed write from losing
 * the tail anyway: lines appended during a failed write are re-flushed
 * from the finally block (without it they would sit in memory with no
 * flush scheduled until the next append, so closing the app right
 * after would lose them), and the failure itself is recorded for the
 * Diagnostics screen instead of vanishing as a stale file.
 * Appends that land while the file is still loading are buffered and
 * drained in order once the read finishes, so the load can never wipe
 * lines that arrived during its own async window.
 * Sink appends (via appendCoalesced) are coalesced on the same trailing
 * 250ms window as the collector notify throttle: lines arriving in a
 * burst are held and written once, and per-chunk frame lines are
 * collapsed to one summary line per peer per window with the fragment
 * counts summed. The collector snapshot counters stay exact; only the
 * file lines are coalesced. flush() always drains the coalesced
 * queue first, so share and background paths never miss the tail.
 */
export interface DiagnosticsLogWriteStatus {
  /** Null until the first write attempt finishes. */
  ok: boolean | null;
  atMs: number | null;
  /** Sanitized failure reason from the last failed write, else null. */
  error: string | null;
}

export class DiagnosticsLogWriter {
  private readonly port: DiagnosticsLogFilePort;
  private lines: string[] = [];
  private byteCount = 0;
  private flushing = false;
  private dirty = false;
  private loadStarted = false;
  private loadComplete = false;
  /** Lines appended while the file was still loading. Drained in order by load(). */
  private pendingLines: string[] = [];
  /** Lines the file held when load() read it, before pending lines were drained. */
  private loadedFromFile = 0;
  /** Null until load() finishes; false when the file could not be read. */
  private loadOk: boolean | null = null;
  private lastWrite: DiagnosticsLogWriteStatus = { ok: null, atMs: null, error: null };
  /**
   * Lines confirmed on disk. Updated only when a flush write succeeds,
   * never on append: after a failed write the in-memory count keeps
   * growing while this one stays at the last good write, so the screen
   * can show memory vs on-disk honestly instead of one blended count.
   */
  private flushedLineCount = 0;
  /**
   * Sink coalescing queue (P1-21). Fragment entries aggregate by peer
   * label and direction; plain entries pass through in order.
   */
  private coalesced: Array<{
    label: string | null;
    direction: string | null;
    prefix: string | null;
    count: number;
    plain: string | null;
  }> = [];
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(port: DiagnosticsLogFilePort) {
    this.port = port;
  }

  /** Load the surviving file (if any) so lines survive a restart. */
  async load(): Promise<void> {
    if (this.loadStarted) return;
    this.loadStarted = true;
    try {
      const content = await this.port.read();
      if (content !== null && content.length > 0) {
        const loaded = content.split('\n').filter((l) => l.length > 0);
        // A kill mid-write can leave a partial last line even with the
        // tmp-plus-rename port (an older file written the same way).
        // Drop a trailing line that does not match the timestamped
        // format instead of keeping a fragment as if it were a line.
        if (loaded.length > 0 && !TIMESTAMPED_LINE_RE.test(loaded[loaded.length - 1])) {
          loaded.pop();
        }
        this.lines = rotateDiagnosticsLogLines(loaded);
      }
      this.loadOk = true;
    } catch {
      this.lines = [];
      this.loadOk = false;
    }
    this.loadedFromFile = this.lines.length;
    this.loadComplete = true;
    // Appends that landed while the file was loading were buffered, not
    // dropped and not wiped by the read above. Drain them in order now.
    const pending = this.pendingLines;
    this.pendingLines = [];
    for (const line of pending) {
      this.pushLine(line);
    }
    this.byteCount = this.lines.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0);
    // The final flush runs whenever a flush was requested during load
    // (dirty), not only when pending lines exist: without it, a flush
    // requested during the load window would never land.
    if (pending.length > 0 || this.dirty) {
      void this.flush();
    }
  }

  getLineCount(): number {
    return this.lines.length + this.pendingLines.length;
  }

  getByteCount(): number {
    // Pending lines count too: during load the line count already
    // includes them, and the byte count must describe the same set.
    return (
      this.byteCount +
      this.pendingLines.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0)
    );
  }

  /**
   * Lines the file held at load time. After a restart, compare with
   * the line count: equal (plus new launch lines) means the file
   * survived, lower means lines were lost before the restart.
   */
  getLoadedFromFileCount(): number {
    return this.loadedFromFile;
  }

  /** Lines confirmed on disk by the last successful flush. */
  getFlushedLineCount(): number {
    return this.flushedLineCount;
  }

  getLoadOk(): boolean | null {
    return this.loadOk;
  }

  getLastWriteStatus(): DiagnosticsLogWriteStatus {
    return { ...this.lastWrite };
  }

  private pushLine(line: string): void {
    this.lines.push(line);
    this.byteCount += utf8ByteLength(line) + 1;
    this.lines = rotateDiagnosticsLogLines(this.lines);
    this.byteCount = this.lines.reduce((sum, l) => sum + utf8ByteLength(l) + 1, 0);
  }

  /** Test seam: the current lines, oldest first. */
  getLines(): string[] {
    return [...this.lines];
  }

  /**
   * Coalesced sink append: hold the line for at most one trailing
   * 250ms window, collapsing per-chunk fragment lines for the same
   * peer and direction into a single summed summary line. Falls back
   * to the plain append path while the file is still loading, so the
   * load buffer contract still holds.
   */
  appendCoalesced(line: string): void {
    if (!this.loadComplete) {
      this.append(line);
      return;
    }
    const fragment = /^(\S+ frames \S+) (fragments-sent|fragments-received) (\d+)$/.exec(line);
    if (fragment) {
      const [, prefix, direction, countText] = fragment;
      const label = prefix.split(' ').pop() ?? prefix;
      const existing = this.coalesced.find(
        (entry) => entry.label === label && entry.direction === direction,
      );
      if (existing) {
        existing.count += Number(countText);
      } else {
        this.coalesced.push({ label, direction, prefix, count: Number(countText), plain: null });
      }
    } else {
      this.coalesced.push({ label: null, direction: null, prefix: null, count: 0, plain: line });
    }
    if (this.coalesceTimer === null) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null;
        this.drainCoalesced();
        void this.flush();
      }, DIAGNOSTICS_LOG_SINK_THROTTLE_MS);
    }
  }

  /** Move coalesced lines into the line list, preserving order. */
  private drainCoalesced(): void {
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    const queued = this.coalesced;
    this.coalesced = [];
    for (const entry of queued) {
      if (entry.plain !== null) {
        this.pushLine(entry.plain);
      } else if (entry.prefix !== null && entry.direction !== null) {
        this.pushLine(`${entry.prefix} ${entry.direction} ${entry.count}`);
      }
    }
  }

  append(line: string): void {
    if (!this.loadComplete) {
      // The file is still loading: buffer, do not drop, and do not let
      // the read finishing below wipe this line when it replaces the
      // line list. The buffer is capped like the file itself.
      this.pendingLines.push(line);
      if (this.pendingLines.length > MAX_DIAGNOSTICS_LOG_LINES) {
        this.pendingLines.shift();
      }
      return;
    }
    this.pushLine(line);
    void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.loadComplete) {
      // The file is still loading and this.lines is empty: writing now
      // would blank the surviving file. Mark dirty so load's final
      // flush writes the loaded lines plus anything appended since.
      this.dirty = true;
      return;
    }
    if (this.loadOk === false) {
      // The load failed, so this.lines does not hold the surviving
      // file: flushing now would destroy history a transient read
      // failure left behind. Lines stay in memory; flush stays a
      // no-op while loadOk is false, and the screen already reports
      // the load failure. Deliberately not marked dirty, so a share
      // waiting on quiescence does not hang on a blocked flush.
      return;
    }
    // Coalesced sink lines belong in this flush, not the next one:
    // drain them into the line list before deciding anything else.
    this.drainCoalesced();
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
        this.flushedLineCount = this.lines.length;
        this.lastWrite = { ok: true, atMs: Date.now(), error: null };
      } while (this.dirty);
    } catch (error) {
      // Logging never breaks the app; the next append retries. The
      // failure is recorded for the Diagnostics screen instead of
      // vanishing: a stale file with a failed-write status beats a
      // stale file with no explanation.
      this.lastWrite = {
        ok: false,
        atMs: Date.now(),
        error: String(error instanceof Error ? error.message : error)
          .replace(/[\r\n]+/g, ' ')
          .trim()
          .slice(0, 120),
      };
    } finally {
      this.flushing = false;
      if (this.dirty) {
        // Lines landed during a failed write (or after the last write
        // of this flush): without this re-flush they sit in memory
        // with no flush scheduled until the next append, so closing
        // the app right after loses the tail. Flush them now. This
        // cannot loop on its own: dirty is set only by appends.
        void this.flush();
      }
    }
  }

  /**
   * Resolve only when the writer is quiescent: no write in flight and
   * nothing dirty. flush() alone cannot promise this: it returns
   * immediately when a write is already in flight, just marking dirty.
   * Share awaits this instead of flush so the shared file contains
   * the lines that triggered the last flush, not the previous write.
   */
  async flushComplete(): Promise<void> {
    await this.flush();
    while (this.flushing || this.dirty) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Trailing coalescing window for sink appends, matching the notify throttle. */
const DIAGNOSTICS_LOG_SINK_THROTTLE_MS = 250;

/**
 * Attach a writer as the collector sink. From this point every
 * collector event becomes one timestamped log line, with no call-site
 * changes beyond the hooks already in diagnostics.ts. Lines go through
 * the coalesced append path, so per-chunk bursts cost one write per
 * window instead of one write per chunk.
 */
export function attachDiagnosticsLogWriter(writer: DiagnosticsLogWriter): void {
  setDiagnosticsLogSink((kind: string, detail: string) => {
    writer.appendCoalesced(formatDiagnosticsLogLine(Date.now(), kind, detail));
  });
}

export function detachDiagnosticsLogWriter(): void {
  setDiagnosticsLogSink(null);
}
