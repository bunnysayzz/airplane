// SPDX-License-Identifier: Apache-2.0
// User-chosen display names, layered on top of the memorable names in
// names.ts (wordlists untouched, mapping stable).
//
// SIGNED CLAIM, NO NEW WIRE FORMAT: a display name travels on a kind-1
// post as a ["display_name", name] tag. Post tags are part of the
// canonical pre-image (protocol codec/cbor.ts), so the tag is covered by
// the author's ed25519 signature over the event id, exactly like the post
// body. An older install decodes the event fine (decodeEvent accepts any
// tag rows within the size caps, and kind-1 only requires non-empty
// content) and simply ignores the unknown tag, so this is backwards
// compatible with no version bump and no new event kind. A display name
// is only ever learned from a post tag, never from an unsigned source,
// and a post without the tag never overwrites a known name: clearing a
// name locally stops future posts carrying it, but already published
// posts (and peers that recorded them) keep the old signed claim, the
// same way a published post itself cannot be retracted.
//
// DM LIMIT, STATED PLAINLY: there is no central directory and no relay
// lookup is invented here, so a username only resolves against peers
// this device already knows: authors of posts it has seen (their signed
// tags, recorded in the registry below) plus inbox, request, and blocked
// contacts. A peer this device has never seen cannot be found by name;
// paste-a-hex stays as the fallback for that case. Nearby BLE sightings
// are not candidates either: a BLE peer id is a radio address or tag,
// not a mesh pubkey, so it cannot address a DM until that peer posts
// or messages first.
//
// PRIVACY: display names and the registry are public-by-design data (the
// names ride on public posts). They live in KV, never in the keystore,
// and no display name, post text, or key is ever logged from here.

import { fromHex, type SignedEvent } from '@airplane/protocol';
import { authorLabelFor, memorableNameFor, nameWithoutSuffix } from './names';
import { getKv } from './kv';

/** Post tag key carrying a signed display name claim. */
export const DISPLAY_NAME_TAG = 'display_name';

/** Max display name length, in Unicode characters. */
export const DISPLAY_NAME_MAX_CHARS = 32;

/** KV key for this device's own chosen display name. */
export const OWN_DISPLAY_NAME_KV_KEY = 'airplane.displayName.v1';

/** KV key for the peer display name registry (JSON object hex to name). */
export const PEER_DISPLAY_NAMES_KV_KEY = 'airplane.peerDisplayNames.v1';

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Normalize a raw display name, or null when it is empty or invalid.
 * NFC-normalized, trimmed, internal whitespace collapsed to single
 * spaces, 1 to 32 characters, no control characters. A name that fails
 * here is never stored and never put on a post.
 */
export function normalizeDisplayName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const collapsed = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (collapsed.length === 0) return null;
  if ([...collapsed].length > DISPLAY_NAME_MAX_CHARS) return null;
  for (const ch of collapsed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return collapsed;
}

/** First valid display name claim in a tag list, or null when none. */
export function displayNameFromTags(tags: string[][] | undefined | null): string | null {
  if (!tags) return null;
  for (const row of tags) {
    if (row[0] === DISPLAY_NAME_TAG && row.length >= 2) {
      const name = normalizeDisplayName(row[1]);
      if (name !== null) return name;
    }
  }
  return null;
}

/** Display name claim carried by a signed event, or null when none. */
export function displayNameFromEvent(event: SignedEvent): string | null {
  return displayNameFromTags(event.tags);
}

function isHex64(value: string): boolean {
  return HEX64_RE.test(value);
}

function pubkeyBytes(pubkeyHex: string): Uint8Array | null {
  const hex = pubkeyHex.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const bytes = fromHex(hex);
  return bytes && bytes.length === 32 ? bytes : null;
}

/** Memorable name (no suffix) for a hex pubkey, or null for bad hex. */
export function memorableNameForHex(pubkeyHex: string): string | null {
  const bytes = pubkeyBytes(pubkeyHex);
  return bytes ? memorableNameFor(bytes) : null;
}

