// SPDX-License-Identifier: Apache-2.0
// CBOR codec for SignedEvent. Wire layout (8-position array):
//   [id(32B bstr), pubkey(32B bstr), created_at(uint), kind(uint),
//    geohash(tstr), tags(arr of arr of tstr), content(tstr), sig(64B bstr)]
// Canonical pre-image for id/sig (7-position array):
//   [0, pubkey(32B bstr), created_at(uint), kind(uint), geohash(tstr),
//    tags(arr), content(tstr)]
// See docs/spec/wire-format.md - the spec is the source of truth.

import { decode, encode } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  EVENT_KIND_POST,
  EVENT_KIND_RECEIPT,
  EVENT_KIND_STAR,
  EVENT_KIND_RESHARE,
  EVENT_KIND_TOMBSTONE,
  GEOHASH_PRECISION,
  MAX_CONTENT_CHARS,
  MAX_EVENT_BYTES,
  type EventKind,
  type SignedEvent,
  type UnsignedEventFields,
} from '../events/types';

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Thrown when encoded bytes violate the wire-format rules. */
export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

function isEventKind(n: unknown): n is EventKind {
  return (
    n === EVENT_KIND_POST ||
    n === EVENT_KIND_RECEIPT ||
    n === EVENT_KIND_TOMBSTONE ||
    n === EVENT_KIND_STAR ||
    n === EVENT_KIND_RESHARE
  );
}

function validGeohash(g: unknown): g is string {
  if (typeof g !== 'string' || g.length !== GEOHASH_PRECISION) return false;
  for (const ch of g) if (!GEOHASH_ALPHABET.includes(ch)) return false;
  return true;
}

function validTags(t: unknown): t is string[][] {
  if (!Array.isArray(t)) return false;
  // Size caps BEFORE any deeper work: a tag row count or a tag string
  // length far beyond anything a real event carries is rejected here,
  // not after allocation or verification.
  if (t.length > MAX_TAG_ROWS) return false;
  return t.every(
    (row) =>
      Array.isArray(row) &&
      row.every((s) => typeof s === 'string' && s.length <= MAX_TAG_STRING_CHARS),
  );
}

/** Max tag rows on one event (real events carry a handful). */
const MAX_TAG_ROWS = 16;
/**
 * Max chars in one tag string. Set to the whole-event cap, not a small
 * guess: the codebase legitimately pads large events via a long tag
 * string (fragmentation boundary tests), and the 4096-byte total cap
 * already bounds any tag. The pre-check still rejects absurd strings
 * before deeper work.
 */
const MAX_TAG_STRING_CHARS = MAX_EVENT_BYTES;

/**
 * CBOR-encode the canonical pre-image: the 7-position array
 * [0, pubkey, created_at, kind, geohash, tags, content].
 * id and sig are computed over exactly these bytes.
 */
export function canonicalPreimage(fields: UnsignedEventFields): Uint8Array {
  return encode([
    0,
    fields.pubkey,
    fields.created_at,
    fields.kind,
    fields.geohash,
    fields.tags,
    fields.content,
  ]);
}

/** event id = sha256(canonical pre-image). */
export function eventId(fields: UnsignedEventFields): Uint8Array {
  return sha256(canonicalPreimage(fields));
}

/** CBOR-encode a fully-signed event to the 8-position wire array. */
export function encodeEvent(event: SignedEvent): Uint8Array {
  return encode([
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    event.geohash,
    event.tags,
    event.content,
    event.sig,
  ]);
}

/**
 * Decode and validate an encoded event. Throws CodecError on any violation:
 * wrong lengths, unknown kind, bad geohash, oversize content, oversize total.
 */
export function decodeEvent(bytes: Uint8Array): SignedEvent {
  if (bytes.length > MAX_EVENT_BYTES) {
    throw new CodecError(`event too large: ${bytes.length} > ${MAX_EVENT_BYTES} bytes`);
  }
  let arr: unknown;
  try {
    arr = decode(bytes);
  } catch (e) {
    throw new CodecError(`CBOR decode failed: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr) || arr.length !== 8) {
    throw new CodecError(`wire event must be an 8-position array, got ${typeof arr}`);
  }
  const [id, pubkey, created_at, kind, geohash, tags, content, sig] = arr as unknown[];

  if (!(id instanceof Uint8Array) || id.length !== 32) {
    throw new CodecError('id must be a 32-byte bstr');
  }
  if (!(pubkey instanceof Uint8Array) || pubkey.length !== 32) {
    throw new CodecError('pubkey must be a 32-byte bstr');
  }
  if (typeof created_at !== 'number' || !Number.isInteger(created_at) || created_at < 0) {
    throw new CodecError('created_at must be a non-negative integer');
  }
  if (!isEventKind(kind)) {
    throw new CodecError(`kind must be 1, 2, 3, 4 or 5, got ${String(kind)}`);
  }
  if (!validGeohash(geohash)) {
    throw new CodecError(`geohash must be ${GEOHASH_PRECISION} base32 chars, got ${String(geohash)}`);
  }
  if (!validTags(tags)) {
    throw new CodecError('tags must be an array of string arrays');
  }
  if (typeof content !== 'string') {
    throw new CodecError('content must be a string');
  }
  if ([...content].length > MAX_CONTENT_CHARS) {
    throw new CodecError(`content too long: ${[...content].length} > ${MAX_CONTENT_CHARS} chars`);
  }
  if (!(sig instanceof Uint8Array) || sig.length !== 64) {
    throw new CodecError('sig must be a 64-byte bstr');
  }

  // Conservative per-kind shape rules (audit F10): only shapes no valid
  // client produces are rejected here. A kind-1 post must carry content;
  // a kind-2 receipt must not (its payload is its tags); a kind-5
  // reshare must name a valid target post id in its e tag. Tighter
  // shapes (whitespace-only posts, tombstone content, reshare content
  // vocabulary) are deliberately NOT enforced here: valid clients may
  // use them, and the service layers own those rules.
  if (kind === EVENT_KIND_POST && content.length === 0) {
    throw new CodecError('kind 1 post must have content');
  }
  if (kind === EVENT_KIND_RECEIPT && content.length !== 0) {
    throw new CodecError('kind 2 receipt must have empty content');
  }
  if (kind === EVENT_KIND_RESHARE) {
    const target = tags.find((row) => row[0] === 'e')?.[1];
    if (typeof target !== 'string' || !/^[0-9a-fA-F]{64}$/.test(target)) {
      throw new CodecError('kind 5 reshare must carry a valid e tag target');
    }
  }

  return {
    id,
    pubkey,
    created_at,
    kind,
    geohash,
    tags,
    content,
    sig,
  };
}
