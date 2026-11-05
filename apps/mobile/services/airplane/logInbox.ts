// SPDX-License-Identifier: Apache-2.0
// One-click diagnostics log upload for the testing phase.
//
// TESTING ONLY, REMOVE AFTER TESTING: this whole file, the "Send to
// test inbox" button on the Diagnostics screen, and the test inbox
// endpoint itself are temporary testing infrastructure. Delete all
// three when the testing phase ends.
//
// The upload sends redacted diagnostics log text plus the app version
// and a timestamp, nothing else. No secret lives in the app: the
// endpoint URL is public by design, and the worst case for abuse is
// log spam into an unlisted store, which is deletable. Failures never
// fake success: every failure path throws, and the Diagnostics screen
// falls back to the Share log button.
//
// Delta uploads: the on-device log is one persistent append-only
// file, and a full re-upload on every tap re-dumps history the tester
// already sent, so the store fills with overlapping copies and no
// upload can be told apart as one test session. Each Send therefore
// uploads only the lines appended since the last successful send.
// A watermark in KV records the byte offset already uploaded plus
// the file's first line as a generation fingerprint. The watermark
// advances only on a successful upload, never on failure, so a
// failed send retries the same delta next time. When the watermark
// is missing or invalid (the file rotated or shrank under it, or
// the log store was reset), the send falls back to one full upload
// and re-anchors the watermark. On first run after this version
// ships, the watermark is initialized to the current end of file,
// so the first upload after upgrade sends only new lines and never
// re-dumps old history. A send with zero new lines uploads nothing
// and reports nothing-new instead of an empty body.
//
// Upload contract (the endpoint implements exactly this): POST JSON
// { log, version, uploadedAt, kind, lines } to
// LOG_INBOX_UPLOAD_URL, respond 200 with JSON { id } where id is
// the stored object's id. kind is 'delta' or 'full', lines is the
// number of lines in the stored text. Older app versions send no
// kind or lines and keep working; the endpoint treats those as full
// uploads. The endpoint rejects bodies over LOG_INBOX_MAX_BYTES,
// same as the app does here. The endpoint stores the log text as
// one object named
// logs/<uploadedAt compact>-<random 8>-v<version>-<kind>.log, so
// every upload is identifiable by version, time, and kind from the
// store listing alone. The id is only the stored file's reference:
// the tester is never asked to send or relay it anywhere. Tapping
// Send is the whole action; new uploads are found by listing the
// store, not by ids anyone passes along.

/** Test inbox endpoint. Plain constant, easy to change when the
 * deployment lands. Public by design; no secret is attached to it. */
export const LOG_INBOX_UPLOAD_URL = 'https://airplane-log-inbox.vercel.app/api/upload';

/** Largest log body the endpoint accepts. Matches the endpoint cap. */
export const LOG_INBOX_MAX_BYTES = 2 * 1024 * 1024;

/** Whether an upload carries only new lines or the whole log. */
export type LogInboxKind = 'delta' | 'full';

export interface LogInboxUploadInput {
  /** Redacted diagnostics log text to store, delta or full. */
  logText: string;
  /** Installed app version, e.g. `0.1.21`, or 'unknown'. */
  version: string;
  /** ISO timestamp of the upload, set by the caller. */
  uploadedAt: string;
  /** 'delta' for new-lines-only, 'full' for a whole-file upload. */
  kind?: LogInboxKind;
  /** Lines in logText; counted from the text when omitted. */
  lines?: number;
}

export interface LogInboxUploadPayload {
  log: string;
  version: string;
  uploadedAt: string;
  kind: LogInboxKind;
  lines: number;
}

export interface LogInboxUploadResult {
  id: string;
  truncated: boolean;
  originalBytes: number;
  kind: LogInboxKind;
  lines: number;
}

export function logTextByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Human size for the confirm dialog: bytes, KB, or MB, one decimal. */
export function formatLogInboxSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Number of non-empty lines in a log text. */
export function countLogLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').filter((line) => line.length > 0).length;
}

/**
 * Cut a log to the endpoint cap, keeping the tail: the newest lines are
 * the ones that diagnose the session, and the head is history. The
 * first line of the cut states the truncation and the original size,
 * so a truncated upload can never be mistaken for a complete log. The
 * cut is byte-aware and line-clean: the tail is sliced by UTF-8 bytes,
 * decoded leniently, and any partial first line is dropped, so the
 * stored object holds whole lines only. Returns the text unchanged
 * when it already fits.
 */