/** Full label (memorable plus suffix) for a hex pubkey, or null. */
export function fullLabelForHex(pubkeyHex: string): string | null {
  const bytes = pubkeyBytes(pubkeyHex);
  return bytes ? authorLabelFor(bytes) : null;
}

// --- peer registry ---------------------------------------------------------
// In-memory map of lowercase pubkey hex to signed display name. Hydrated
// from KV on first async use so names survive restarts; feed mapping
// records names synchronously as posts arrive, so the map is fresh
// within a session even before hydration completes.

const registry = new Map<string, string>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/** Hydrate the registry from KV. Never throws: KV failure means no names. */
export function hydratePeerDisplayNames(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const raw = await getKv().get(PEER_DISPLAY_NAMES_KV_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [hex, name] of Object.entries(parsed as Record<string, unknown>)) {
            if (isHex64(hex) && typeof name === 'string') {
              const normalized = normalizeDisplayName(name);
              if (normalized !== null && !registry.has(hex)) registry.set(hex, normalized);
            }
          }
        }
      }
    } catch {
      // No registry is a display fallback, never a posting or DM failure.
    } finally {
      hydrated = true;
    }
  })();
  return hydratePromise;
}

function persistRegistry(): void {
  try {
    const json = JSON.stringify(Object.fromEntries(registry));
    void getKv()
      .set(PEER_DISPLAY_NAMES_KV_KEY, json)
      .catch(() => {});
  } catch {
    // Persistence is best effort; the in-memory map still serves the session.
  }
}

/**
 * Record a signed display name for a peer. Only a valid name records;
 * a null or invalid name never erases a known name (see header note).
 */
export function recordPeerDisplayName(pubkeyHex: string, displayName: string | null): void {
  const hex = pubkeyHex.toLowerCase();
  if (!isHex64(hex) || displayName === null) return;
  const normalized = normalizeDisplayName(displayName);
  if (normalized === null) return;
  if (registry.get(hex) !== normalized) {
    registry.set(hex, normalized);
    persistRegistry();
  }
}

/** Record the display name claim carried by a post's tags, if any. */
export function recordDisplayNameFromTags(pubkeyHex: string, tags: string[][]): void {
  recordPeerDisplayName(pubkeyHex, displayNameFromTags(tags));
}

/** Display name this device knows for a peer, or null when unknown. */
export function knownDisplayName(pubkeyHex: string): string | null {
  return registry.get(pubkeyHex.toLowerCase()) ?? null;
}

/** Pubkey hexes with a recorded display name (registry snapshot). */
export function knownPeerHexes(): string[] {
  return [...registry.keys()];
}

/**
 * Base display string for a peer: signed display name when known, else
 * the memorable name without suffix. Never includes a hex suffix.
 */
export function peerBaseName(pubkeyHex: string): string {
  const hex = pubkeyHex.toLowerCase();
  const known = registry.get(hex);
  if (known !== undefined) return known;
  return memorableNameForHex(hex) ?? 'anon';
}

/**
 * Collision-aware display string for one peer. The hex suffix appears
 * ONLY when another known peer (from the registry, or from
 * `extraPeerHexes` when the caller knows more peers than the registry)
 * shares the same base name, case-insensitively. Otherwise the name
 * stands alone. Avatar gradients differ per pubkey regardless, so two
 * same-name peers still look different even before the suffix rule fires
 * on a peer the registry has not seen yet.
 */
export function formatPeerName(pubkeyHex: string, extraPeerHexes: string[] = []): string {
  const hex = pubkeyHex.toLowerCase();
  const base = peerBaseName(hex);
  const baseLower = base.toLowerCase();
  const others = new Set<string>();
  for (const candidate of [...registry.keys(), ...extraPeerHexes]) {
    const candidateHex = candidate.toLowerCase();
    if (candidateHex !== hex && isHex64(candidateHex)) others.add(candidateHex);
  }
  for (const other of others) {
    if (peerBaseName(other).toLowerCase() === baseLower) {
      return `${base}·${hex.slice(0, 4)}`;
    }
  }
  return base;
}

