// SPDX-License-Identifier: Apache-2.0
// Star service (STAR MVP): app-side owner of the StarCounter.
//
// Wiring notes (read before touching):
// - Star events (kind 4) are NOT stored in the SQLite events table: its
//   schema CHECKs kind IN (1,2,3) and the schema file is frozen (new
//   migrations only). They live in the SQLite star_events table instead
//   (MIGRATION_004, T17), and the in-memory counter below is hydrated
//   from it at boot (ensureStarsHydrated). Never call saveEvent() with
//   a kind-4 event.
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
// - T17 persistence: every verified kind-4 event this node accepts
//   (applied, superseded, or held pending) is written to the SQLite
//   star_events table, and every post marked known is written to
//   star_known_posts. On boot, ensureStarsHydrated() replays the stored
//   events into the counter (pending first, then known posts flush), so
//   counts and the device's own star survive restarts. Writes are
//   best-effort: a store failure never breaks starring in-session, and
//   the event can still be re-learned when it re-arrives via flood/relay.
// - Self-stars: currently allowed and counted like any other star, with
//   no ranking effect (stars are display-only). Whether the UI should
//   forbid self-stars is an open product decision, not settled here.

import {
  EVENT_KIND_STAR,
  STAR_CONTENT,
  StarCounter,
  UNSTAR_CONTENT,
  formatStarCount,
  toHex,
  verifyEvent,
  type EventKind,
  type Hex64,
  type SignedEvent,
  type StarView,
} from '@airplane/protocol';
import {
  getDevicePublicKey,
  onIdentityChange,
  signDeviceEvent,
  crypto,
} from './identity';

let counter: StarCounter = new StarCounter();
let ownPubkeyHex: Hex64 | null = null;

// T8 rotation: the cached own-pubkey must not survive a burn — the next
// resolveOwnPubkeyHex() re-reads the new identity.
onIdentityChange(() => {
  ownPubkeyHex = null;
});
/** Hydration runs once per process; reset by the test seam. */
let hydrated = false;
let hydrating: Promise<void> | null = null;
/** In-flight star persistence writes (flushed by the test seam). */
const pendingWrites = new Set<Promise<void>>();
/** Known post ids already written to the store this session (write dedup). */
let persistedKnownPosts = new Set<Hex64>();

/** The app-wide star counter (single instance; tests reset it). */
export function getStarCounter(): StarCounter {
  return counter;
}

/** Test seam: fresh counter + cleared own-key cache + hydration reset. */
export function __resetStarsForTests(): void {
  counter = new StarCounter();
  ownPubkeyHex = null;
  hydrated = false;
  hydrating = null;
  persistedKnownPosts = new Set<Hex64>();
}

/**
 * Rebuild the counter from durable star state, once per process.
 * Stored events replay oldest-first through the counter's own apply path
 * (already verified before storage, so the verifier accepts them); they
 * all land pending first, then each stored known post flushes its queue,
 * which re-derives latest-wins state, dedup, and pending queues exactly.
 * Concurrent callers share the one in-flight run. Callers that already
 * require a working store (feed paths) let a failure propagate; callers
 * that must not break starring (toggleStar) swallow it.
 */
export async function ensureStarsHydrated(): Promise<void> {
  if (hydrated) return;
  if (hydrating) return hydrating;
  hydrating = (async () => {
    const { getStore } = await import('./store');
    const store = getStore();
    const [events, known] = await Promise.all([
      store.listStarEvents(),
      store.listStarKnownPosts(),
    ]);
    for (const event of events) counter.apply(event, () => true);
    for (const postId of known) {
      counter.markPostKnown(postId);
      persistedKnownPosts.add(postId.toLowerCase());
    }
    hydrated = true;
  })();
  try {
    await hydrating;
  } catch {
    hydrating = null;
    throw new Error('star hydration failed');
  }
}

