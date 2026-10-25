// SPDX-License-Identifier: Apache-2.0
// Reshare events (kind=5): TINY REFERENCE events, never a copy of the post.
//
// A reshare carries only: the ORIGINAL post id (tag "e"), the original
// author's pubkey (tag "p"), the resharer's pubkey (the event's own pubkey),
// a signature, and an independent TTL. It deliberately does NOT copy Nostr
// kind 6's embedded-original-JSON pattern: re-flooding post content on every
// reshare would multiply mesh bandwidth by the reshare count (see the
// reshare research report §7). A reshare never refreshes the original post's
// TTL; its own TTL is independent and defaults to DEFAULT_TTL (7 hops).
//
// Flattening: resharing a reshare card reshares the ORIGINAL post.
// `flattenReshareTarget` resolves any event to the post id a reshare of it
// must target: a reshare event resolves to its own "e" tag, anything else
// resolves to its own id. Counting keys ONLY on the original post id; the
// intermediate card id may be carried as a "via" tag for attribution only
// (cf. ATProto's `via` field) and is never a counting key.
//
// Undo: an unreshare is a second kind-5 event from the same pubkey for the
// same original post with content "undo" (a reshare has content ""). The
// counting layer (reshares/counting.ts) applies latest-wins over
// (created_at, event id) and retains superseded events, so an old reshare
// arriving after its unreshare can never resurrect the count.
//
// Authorship: the event pubkey is the RESHARER. The original author is
// referenced via the "p" tag, never overwritten. Rendering only the event
// pubkey as the author is a bug: render "resharer reshared [original
// author]'s post" semantics from the cluster attribution instead.
//
// Quote-with-comment is NOT in scope: plain reshare only.

import { fromHex, toHex } from '../hex';
import {
  EVENT_KIND_RESHARE,
  GEOHASH_PRECISION,
  type EventKind,
  type Hex64,
  type SignedEvent,
  type UnixSec,
} from '../events/types';
import { type CryptoPort, signEvent } from '../sign/ed25519';
import { PayloadError } from './posts';

/** Content of a reshare event: "" (active reshare). */
export const RESHARE_CONTENT = '';
/** Content of an unreshare event: "undo" (supersedes the resharer’s reshare). */
export const UNRESHARE_CONTENT = 'undo';

export interface ReshareParams {
  crypto: CryptoPort;
  secretKey: Uint8Array;
  pubkey: Uint8Array;
  /** Geohash cell at precision 5. Callers reuse the original post's cell. */
  geohash5: string;
  /** 32-byte id of the ORIGINAL post being reshared (already flattened). */
  originalPostId: Uint8Array;
  /** 32-byte pubkey of the ORIGINAL post's author. */
  originalAuthorPubkey: Uint8Array;
  /**
   * Optional id of the intermediate card the reshare was tapped on
   * (e.g. a reshare card). Attribution only — never a counting key.
   */
  viaPostId?: Uint8Array;
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

function reshareTags(params: ReshareParams): string[][] {
  const tags: string[][] = [
    ['e', toHex(params.originalPostId)],
    ['p', toHex(params.originalAuthorPubkey)],
  ];
  if (params.viaPostId) tags.push(['via', toHex(params.viaPostId)]);
  return tags;
}

function buildReshare(params: ReshareParams, content: string): SignedEvent {
  checkGeohash5(params.geohash5);
  if (params.originalPostId.length !== 32) {
    throw new PayloadError('originalPostId must be 32 bytes');
  }
  if (params.originalAuthorPubkey.length !== 32) {
    throw new PayloadError('originalAuthorPubkey must be 32 bytes');
  }
  if (params.viaPostId && params.viaPostId.length !== 32) {
    throw new PayloadError('viaPostId must be 32 bytes');
  }
  return signEvent(params.crypto, params.secretKey, {
    pubkey: params.pubkey,
    created_at: params.createdAt ?? nowSec(),
    kind: EVENT_KIND_RESHARE as EventKind,
    geohash: params.geohash5,
    tags: reshareTags(params),
    content,
  });
}

/**
 * Create and sign a reshare (kind=5, content=""). The event carries NO post
 * content: only the original post id, the original author's pubkey, and the
 * resharer's pubkey + signature.
 */
export function createReshare(params: ReshareParams): SignedEvent {
  return buildReshare(params, RESHARE_CONTENT);
}

/**
 * Create and sign an unreshare (kind=5, content="undo"). Same target and
 * author tags as the reshare it supersedes; counting applies latest-wins.
 */
export function createUnreshare(params: ReshareParams): SignedEvent {
  return buildReshare(params, UNRESHARE_CONTENT);
}

/** First value of tag `name` on the event, or undefined. */
export function tagValue(event: SignedEvent, name: string): string | undefined {
  for (const row of event.tags) {
    if (row[0] === name && row.length >= 2) return row[1];
  }
  return undefined;
}

/** Original post id (hex) this reshare targets, from its "e" tag. */
export function reshareTargetId(event: SignedEvent): Hex64 | undefined {
  const v = tagValue(event, 'e');
  return v !== undefined && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
}

/** Original author's pubkey (hex) this reshare references, from its "p" tag. */
export function reshareOriginalAuthor(event: SignedEvent): Hex64 | undefined {
  const v = tagValue(event, 'p');
  return v !== undefined && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
}

/** Intermediate card id (hex) this reshare was tapped on, if any. Attribution only. */
export function reshareViaId(event: SignedEvent): Hex64 | undefined {
  const v = tagValue(event, 'via');
  return v !== undefined && /^[0-9a-f]{64}$/.test(v) ? v : undefined;
}

/** True when the event is an unreshare (content "undo"); false for a reshare. */
export function isUnreshare(event: SignedEvent): boolean {
  return event.content === UNRESHARE_CONTENT;
}

/**
 * Flatten rule: the post id a reshare OF this event must target.
 * A reshare event resolves to its own original ("e" tag); any other event
 * resolves to its own id. A reshare event with a malformed/missing "e" tag
 * resolves to undefined (callers must reject it, never count it).
 */
export function flattenReshareTarget(event: SignedEvent): Hex64 | undefined {
  if (event.kind === EVENT_KIND_RESHARE) return reshareTargetId(event);
  return toHex(event.id);
}

/**
 * Build reshare params for "reshare this card", flattening reshare-of-reshare
 * to the original: pass the tapped card's event; the target becomes the
 * original post id and the tapped card's id becomes the "via" tag (only when
 * the tapped card is itself a reshare — for a plain post card, via is the
 * post itself and is omitted as redundant).
 */
export function flattenParamsForCard(
  base: Omit<ReshareParams, 'originalPostId' | 'originalAuthorPubkey' | 'viaPostId'>,
  cardEvent: SignedEvent,
  originalAuthorPubkey: Uint8Array,
): ReshareParams | undefined {
  const target = flattenReshareTarget(cardEvent);
  if (target === undefined) return undefined;
  const via =
    cardEvent.kind === EVENT_KIND_RESHARE ? cardEvent.id : undefined;
  return {
    ...base,
    originalPostId: fromHex(target),
    originalAuthorPubkey,
    viaPostId: via,
  };
}
