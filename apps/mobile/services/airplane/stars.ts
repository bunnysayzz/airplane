// SPDX-License-Identifier: Apache-2.0
// Star service (STAR MVP): app-side owner of the StarCounter.
//
// Wiring notes (read before touching):
// - Star events (kind 4) are NOT stored in the SQLite events table: its
//   schema CHECKs kind IN (1,2,3) and the schema file is frozen (new
//   migrations only). Star state therefore lives in this in-memory counter
//   in v1 and repopulates as star events re-arrive via flood/relay.
//   A durable star table (MIGRATION_004) is the follow-up, not this MVP.
// - Ingress (transport.ts handleIncoming) routes kind-4 events here and
//   kind-1 posts to markStarPostKnown, so pending stars flush when their
//   post arrives. Never call saveEvent() with a kind-4 event.
// - Ranking is untouched: stars are display-only. No PoW, relay curation,
//   or web-of-trust gating in v1 (report §6: per-key counting + signature
//   verification are the MVP mitigations).
// - The user's own star is applied locally BEFORE any flood/relay publish
//   (optimistic): the filled star shows immediately regardless of
//   confirmation. Publish failures are swallowed — the local state stays
//   starred; a retry-on-reconnect pass is follow-up work.

import {
  EVENT_KIND_STAR,
  StarCounter,
  createStarEvent,
  createUnstarEvent,
  formatStarCount,
  fromHex,
  toHex,
  verifyEvent,
  type Hex64,
  type SignedEvent,
  type StarView,
} from '@airplane/protocol';
import { getDeviceKeypair, crypto } from './identity';

let counter: StarCounter = new StarCounter();
let ownPubkeyHex: Hex64 | null = null;

/** The app-wide star counter (single instance; tests reset it). */
export function getStarCounter(): StarCounter {
  return counter;
}

/** Test seam: fresh counter + cleared own-key cache. */
export function __resetStarsForTests(): void {
  counter = new StarCounter();
  ownPubkeyHex = null;
}

/** A post row now exists locally: flush any pending stars held for it. */
export function markStarPostKnown(postIdHex: Hex64): void {
  counter.markPostKnown(postIdHex);
}

/**
 * Apply one inbound kind-4 event. Verifies the signature first; unverified
 * events are never counted. Returns true when the event changed star state
 * (applied, including from pending) — callers use it to decide on refresh.
 */
export function applyIncomingStar(event: SignedEvent): boolean {
  if (event.kind !== EVENT_KIND_STAR) return false;
  const result = counter.apply(event, (e) => verifyEvent(crypto, e));
  return result === 'applied';
}

/** The device's own pubkey hex, cached; null when identity is unavailable. */
export async function resolveOwnPubkeyHex(): Promise<Hex64 | null> {
  if (ownPubkeyHex) return ownPubkeyHex;
  try {
    const { publicKey } = await getDeviceKeypair();
    ownPubkeyHex = toHex(publicKey);
    return ownPubkeyHex;
  } catch {
    return null;
  }
}

/** Card-ready star view for one post: count + partial label + own state. */
export function starViewFor(postIdHex: Hex64, ownHex: Hex64 | null): StarView & { label: string } {
  const view = counter.view(postIdHex, ownHex);
  return { ...view, label: formatStarCount(view.count) };
}

export interface ToggleStarDeps {
  /** Override for the transport fan-out (tests inject a stub). */
  publish?: (event: SignedEvent) => Promise<unknown>;
}

/**
 * Toggle the user's star on a post. Creates a signed kind-4 star (or
 * unstar) event, applies it locally first (optimistic filled star), then
 * fans it out over the same transports as posts (BLE + Nostr via
 * publishViaTransport). Returns the new starred state.
 */
export async function toggleStar(
  postIdHex: Hex64,
  geohash5: string,
  deps: ToggleStarDeps = {},
): Promise<boolean> {
  const { publicKey, secretKey } = await getDeviceKeypair();
  ownPubkeyHex = toHex(publicKey);
  const id = postIdHex.toLowerCase();
  // Toggling from a visible card means the post is known; mark it so the
  // user's own star can never sit in the pending queue.
  counter.markPostKnown(id);
  const currentlyStarred = counter.isStarred(id, ownPubkeyHex);
  // Same-second toggles would otherwise tie on created_at and fall to the
  // id-hex tie-break, which is random w.r.t. user intent (a same-second
  // unstar would lose ~half the time). This client's own events are
  // therefore monotonically increasing in created_at: if our latest event
  // for this post is at or ahead of wall-clock now, step one second past
  // it. Remote events still resolve by (created_at, id-hex); a 1 s step
  // is far inside the 300 s future-skew tolerance.
  const nowSec = Math.floor(Date.now() / 1000);
  const latestOwn = counter.latestFor(id, ownPubkeyHex);
  const createdAt = latestOwn && latestOwn.created_at >= nowSec ? latestOwn.created_at + 1 : nowSec;
  const params = {
    crypto,
    secretKey,
    pubkey: publicKey,
    geohash5,
    postId: fromHex(id),
    createdAt,
  };
  const event = currentlyStarred ? createUnstarEvent(params) : createStarEvent(params);
  // Optimistic local apply: verified (we just signed it) and immediate,
  // regardless of whether the flood/relay publish below succeeds.
  counter.apply(event, (e) => verifyEvent(crypto, e));
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
  return !currentlyStarred;
}
