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
 * Also enforced, mirroring the package validator: no embedded credentials,
 * a sane host (domain or IP literal, no underscores), a sane port
 * (1-65535, default 443 dropped), and a canonical lowercase host so
 * case and port variants of one relay dedupe. Private targets ARE allowed
 * here: this list is explicitly user-added in Settings, and the package
 * layer's private-target drop applies to non-explicit callers.
 * Length-capped (audit F40): an unbounded URL must not reach the socket
 * layer or the stored list.
 */
export const MAX_RELAY_URL_CHARS = 256;
/** Max relays in one list (audit F40): each entry opens a socket. */
export const MAX_RELAYS = 10;

export function normalizeRelayUrl(input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  if (trimmed.length > MAX_RELAY_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.includes('_') || host.length > 253) return null;
  if (!host.includes(':')) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      if (
        !host.split('.').every((p) => {
          const n = Number(p);
          return Number.isInteger(n) && n >= 0 && n <= 255 && p === String(n);
        })
      ) {
        return null;
      }
    } else if (
      !host.split('.').every((label) => {
        return label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label);
      })
    ) {
      return null;
    }
  }
  const authority = trimmed.slice('wss://'.length).split('/')[0];
  const hostport = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  let portText = '';
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close === -1) return null;
    const rest = hostport.slice(close + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
    else if (rest !== '') return null;
  } else if (hostport.includes(':')) {
    portText = hostport.slice(hostport.lastIndexOf(':') + 1);
  }
  let portSuffix = '';
  if (portText !== '') {
    if (!/^\d+$/.test(portText)) return null;
    const port = Number(portText);
    if (port < 1 || port > 65535) return null;
    if (port !== 443) portSuffix = `:${port}`;
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `wss://${host}${portSuffix}${path}`;
}

/** Dedupe (preserving first-seen order) and drop invalid entries. Capped at MAX_RELAYS. */
export function sanitizeRelayList(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw);
    if (url !== null && !seen.has(url)) {
      seen.add(url);
      out.push(url);
      if (out.length >= MAX_RELAYS) break;
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
  if (url === null) return null;
  // Compare canonical forms: a case or default-port variant of an
  // existing relay is a duplicate, not a new entry.
  if (current.some((c) => normalizeRelayUrl(c) === url)) return null;
  if (current.length >= MAX_RELAYS) return null;
  return [...current, url];
}

/** Remove one relay from a list (no-op when absent). Does not persist. */
export function removeRelayUrl(current: readonly string[], url: string): string[] {
  return current.filter((u) => u !== url);
}
