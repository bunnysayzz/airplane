// SPDX-License-Identifier: Apache-2.0
// Event constructors: posts, view receipts, tombstones.
// Content is NFC-normalized; posts must be 1..280 chars.

import { toHex } from '../hex';
import {
  EVENT_KIND_POST,
  EVENT_KIND_RECEIPT,
  EVENT_KIND_TOMBSTONE,
  GEOHASH_PRECISION,
  MAX_CONTENT_CHARS,
  type EventKind,
  type SignedEvent,
  type UnixSec,
} from '../events/types';
import { type CryptoPort, signEvent } from '../sign/ed25519';

/** Thrown when payload fields violate the protocol rules. */
export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

export interface PostParams {
  crypto: CryptoPort;
  secretKey: Uint8Array;
  pubkey: Uint8Array;
  /** Geohash cell at precision 5 (see geo/geohash). */
  geohash5: string;
  content: string;
  createdAt?: UnixSec;
}

export interface ReceiptParams {
  crypto: CryptoPort;
  secretKey: Uint8Array;
  pubkey: Uint8Array;
  geohash5: string;
  /** 32-byte id of the post being viewed. */
  postId: Uint8Array;
  createdAt?: UnixSec;
}

export interface TombstoneParams {
  crypto: CryptoPort;
  secretKey: Uint8Array;
  pubkey: Uint8Array;
  geohash5: string;
  /** 32-byte id of the post being deleted. */
  postId: Uint8Array;
  createdAt?: UnixSec;
}

function checkGeohash5(geohash5: string): void {
  if (geohash5.length !== GEOHASH_PRECISION) {
    throw new PayloadError(`geohash must be ${GEOHASH_PRECISION} chars, got "${geohash5}"`);
  }
}

function nowSec(): UnixSec {
  return Math.floor(Date.now() / 1000);
}

/** Normalize + validate post content. Returns NFC-normalized text. */
export function normalizeContent(content: string): string {
  const normalized = content.normalize('NFC');
  const chars = [...normalized].length;
  if (chars < 1) throw new PayloadError('content must not be empty');
  if (chars > MAX_CONTENT_CHARS) {
    throw new PayloadError(`content too long: ${chars} > ${MAX_CONTENT_CHARS} chars`);
  }
  return normalized;
}

/** Create and sign a feed post (kind=1, tags=[]). */
export function createPost(params: PostParams): SignedEvent {
  checkGeohash5(params.geohash5);
  const content = normalizeContent(params.content);
  return signEvent(params.crypto, params.secretKey, {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? nowSec(),
    kind: EVENT_KIND_POST as EventKind,
    geohash: params.geohash5,
    tags: [],
    content,
  });
}

/**
 * Create and sign a view receipt (kind=2, content="", tags=[["e", postIdHex]]).
 * Counting/dedup policy lives in receipts/dedup.ts.
 */
export function createViewReceipt(params: ReceiptParams): SignedEvent {
  checkGeohash5(params.geohash5);
  if (params.postId.length !== 32) throw new PayloadError('postId must be 32 bytes');
  return signEvent(params.crypto, params.secretKey, {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? nowSec(),
    kind: EVENT_KIND_RECEIPT as EventKind,
    geohash: params.geohash5,
    tags: [['e', toHex(params.postId)]],
    content: '',
  });
}

/**
 * Create and sign a tombstone (kind=3, content="", tags=[["e", postIdHex]]).
 * Only the original author can delete their own post; the app layer enforces
 * that the tombstone's pubkey matches the post's pubkey.
 */
export function createTombstone(params: TombstoneParams): SignedEvent {
  checkGeohash5(params.geohash5);
  if (params.postId.length !== 32) throw new PayloadError('postId must be 32 bytes');
  return signEvent(params.crypto, params.secretKey, {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? nowSec(),
    kind: EVENT_KIND_TOMBSTONE as EventKind,
    geohash: params.geohash5,
    tags: [['e', toHex(params.postId)]],
    content: '',
  });
}
