// SPDX-License-Identifier: Apache-2.0
// Star event constructors (STAR MVP).
//
// A star is a PUBLIC endorsement, not a bookmark and not a like-heart: a
// signed, tiny interaction event (target post id + starrer pubkey + type +
// signature) that travels over the same transports as public posts
// (Nostr relays + BLE flood). It is kind 4, a NEW kind: old clients ignore
// unknown kinds and post events are untouched.
//
// Undo is a state transition, not a deletion: an "unstar" is a second kind-4
// event from the same pubkey for the same post. Counting applies
// latest-wins (see stars/counter.ts), so an unstar is never undone by a
// late-arriving copy of the original star.
//
// Content vocabulary is deliberately explicit ("star"/"unstar") rather than
// an emoji: an emoji reaction would be counted ambiguously by Nostr-style
// kind-7 counters (report §1), while this kind is ours alone.

import { toHex } from '../hex';
import {
  EVENT_KIND_STAR,
  GEOHASH_PRECISION,
  type EventKind,
  type SignedEvent,
  type UnixSec,
} from '../events/types';
import { type CryptoPort, signEvent } from '../sign/ed25519';
import { PayloadError } from './posts';

/** Content of a kind-4 event that stars its target post. */
export const STAR_CONTENT = 'star';
/** Content of a kind-4 event that cancels the author's star on its target. */
export const UNSTAR_CONTENT = 'unstar';

export interface StarParams {
  crypto: CryptoPort;
  secretKey: Uint8Array;
  pubkey: Uint8Array;
  /** Geohash-5 cell of the TARGET post (stars carry no location of their own). */
  geohash5: string;
  /** 32-byte id of the post being starred/unstarred. */
  postId: Uint8Array;
  createdAt?: UnixSec;
}

function checkStarParams(params: StarParams): void {
  if (params.geohash5.length !== GEOHASH_PRECISION) {
    throw new PayloadError(`geohash must be ${GEOHASH_PRECISION} chars, got "${params.geohash5}"`);
  }
  if (params.postId.length !== 32) throw new PayloadError('postId must be 32 bytes');
}

function buildStar(params: StarParams, content: string): SignedEvent {
  checkStarParams(params);
  return signEvent(params.crypto, params.secretKey, {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
    kind: EVENT_KIND_STAR as EventKind,
    geohash: params.geohash5,
    tags: [['e', toHex(params.postId)]],
    content,
  });
}

/** Create and sign a star (kind=4, content="star", tags=[["e", postIdHex]]). */
export function createStarEvent(params: StarParams): SignedEvent {
  return buildStar(params, STAR_CONTENT);
}

/** Create and sign an unstar (kind=4, content="unstar", tags=[["e", postIdHex]]). */
export function createUnstarEvent(params: StarParams): SignedEvent {
  return buildStar(params, UNSTAR_CONTENT);
}
