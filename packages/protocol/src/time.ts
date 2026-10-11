// SPDX-License-Identifier: Apache-2.0
// Relative time formatting for feed timestamps.

export function formatPostTime(timestampMs: number): string {
  const now = Date.now();
  const diff = now - timestampMs;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

export function isRecentPost(timestampMs: number, windowHours: number = 24): boolean {
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
  return timestampMs >= cutoff;
}
