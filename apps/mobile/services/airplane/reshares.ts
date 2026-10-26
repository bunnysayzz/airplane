// SPDX-License-Identifier: Apache-2.0
// Reshare registry: session-local ReshareCounter + toggle action for cards.
//
// --- RESHARE (delimited block: start) ---
// The counter is the protocol layer's ReshareCounter (one counted reshare
// per pubkey per ORIGINAL post, latest-wins undo, pending-until-post-known,
// verify-before-count). This module owns one process-wide instance so the
// feed and post-detail screens read the same cluster state, and exposes the
// toggle the reshare button calls. The event is also saved to the store
// (kind-agnostic saveEvent) for relay/dedup integrity; the reshare's own
// flood/Nostr delivery and cross-restart rehydration of counts from stored
// kind-5 events are follow-ups (see REPORT), not part of this patch.
//
// Counts shown here are partial lower bounds ("seen by this device"), never
// global totals. Ranking is untouched: reshares are display-only.
// --- RESHARE (delimited block: end) ---

import {
  EVENT_KIND_RESHARE,
  RESHARE_CONTENT,
  ReshareCounter,
  UNRESHARE_CONTENT,
  fromHex,
  toHex,
  verifyEvent,
  type EventKind,
  type ReshareCluster,
} from '@airplane/protocol';
import { getDevicePublicKey, signDeviceEvent, crypto } from './identity';
import { getStore } from './store';
import { authorLabelFor } from './names';
import type { PostCardModel } from './types';

const counter = new ReshareCounter();

/** Record an inbound reshare/unreshare event (BLE or Nostr leg). */
export function recordReshareEvent(
  event: Parameters<ReshareCounter['add']>[0],
): ReturnType<ReshareCounter['add']> {
  return counter.add(event, (e) => verifyEvent(crypto, e));
}

/** Mark an original post as known so its pending reshares apply. */
export function markResharePostKnown(postIdHex: string): void {
  counter.markPostKnown(postIdHex);
}

/** Collapsed cluster for one original post (count + latest resharer). */
export function getReshareCluster(postIdHex: string): ReshareCluster {
  return counter.cluster(postIdHex);
}

/** Memorable anonymous label for a resharer pubkey hex (same derivation as feed author labels). */
export function resharerLabelFor(pubkeyHex: string): string {
  return authorLabelFor(fromHex(pubkeyHex));
}

/**
 * Toggle the device's reshare of a card: reshare when not reshared,
 * unreshare when already reshared. The reshare reuses the original post's
 * geohash cell (no GPS prompt) and carries NO post content. Returns the new
 * event id (hex). Callers notify feed listeners (feed.ts) afterwards so
 * Timeline refreshes; this module deliberately does not import feed.ts,
 * keeping the dependency one-directional (feed -> reshares).
 *
 * Requires the card's authorPubkeyHex (populated by feed.ts); without it the
 * original author cannot be referenced and the toggle refuses rather than
 * emitting a malformed event.
 */
export async function toggleReshare(card: PostCardModel): Promise<string> {
  if (!card.authorPubkeyHex) {
    throw new Error('toggleReshare: card has no authorPubkeyHex');
  }
  const publicKey = await getDevicePublicKey();
  const myHex = toHex(publicKey);
  const already = counter.hasReshared(myHex, card.eventId);
  // T8: signed through the KeyStorePort sign() seam — same wire shape as
  // createReshare/createUnreshare (tags e + p, no post content), but the
  // secret key never enters this module.
  const event = await signDeviceEvent({
    created_at: Math.floor(Date.now() / 1000),
    kind: EVENT_KIND_RESHARE as EventKind,
    geohash: card.geohash,
    tags: [
      ['e', card.eventId.toLowerCase()],
      ['p', card.authorPubkeyHex.toLowerCase()],
    ],
    content: already ? UNRESHARE_CONTENT : RESHARE_CONTENT,
  });
  counter.markPostKnown(card.eventId);
  counter.add(event, (e) => verifyEvent(crypto, e));
  try {
    await getStore().saveEvent(event);
  } catch {
    // The local count already applied; a store failure must not roll back
    // the optimistic UI state. Delivery/rehydration will reconcile later.
  }
  return toHex(event.id);
}

/** Best-effort device pubkey hex for "reshared by me" state (undefined when unavailable). */
export async function getMyPubkeyHex(): Promise<string | undefined> {
  try {
    const publicKey = await getDevicePublicKey();
    return toHex(publicKey);
  } catch {
    return undefined;
  }
}

/** Reshare view fields for one card, given the optional device pubkey hex. */
export function reshareViewFor(
  postIdHex: string,
  myPubkeyHex?: string,
): Pick<PostCardModel, 'reshares' | 'resharedByMe' | 'latestResharerLabel'> {
  const cluster = counter.cluster(postIdHex);
  return {
    reshares: cluster.count,
    resharedByMe:
      myPubkeyHex !== undefined
        ? cluster.resharers.includes(myPubkeyHex.toLowerCase())
        : false,
    latestResharerLabel:
      cluster.latestResharer !== null ? resharerLabelFor(cluster.latestResharer) : undefined,
  };
}