export function truncateLogTextForUpload(
  logText: string,
  maxBytes: number = LOG_INBOX_MAX_BYTES,
): { text: string; truncated: boolean; originalBytes: number } {
  const originalBytes = logTextByteLength(logText);
  if (originalBytes <= maxBytes) {
    return { text: logText, truncated: false, originalBytes };
  }
  const header = `log truncated: original ${originalBytes} bytes, showing tail only\n`;
  const budget = maxBytes - logTextByteLength(header);
  if (budget <= 0) {
    return { text: header, truncated: true, originalBytes };
  }
  const bytes = new TextEncoder().encode(logText);
  const tail = bytes.slice(bytes.length - budget);
  let decoded = new TextDecoder().decode(tail);
  const firstNewline = decoded.indexOf('\n');
  if (firstNewline !== -1) decoded = decoded.slice(firstNewline + 1);
  return { text: header + decoded, truncated: true, originalBytes };
}

export interface LogInboxUploadBuild {
  payload: LogInboxUploadPayload;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Build the upload payload. Throws only on an empty log. An over-cap
 * log is truncated to its tail instead of failing: the button must
 * never fail only because the log is big, and the truncation header
 * inside the upload says so plainly.
 */
export function buildLogInboxUpload(input: LogInboxUploadInput): LogInboxUploadBuild {
  if (input.logText.length === 0) {
    throw new Error('log is empty');
  }
  const cut = truncateLogTextForUpload(input.logText);
  const kind = input.kind ?? 'full';
  return {
    payload: {
      log: cut.text,
      version: input.version,
      uploadedAt: input.uploadedAt,
      kind,
      lines: input.lines ?? countLogLines(cut.text),
    },
    truncated: cut.truncated,
    originalBytes: cut.originalBytes,
  };
}

/** Backwards-compatible payload-only build (truncates when over cap). */
export function buildLogInboxPayload(input: LogInboxUploadInput): LogInboxUploadPayload {
  return buildLogInboxUpload(input).payload;
}

/** Parse the endpoint response. Throws unless it carries a non-empty id. */
export function parseLogInboxResponse(body: unknown): { id: string } {
  if (
    body === null ||
    typeof body !== 'object' ||
    typeof (body as { id?: unknown }).id !== 'string' ||
    ((body as { id: string }).id.length === 0)
  ) {
    throw new Error('bad inbox response');
  }
  return { id: (body as { id: string }).id };
}

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Upload one log. Throws on network failure, on any non-200 status,
 * and on a malformed response, so the caller can never mistake a
 * failure for a sent log. `fetchFn` defaults to global fetch and
 * exists so tests can substitute a fake. The caller advances the
 * upload watermark only after this resolves: a throw here must leave
 * the watermark untouched so the next Send retries the same delta.
 */
export async function sendDiagnosticsLogToInbox(
  input: LogInboxUploadInput,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<LogInboxUploadResult> {
  const build = buildLogInboxUpload(input);
  const response = await fetchFn(LOG_INBOX_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(build.payload),
  });
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status}`);
  }
  const parsed = parseLogInboxResponse(await response.json());
  return {
    id: parsed.id,
    truncated: build.truncated,
    originalBytes: build.originalBytes,
    kind: build.payload.kind,
    lines: build.payload.lines,
  };
}

// ---------------------------------------------------------------------------
// Delta uploads: the watermark.
// ---------------------------------------------------------------------------

/** KV key for the upload watermark. Durable app state, never a secret. */
export const LOG_INBOX_WATERMARK_KV_KEY = 'log-inbox-watermark-v1';

/**
 * Upload watermark: the byte offset of the log file already uploaded,
 * plus the file's first line as a generation fingerprint. The log
 * file is append-only except rotation, which drops oldest lines from
 * the head, so a changed first line (or a file shorter than the
 * offset) proves the watermark no longer describes this file.
 */
export interface LogInboxWatermark {
  v: 1;
  offsetBytes: number;
  headLine: string;
}

/** Minimal KV surface the watermark needs; KvPort satisfies it. */
export interface LogInboxWatermarkKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Parse a stored watermark. Returns null for anything malformed. */
export function parseLogInboxWatermark(raw: string | null): LogInboxWatermark | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1) return null;
    if (
      typeof record.offsetBytes !== 'number' ||
      !Number.isInteger(record.offsetBytes) ||
      record.offsetBytes < 0
    ) {
      return null;
    }
    if (typeof record.headLine !== 'string') return null;
    return { v: 1, offsetBytes: record.offsetBytes, headLine: record.headLine };
  } catch {
    return null;
  }
}

/** Read the watermark. A KV failure reads as no watermark, which the
 * send flow treats as one full upload, never as an error. */
export async function readLogInboxWatermark(
  kv: LogInboxWatermarkKv,
): Promise<LogInboxWatermark | null> {
  try {
    return parseLogInboxWatermark(await kv.get(LOG_INBOX_WATERMARK_KV_KEY));
  } catch {
    return null;
  }
}

/** Persist the watermark. Throws on KV failure; the caller decides
 * what that means (after a successful upload it only means the next
 * Send re-sends the same delta, which is safe). */
export async function writeLogInboxWatermark(
  kv: LogInboxWatermarkKv,
  watermark: LogInboxWatermark,
): Promise<void> {
  await kv.set(LOG_INBOX_WATERMARK_KV_KEY, JSON.stringify(watermark));
}

/**
 * First-run initialization: anchor the watermark at the current end
 * of file, so the first upload after this version ships sends only
 * lines appended after the upgrade and never re-dumps old history.
 * Writes only when no watermark exists yet, so later launches never
 * move it. Returns true when it wrote, false when one already
 * existed. Throws on KV failure; the caller (log startup) treats
 * that as best-effort and the send flow falls back to a full upload.
 */
export async function initializeLogInboxWatermarkIfNeeded(
  kv: LogInboxWatermarkKv,
  byteCount: number,
  headLine: string,
): Promise<boolean> {
  const existing = await readLogInboxWatermark(kv);
  if (existing !== null) return false;
  await writeLogInboxWatermark(kv, { v: 1, offsetBytes: byteCount, headLine });
  return true;
}

function firstLogLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

/**
 * Slice a log text from a byte offset, keeping whole lines only. The
 * offset always lands on a line boundary when the watermark was taken
 * at end of file, but a partial first line is dropped defensively
 * when the byte before the offset is not a newline.
 */
export function sliceLogTextFromByteOffset(text: string, offsetBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (offsetBytes <= 0) return text;
  if (offsetBytes >= bytes.length) return '';
  const tail = bytes.slice(offsetBytes);
  let decoded = new TextDecoder().decode(tail);
  if (bytes[offsetBytes - 1] !== 0x0a) {
    const firstNewline = decoded.indexOf('\n');
    decoded = firstNewline === -1 ? '' : decoded.slice(firstNewline + 1);
  }
  return decoded;
}

/**
 * Does the watermark still describe this file? The file must be at
 * least as long as the offset, and its first line must match the
 * fingerprint. An offset of zero with an empty head matches only an
 * empty file: a fresh install's first upload is a full one, since
 * nothing was ever uploaded before.
 */
export function logInboxWatermarkMatches(
  fullText: string,
  watermark: LogInboxWatermark,
): boolean {
  if (logTextByteLength(fullText) < watermark.offsetBytes) return false;
  if (watermark.offsetBytes === 0) return fullText.length === 0;
  return firstLogLine(fullText) === watermark.headLine;
}

export type LogInboxPlan =
  | { plan: 'none'; kind: null; lines: 0 }
  | {
      plan: 'upload';
      kind: LogInboxKind;
      /** Text to store, already truncated to the endpoint cap. */
      text: string;
      /** Lines in the stored text. */
      lines: number;
      truncated: boolean;
      originalBytes: number;
      /** Watermark to store after a successful upload. */
      newWatermark: LogInboxWatermark;
    };

/**
 * Plan one Send from the full log text and the stored watermark.
 * 'none' when zero new lines exist: the caller must not upload an
 * empty body and shows the nothing-new state instead. 'delta' when
 * the watermark matches: only the appended lines. 'full' when there
 * is no watermark or it no longer matches (rotation, shrink, or a
 * reset log store): the whole file once, then the watermark
 * re-anchors at the new end of file. Oversized deltas and full
 * uploads keep the tail rule with the truncation header.
 */
export function planLogInboxUpload(
  fullText: string,
  watermark: LogInboxWatermark | null,
): LogInboxPlan {
  const newWatermark: LogInboxWatermark = {
    v: 1,
    offsetBytes: logTextByteLength(fullText),
    headLine: fullText.length === 0 ? '' : firstLogLine(fullText),
  };
  if (watermark === null || !logInboxWatermarkMatches(fullText, watermark)) {
    const cut = truncateLogTextForUpload(fullText);
    return {
      plan: 'upload',
      kind: 'full',
      text: cut.text,
      lines: countLogLines(cut.text),
      truncated: cut.truncated,
      originalBytes: cut.originalBytes,
      newWatermark,
    };
  }
  const deltaText = sliceLogTextFromByteOffset(fullText, watermark.offsetBytes);
  if (countLogLines(deltaText) === 0) {
    return { plan: 'none', kind: null, lines: 0 };
  }
  const cut = truncateLogTextForUpload(deltaText);
  return {
    plan: 'upload',
    kind: 'delta',
    text: cut.text,
    lines: countLogLines(cut.text),
    truncated: cut.truncated,
    originalBytes: cut.originalBytes,
    newWatermark,
  };
}