/** Best-effort durable write of one accepted kind-4 event. Never throws. */
async function persistStarEvent(event: SignedEvent): Promise<void> {
  const p = (async () => {
    try {
      const { getStore } = await import('./store');
      await getStore().saveStarEvent(event);
    } catch {
      // Session-local state stands; the event can still be re-learned when
      // it re-arrives via flood/relay.
    }
  })();
  pendingWrites.add(p);
  void p.then(() => {
    pendingWrites.delete(p);
  });
}

/** Best-effort durable write of one known post id. Never throws. */
async function persistStarKnownPost(postIdHex: Hex64): Promise<void> {
  const id = postIdHex.toLowerCase();
  if (persistedKnownPosts.has(id)) return;
  const p = (async () => {
    try {
      const { getStore } = await import('./store');
      await getStore().saveStarKnownPost(id);
      persistedKnownPosts.add(id);
    } catch {
      // Retried on the next markStarPostKnown for this post (the set only
      // records successes), and the post row itself still exists in the
      // events table for the feed to find.
    }
  })();
  pendingWrites.add(p);
  void p.then(() => {
    pendingWrites.delete(p);
  });
}

/** Test seam: await every in-flight star persistence write. */
export async function __flushStarPersistenceForTests(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
}

/** A post row now exists locally: flush any pending stars held for it. */
export function markStarPostKnown(postIdHex: Hex64): void {
  counter.markPostKnown(postIdHex);
  void persistStarKnownPost(postIdHex);
}

/**
 * Apply one inbound kind-4 event. Verifies the signature first; unverified
 * events are never counted. Returns true when the event changed star state
 * (applied, including from pending) — callers use it to decide on refresh.
 * Every accepted event (applied, superseded, or held pending) is also
 * written to durable storage, so a restart replays the same state; only
 * duplicates, unverified, and invalid events are not stored.
 */
export function applyIncomingStar(event: SignedEvent): boolean {
  if (event.kind !== EVENT_KIND_STAR) return false;
  const result = counter.apply(event, (e) => verifyEvent(crypto, e));
  if (result === 'applied' || result === 'pending' || result === 'superseded') {
    void persistStarEvent(event);
  }
  return result === 'applied';
}

/** The device's own pubkey hex, cached; null when identity is unavailable. */
export async function resolveOwnPubkeyHex(): Promise<Hex64 | null> {
  if (ownPubkeyHex) return ownPubkeyHex;
  try {
    const publicKey = await getDevicePublicKey();
    ownPubkeyHex = toHex(publicKey) as Hex64;
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
  const publicKey = await getDevicePublicKey();
  ownPubkeyHex = toHex(publicKey) as Hex64;
  const id = postIdHex.toLowerCase();
  // Hydrate first so the toggle reads the durable state, not just this
  // session's: without it, a restart could flip star to unstar backwards.
  // A hydration failure must not break starring, so it is swallowed here;
  // the feed paths (which require a working store) surface it instead.
  try {
    await ensureStarsHydrated();
  } catch {
    // Session-local state stands.
  }
  // Toggling from a visible card means the post is known; mark it so the
  // user's own star can never sit in the pending queue.
  counter.markPostKnown(id);
  // Persist the known post too: a toggle must not depend on a prior feed
  // load having recorded it.
  await persistStarKnownPost(id);
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
  // T8: signed through the KeyStorePort sign() seam — the secret key is
  // never pulled into this module. Same wire shape as createStarEvent.
  const event = await signDeviceEvent({
    created_at: createdAt,
    kind: EVENT_KIND_STAR as EventKind,
    geohash: geohash5,
    tags: [['e', id]],
    content: currentlyStarred ? UNSTAR_CONTENT : STAR_CONTENT,
  });
  // Optimistic local apply: verified (we just signed it) and immediate,
  // regardless of whether the flood/relay publish below succeeds.
  counter.apply(event, (e) => verifyEvent(crypto, e));
  // Durable first, then publish: even if the publish fails, the star
  // survives a restart from this row.
  await persistStarEvent(event);
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
