// SPDX-License-Identifier: Apache-2.0
// User-safe error copy for the route ErrorBoundary (audit F36).
//
// Raw error messages must never reach the user: a future error could
// carry a SQLite message, a file path, or a hex value. Known failure
// classes map to friendly copy; everything else gets one generic line.
// The raw error goes to the console only (device-local, never rendered).

/** Map any thrown value to copy that is safe to render on screen. */
export function friendlyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/permission/i.test(message)) {
    return 'A needed permission is missing. Check Settings and try again.';
  }
  if (/network|fetch|timeout|offline|connection/i.test(message)) {
    return 'Something went wrong while loading. Check your connection and try again.';
  }
  if (/storage|database|sqlite|disk/i.test(message)) {
    return 'Saved data could not be read. Try again.';
  }
  return 'Something went wrong. Try again.';
}
