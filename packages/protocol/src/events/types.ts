// SPDX-License-Identifier: Apache-2.0
// Core protocol types and frozen constants (SYSTEM_DESIGN §3).
// Source of truth for values: docs/spec/wire-format.md and docs/spec/flood.md.

/** Protocol version. Bump only with an ADR; receivers reject unknown versions. */
export const PROTO_VER = 1;

/** Event kinds. */
export const EVENT_KIND_POST = 1;
export const EVENT_KIND_RECEIPT = 2;
export const EVENT_KIND_TOMBSTONE = 3;
/** STAR MVP: public endorsement interaction (new kind; old clients ignore it). */
export const EVENT_KIND_STAR = 4;
/** Tiny reference event: reshare/unreshare of an original post (see payloads/reshares.ts). */
export const EVENT_KIND_RESHARE = 5;

/** Default flood TTL (hops). */
export const DEFAULT_TTL = 7;

/** Flood relay jitter window, milliseconds (uniform). */
export const FLOOD_JITTER_MS_MIN = 50;
export const FLOOD_JITTER_MS_MAX = 500;

/** Seen-cache LRU capacity (event ids). */
export const SEEN_LRU_CAP = 10000;

/** Max post content length, in Unicode characters (after NFC normalization). */
export const MAX_CONTENT_CHARS = 280;

/** Max CBOR-encoded event size in bytes. */
export const MAX_EVENT_BYTES = 4096;

/** Geohash precision used for scoping (5 chars ≈ 4.9km × 4.9km cell). */
export const GEOHASH_PRECISION = 5;

/** View-receipt dedup day bucket, seconds. */
export const RECEIPT_DAY_BUCKET_S = 86400;

/** Ranking gravity exponent. score = log10(1+views) / (ageHours+2)^gravity */
export const RANK_GRAVITY = 1.5;

/** Max BLE wire frame size in bytes. */
export const FRAG_WIRE_MAX = 469;

/** Fragment header length in bytes. */
export const FRAG_HEADER_LEN = 11;

/** Max event payload carried per fragment. */
export const FRAG_PAYLOAD_MAX = FRAG_WIRE_MAX - FRAG_HEADER_LEN; // 458

/** Fragment header magic byte. */
export const FRAG_MAGIC = 0xa1;

/** Incomplete reassembly buffers are dropped after this many ms. */
export const REASSEMBLY_TIMEOUT_MS = 30000;

/** 64-char lowercase hex string (32 bytes). */
export type Hex64 = string;

/** Seconds since Unix epoch (integer). */
export type UnixSec = number;

/** Event kind discriminant. */
export type EventKind = 1 | 2 | 3 | 4 | 5;

/**
 * A signed protocol event. Wire encoding is the 8-position CBOR array:
 * [id(32B), pubkey(32B), created_at, kind, geohash, tags, content, sig(64B)]
 * See docs/spec/wire-format.md.
 */
export interface SignedEvent {
  /** sha256 of the canonical pre-image; 32 bytes. */
  id: Uint8Array;
  /** ed25519 public key of the author; 32 bytes. */
  pubkey: Uint8Array;
  /** Creation time, seconds since epoch. */
  created_at: UnixSec;
  /** 1 = post, 2 = view receipt, 3 = tombstone, 4 = star/unstar, 5 = reshare/unreshare. */
  kind: EventKind;
  /** Geohash cell at precision 5. */
  geohash: string;
  /** Nostr-style tags, e.g. [["e", postIdHex]] for receipts/tombstones. */
  tags: string[][];
  /** UTF-8 content; NFC-normalized; 1..280 chars for posts, "" for receipts. */
  content: string;
  /** ed25519 signature over `id`; 64 bytes. */
  sig: Uint8Array;
}

/** Fields needed to construct (and sign) an event, before id/sig exist. */
export interface UnsignedEventFields {
  pubkey: Uint8Array;
  created_at: UnixSec;
  kind: EventKind;
  geohash: string;
  tags: string[][];
  content: string;
}

/** A post with its ranked view count, as shown in the feed. */
export interface FeedPost {
  event: SignedEvent;
  /** Deduplicated view-receipt count. */
  views: number;
  /** Ranking score; higher sorts first. */
  score: number;
  /** Age in hours at ranking time. */
  ageHours: number;
}

/** A BLE-discovered peer. */
export interface PeerInfo {
  peerId: string;
  /** Received signal strength, dBm (when available). */
  rssi?: number;
  /** Last-seen time, seconds since epoch. */
  lastSeenSec?: UnixSec;
}
