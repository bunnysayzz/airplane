// SPDX-License-Identifier: Apache-2.0
// Reshare registry: session-local ReshareCounter + toggle action for cards.
//
// --- RESHARE (delimited block: start) ---
// The counter is the protocol layer's ReshareCounter (one counted reshare
// per pubkey per ORIGINAL post, latest-wins undo, pending-until-post-known,
// verify-before-count). This module owns one process-wide instance so the
// feed and post-detail screens read the same cluster state, and exposes the
// toggle the reshare button calls. The event is saved to the reshare_events
// store table (the events table CHECK forbids kind 5, so kind-agnostic
// saveEvent cannot hold it) and counts rehydrate across restarts via
// rehydrateReshares(); the toggle fans the event out over BLE + Nostr via
// publishViaTransport. Pull-on-demand for a post referenced by a pending
// reshare lives in transport.ts, next to ingress.
//
// Counts shown here are partial lower bounds ("seen by this device"), never
// global totals. Ranking is untouched: reshares are display-only.
// --- RESHARE (delimited block: end) ---

import {
  EVENT_KIND_POST,
  EVENT_KIND_RESHARE,
  RESHARE_CONTENT,
  ReshareCounter,
  UNRESHARE_CONTENT,
  fromHex,
  toHex,
  verifyEvent,
  type EventKind,
  type ReshareCluster,
  type SignedEvent,
} from '@airplane/protocol';
import { getDevicePublicKey, signDeviceEvent, crypto } from './identity';
import { getStore } from './store';
import { authorLabelFor } from './names';
import type { PostCardModel } from './types';

let counter = new ReshareCounter();

/** Test seam: fresh counter (mirrors stars' __resetStarsForTests). */
export function __resetResharesForTests(): void {
  counter = new ReshareCounter();
}

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

export interface ToggleReshareDeps {
  /** Override for the transport fan-out (tests inject a stub). */
  publish?: (event: SignedEvent) => Promise<unknown>;
}

/**
 * Toggle the device's reshare of a card: reshare when not reshared,
 * unreshare when already reshared. The reshare reuses the original post's
 * geohash cell (no GPS prompt) and carries NO post content. Returns the new
 * event id (hex). The local count applies optimistically first, then the
 * event is persisted for rehydration and fanned out over BLE + Nostr, and
 * feed listeners are notified so the card refreshes; callers no longer
 * need to notify themselves (a second notify from a caller is harmless).
 *
 * Requires the card's authorPubkeyHex (populated by feed.ts); without it the
 * original author cannot be referenced and the toggle refuses rather than
 * emitting a malformed event.
 */
export async function toggleReshare(
  card: PostCardModel,
  deps: ToggleReshareDeps = {},
): Promise<string> {
  if (!card.authorPubkeyHex) {
    throw new Error('toggleReshare: card has no authorPubkeyHex');
  }
  // Validate before any state change or publish: a malformed, unknown,
  // or non-post id previously produced a reshare event and reported its
  // id as success even when the counter ignored it.
  const targetId = card.eventId.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(targetId)) {
    throw new Error('toggleReshare: invalid post id');
  }
  if (!/^[0-9a-f]{64}$/.test(card.authorPubkeyHex.toLowerCase())) {
    throw new Error('toggleReshare: invalid author pubkey');
  }
  const existing = await getStore().getEvent(targetId);
  if (!existing || existing.kind !== EVENT_KIND_POST) {
    throw new Error('toggleReshare: unknown post id');
  }
  const publicKey = await getDevicePublicKey();
  const myHex = toHex(publicKey);
  const already = counter.hasReshared(myHex, card.eventId);
  // Same-second toggles would otherwise tie on created_at and fall to the
  // id-hex tie-break, which is random w.r.t. user intent (a same-second
  // unreshare would lose about half the time). This client's own events
  // are therefore monotonically increasing in created_at: if our latest
  // event for this post is at or ahead of wall-clock now, step one second
  // past it. Same pattern as stars.
  const nowSec = Math.floor(Date.now() / 1000);
  const latestOwn = counter.latestFor(card.eventId, myHex);
  const createdAt =
    latestOwn && latestOwn.created_at >= nowSec ? latestOwn.created_at + 1 : nowSec;
  // T8: signed through the KeyStorePort sign() seam - same wire shape as
  // createReshare/createUnreshare (tags e + p, no post content), but the
  // secret key never enters this module.
  const event = await signDeviceEvent({
    created_at: createdAt,
    kind: EVENT_KIND_RESHARE as EventKind,
    geohash: card.geohash,
    tags: [
      ['e', card.eventId.toLowerCase()],
      ['p', card.authorPubkeyHex.toLowerCase()],
    ],
    content: already ? UNRESHARE_CONTENT : RESHARE_CONTENT,
  });
  counter.markPostKnown(card.eventId);
  const added = counter.add(event, (e) => verifyEvent(crypto, e));
  if (added === 'ignored') {
    throw new Error('toggleReshare: reshare event rejected');
  }
  try {
    await getStore().saveReshareEvent(event);
  } catch {
    // The local count already applied; a store failure must not roll back
    // the optimistic UI state. Rehydration reconciles later.
  }
  // Fan out via the hybrid transport (BLE + Nostr, same as posts).
  // Dynamic import avoids a static cycle (transport.ts imports this module
  // for ingress; feed.ts imports this module for card mapping).
  try {
    if (deps.publish) {
      await deps.publish(event);
    } else {
      const { publishViaTransport } = await import('./transport');
      await publishViaTransport(event);
    }
  } catch {
    // Best-effort: the local optimistic state already stands.
  }
  try {
    const { notifyFeedListeners } = await import('./feed');
    notifyFeedListeners();
  } catch {
    // Listeners refresh on next feed load regardless.
  }
  return toHex(event.id);
}

/**
 * Rebuild the session counter from stored kind-5 events (cross-restart
 * rehydration). Idempotent: replaying an already-seen event is a duplicate
 * no-op in the counter, so calling this twice is safe. Returns the number
 * of events that applied (counted, or held pending for a post not yet
 * known). Never throws: a store failure just means counts repopulate as
 * reshare events re-arrive via flood/relay.
 */
export async function rehydrateReshares(): Promise<number> {
  let events: SignedEvent[];
  try {
    events = await getStore().listReshareEvents();
  } catch {
    return 0;
  }
  let applied = 0;
  for (const event of events) {
    const result = counter.add(event, (e) => verifyEvent(crypto, e));
    if (result === 'counted' || result === 'pending') applied++;
  }
  return applied;
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
