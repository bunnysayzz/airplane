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
 * Build the upload payload. Throws on an empty log or an over-cap log
 * so a useless or rejected upload never leaves the phone.
 */
export function buildLogInboxPayload(input: LogInboxUploadInput): LogInboxUploadPayload {
  if (input.logText.length === 0) {
    throw new Error('log is empty');
  }
  if (logTextByteLength(input.logText) > LOG_INBOX_MAX_BYTES) {
    throw new Error('log too large');
  }
  return { log: input.logText, version: input.version, uploadedAt: input.uploadedAt };
}

/** Parse the endpoint response. Throws unless it carries a non-empty id. */
export function parseLogInboxResponse(body: unknown): LogInboxUploadResult {
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
  const payload = buildLogInboxPayload(input);
  const response = await fetchFn(LOG_INBOX_UPLOAD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status}`);
  }
  return parseLogInboxResponse(await response.json());
}