/** Collision-aware display strings for a whole peer set at once. */
export function resolvePeerNames(peerHexes: string[]): Map<string, string> {
  const normalized = peerHexes.map((hex) => hex.toLowerCase());
  const out = new Map<string, string>();
  for (const hex of normalized) {
    out.set(hex, formatPeerName(hex, normalized));
  }
  return out;
}

export interface KnownPeerMatch {
  /** Lowercase pubkey hex of the matched peer. */
  pubkeyHex: string;
  /** Collision-aware display string for the peer. */
  name: string;
}

/**
 * Resolve a typed username against known peers only (see header note).
 * Matches when the query, case-insensitively, is contained in the peer's
 * display name or in its memorable name, so a peer is still findable by
 * its memorable name after it sets a display name. Exact base matches
 * sort first, then prefix matches, then substring matches. An empty
 * query matches nothing, never the whole directory.
 */
export function matchKnownPeers(query: string, candidateHexes: string[]): KnownPeerMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const seen = new Set<string>();
  const scored: Array<{ match: KnownPeerMatch; score: number }> = [];
  for (const rawHex of candidateHexes) {
    const hex = rawHex.toLowerCase();
    if (!isHex64(hex) || seen.has(hex)) continue;
    seen.add(hex);
    const base = peerBaseName(hex);
    const memorable = memorableNameForHex(hex) ?? '';
    const baseLower = base.toLowerCase();
    const memorableLower = memorable.toLowerCase();
    let score: number | null = null;
    if (baseLower === needle) score = 0;
    else if (baseLower.startsWith(needle)) score = 1;
    else if (memorableLower.startsWith(needle)) score = 2;
    else if (baseLower.includes(needle) || memorableLower.includes(needle)) score = 3;
    if (score !== null) {
      scored.push({ match: { pubkeyHex: hex, name: formatPeerName(hex, candidateHexes) }, score });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.match.name.localeCompare(b.match.name));
  return scored.map((entry) => entry.match);
}

// --- own display name ------------------------------------------------------

/** This device's chosen display name, or null when none is set. */
export async function getOwnDisplayName(): Promise<string | null> {
  try {
    return normalizeDisplayName(await getKv().get(OWN_DISPLAY_NAME_KV_KEY));
  } catch {
    return null;
  }
}

/**
 * Set this device's display name. An empty value clears it. A non-empty
 * invalid value throws: callers validate before saving, and a bad name
 * must never silently become no name. The name only reaches other phones
 * on the next post, which carries it as a signed tag.
 */
export async function setOwnDisplayName(raw: string): Promise<string | null> {
  if (raw.trim().length === 0) {
    await getKv().del(OWN_DISPLAY_NAME_KV_KEY);
    return null;
  }
  const normalized = normalizeDisplayName(raw);
  if (normalized === null) throw new Error('invalid display name');
  await getKv().set(OWN_DISPLAY_NAME_KV_KEY, normalized);
  return normalized;
}

// --- deterministic avatars -------------------------------------------------
// Pure function of the pubkey, so a peer's avatar is identical on every
// device that has seen them, with no image download and no new dependency.
// Hue comes from the first two pubkey bytes (16 bits of hue space); the
// second stop sits 45 degrees around the wheel, so every avatar is a
// two-stop gradient, not a flat circle, and distinct keys almost always
// land on distinct gradients. Initials come from the display string at
// the call site (Avatar initialsOf), not from here.

/** Two-stop gradient colors for a pubkey, or null for bad hex. */
export function avatarGradientFor(pubkeyHex: string): [string, string] | null {
  const bytes = pubkeyBytes(pubkeyHex);
  if (!bytes) return null;
  const hue = ((bytes[0] * 256 + bytes[1]) % 360 + 360) % 360;
  const hue2 = (hue + 45) % 360;
  return [`hsl(${hue}, 72%, 52%)`, `hsl(${hue2}, 72%, 42%)`];
}

export { nameWithoutSuffix };

/** Test seam: drop the in-memory registry and hydration state. */
export function __resetDisplayNamesForTests(): void {
  registry.clear();
  hydrated = false;
  hydratePromise = null;
}
