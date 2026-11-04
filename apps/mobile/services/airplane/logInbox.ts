// SPDX-License-Identifier: Apache-2.0
// One-click diagnostics log upload for the testing phase.
//
// TESTING ONLY, REMOVE AFTER TESTING: this whole file, the "Send to
// test inbox" button on the Diagnostics screen, and the test inbox
// endpoint itself are temporary testing infrastructure. Delete all
// three when the testing phase ends.
//
// The upload sends the already-redacted diagnostics log text plus the
// app version and a timestamp, nothing else. No secret lives in the
// app: the endpoint URL is public by design, and the worst case for
// abuse is log spam into an unlisted store, which is deletable.
// Failures never fake success: every failure path throws, and the
// Diagnostics screen falls back to the Share log button.
//
// Upload contract (the endpoint implements exactly this): POST JSON
// { log, version, uploadedAt } to LOG_INBOX_UPLOAD_URL, respond 200
// with JSON { id } where id is the stored object's id. The endpoint
// rejects bodies over LOG_INBOX_MAX_BYTES, same as the app does here.
// The endpoint stores the log text as one object named
// logs/<uploadedAt compact>-<random 8>-v<version>.log, so every upload
// is identifiable by version and time from the store listing alone.
// The id is only the stored file's reference: the tester is never
// asked to send or relay it anywhere. Tapping Send is the whole
// action; new uploads are found by listing the store, not by ids
// anyone passes along.

/** Test inbox endpoint. Plain constant, easy to change when the
 * deployment lands. Public by design; no secret is attached to it. */
export const LOG_INBOX_UPLOAD_URL = 'https://airplane-log-inbox.vercel.app/api/upload';

/** Largest log body the endpoint accepts. Matches the endpoint cap. */
export const LOG_INBOX_MAX_BYTES = 2 * 1024 * 1024;

export interface LogInboxUploadInput {
  /** Full redacted diagnostics log text, as read from the log file. */
  logText: string;
  /** Installed app version, e.g. `0.1.21`, or 'unknown'. */
  version: string;
  /** ISO timestamp of the upload, set by the caller. */
  uploadedAt: string;
}

export interface LogInboxUploadPayload {
  log: string;
  version: string;
  uploadedAt: string;
}

export interface LogInboxUploadResult {
  id: string;
  truncated: boolean;
  originalBytes: number;
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
  return {
    payload: { log: cut.text, version: input.version, uploadedAt: input.uploadedAt },
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
 * exists so tests can substitute a fake.
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
  return { id: parsed.id, truncated: build.truncated, originalBytes: build.originalBytes };
}
