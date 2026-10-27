// SPDX-License-Identifier: Apache-2.0
// Nostr relay list configuration (T7).
//
// The app's World uplink (Nostr) used to take a hardcoded relay list in
// services/airplane/transport.ts. That list now lives here as the default,
// and the user can replace it from Settings > Relays. The configured list
// is persisted with the app's existing settings storage (AsyncStorage via
// src/lib/storage.ts) — no new mechanism.
//
// Storage contract: the key holds a JSON array of relay URLs, or nothing.
//   - Key absent (fresh install, or after reset) => defaults, NOT an empty list.
//   - Key present, even as `[]` => exactly that list (removing every relay
//     is a deliberate user choice: the World uplink simply has nowhere to go).
// Corrupt or non-array payloads fall back to defaults rather than bricking
// the uplink; individual invalid entries are dropped, duplicates removed.

import { getStringSetting, saveStringSetting, removeSetting } from './storage';

export const RELAYS_KEY = 'airplane_settings_relays';

/**
 * Default public relays. This is exactly the list startTransport() used
 * before configurability, so an uncustomized install behaves identically.
 * (The transport package's DEFAULT_RELAYS additionally lists
 * wss://relay.primal.net; the app never used it, so it is NOT added here
 * — adding a relay is a product decision, not a side effect of this change.)
 */
export const DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

/**
 * Normalize one user-entered relay URL, or null when it is not a usable
 * relay address. Only secure WebSockets are accepted: a ws:// relay would
 * send wrapped (still signed) posts in the clear over the local network path.
 * Trailing slashes are stripped so the same relay entered two ways dedupes.
 */
export function normalizeRelayUrl(input: string): string | null {
  const url = input.trim().replace(/\/+$/, '');
  if (!url.startsWith('wss://')) return null;
  if (url.length <= 'wss://'.length) return null;
  // Reject anything with whitespace or a second scheme-looking fragment.
  if (/\s/.test(url)) return null;
  return url;
}

/** Dedupe (preserving first-seen order) and drop invalid entries. */
export function sanitizeRelayList(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw);
    if (url !== null && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

/**
 * Parse a stored payload. Returns null when nothing was ever stored
 * (caller falls back to DEFAULT_RELAYS); returns the sanitized list —
 * possibly empty — when a payload exists, even if every entry was invalid.
 * A corrupt payload also returns null (defaults), never throws.
 */
export function parseStoredRelays(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return sanitizeRelayList(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return null;
  }
}

/**
 * The persisted custom list, or null when the user has not customized
 * anything. Never throws: storage failures read as "not customized".
 */
export async function loadStoredRelays(): Promise<string[] | null> {
  try {
    const raw = await getStringSetting(RELAYS_KEY, '');
    // getStringSetting returns the default ('') when the key is absent, and
    // AsyncStorage returns null for a missing key — both mean "no payload".
    // An explicitly stored empty string is treated the same (never written
    // by saveRelayUrls, which always writes a JSON array).
    if (raw === '') return null;
    return parseStoredRelays(raw);
  } catch {
    return null;
  }
}

/** Effective relay list: the stored custom list, or the defaults. */
export async function loadRelayUrls(): Promise<string[]> {
  return (await loadStoredRelays()) ?? [...DEFAULT_RELAYS];
}

/** Persist a custom list (already sanitized; invalid entries dropped). */
export async function saveRelayUrls(urls: readonly string[]): Promise<string[]> {
  const clean = sanitizeRelayList(urls);
  await saveStringSetting(RELAYS_KEY, JSON.stringify(clean));
  return clean;
}

/** Forget the custom list; the next load returns the defaults. */
export async function resetRelayUrls(): Promise<void> {
  await removeSetting(RELAYS_KEY);
}

/**
 * Add one relay to a list. Returns the new list, or null when the input
 * is invalid or already present (so the UI can show an error instead of
 * silently doing nothing). Does not persist — callers persist via
 * saveRelayUrls so the Settings UI can batch add+save in one step.
 */
export function addRelayUrl(current: readonly string[], input: string): string[] | null {
  const url = normalizeRelayUrl(input);
  if (url === null || current.includes(url)) return null;
  return [...current, url];
}

/** Remove one relay from a list (no-op when absent). Does not persist. */
export function removeRelayUrl(current: readonly string[], url: string): string[] {
  return current.filter((u) => u !== url);
}
