// SPDX-License-Identifier: Apache-2.0
// Feed query + mapping to the card view-model.
//
// Reads kind-1 posts from the store (geohash-scoped), re-sorts by the
// protocol ranking score (highest first), and maps each FeedPost to the
// PostCardModel the card UI consumes. Relative-time formatting stays in the
// card; this layer keeps the raw `createdAtMs` timestamp.

import { EVENT_KIND_POST, toHex, type FeedPost } from '@airplane/protocol';
import { DEFAULT_RETENTION_SEC, rankScore, type ListFeedOpts } from '@airplane/storage';
import type { PostCardModel } from './types';
import { markStarPostKnown, resolveOwnPubkeyHex, starViewFor } from './stars';
import { markResharePostKnown, reshareViewFor } from './reshares';
import { getStore } from './store';

export interface FeedQueryOpts {
  /** Geohash-5 cells in scope; a post matches if its geohash is in this set. */
  cells: string[];
  /** Max posts to return. Defaults to 50. */
  limit?: number;
  /**
   * Pagination cursor: only posts strictly older than this `created_at`
   * (seconds) are returned. Pass the previous page's last post timestamp.
   */
  before?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Anonymous author display names: "<adjective> <noun>·<4 hex>", e.g.
 * "quiet fox·a3f9". Display-only: the author identity stays the pubkey
 * (event.pubkey / event id are untouched) and nothing ever parses the
 * label back into an identity.
 *
 * Why this shape: the old "anon·xxxx" carried only 4 hex chars (16 bits,
 * ~65k combinations), so collisions were routine in any real feed and every
 * avatar initial was "A". The words come from pubkey bytes 2 and 3 while
 * the suffix keeps the pubkey's first 4 hex chars (the same suffix as
 * before, so an author stays recognizable across the change) — that gives
 * 64 x 64 x 65536 = ~268M combinations, and the words make authors
 * memorable while the suffix still disambiguates word collisions.
 *
 * Anonymity: the label is a deterministic function of the already-public
 * pubkey (every event carries it), so it reveals nothing beyond the
 * pubkey itself. Ed25519 pubkeys are effectively uniform random, and 256
 * is divisible by 64, so the word picks are unbiased. Same pubkey always
 * maps to the same label, so repeat authors stay recognizable.
 */
import { authorLabelFor } from './names';
export { authorLabelFor };

/** Pure mapping: protocol FeedPost -> card view-model. Unit-tested.
 * worldConfirmed is looked up from storage (not in the signed payload).
 * --- RESHARE: reshareView carries the collapsed cluster (count + latest
 * resharer + self state) for the ORIGINAL card; a reshare never adds a card,
 * and ranking (score) is untouched by reshares. */
export function toPostCardModel(
  post: FeedPost,
  worldConfirmed = false,
  star?: { stars: number; starLabel: string; starredByMe: boolean },
  reshareView?: Pick<PostCardModel, 'reshares' | 'resharedByMe' | 'latestResharerLabel'>,
): PostCardModel {
  return {
    eventId: toHex(post.event.id),
    createdAtMs: post.event.created_at * 1000,
    authorLabel: authorLabelFor(post.event.pubkey),
    authorPubkeyHex: toHex(post.event.pubkey),
    body: post.event.content,
    geohash: post.event.geohash,
    views: post.views,
    score: post.score,
    worldConfirmed,
    // STAR MVP: display-only; ranking (score) is computed from views alone.
    stars: star?.stars ?? 0,
    starLabel: star?.starLabel ?? '',
    starredByMe: star?.starredByMe ?? false,
    reshares: reshareView?.reshares ?? 0,
    resharedByMe: reshareView?.resharedByMe ?? false,
    latestResharerLabel: reshareView?.latestResharerLabel,
  };
}

/**
 * List feed posts for the given cells, ranked highest-score first.
 *
 * The store returns newest-first; the protocol ranking score decides the
 * final order (views win, recency decays). Equal scores keep insertion order
 * (Array.prototype.sort is stable).
 */
export async function listFeedPosts(opts: FeedQueryOpts): Promise<PostCardModel[]> {
  const storeOpts: ListFeedOpts = {
    cells: opts.cells,
    limit: opts.limit ?? DEFAULT_LIMIT,
    before: opts.before,
  };
  const store = getStore();
  const posts = await store.listFeed(storeOpts);
  const ranked = [...posts].sort((a, b) => b.score - a.score);
  // STAR MVP: every listed post is known, so pending stars flush here too.
  // --- RESHARE: every listed post is marked known, so pending reshares for
  // it apply; the cluster is then read onto its (single, original) card.
  const ownHex = await resolveOwnPubkeyHex();
  // Look up World confirmation status for each post (client-side tracking).
  const cards = await Promise.all(
    ranked.map(async (p) => {
      const eventId = toHex(p.event.id);
      markStarPostKnown(eventId);
      markResharePostKnown(eventId);
      const worldConfirmed = await store.isWorldConfirmed(eventId);
      const star = starViewFor(eventId, ownHex);
      return toPostCardModel(p, worldConfirmed, {
        stars: star.count,
        starLabel: star.label,
        starredByMe: star.starredByMe,
      }, reshareViewFor(eventId, ownHex ?? undefined));
    }),
  );
  return cards;
}

/**
 * Detail-screen lookup: fetch one post card by event id hex, with NO cell
 * scoping. This is what the post-detail route must use — never a cell-scoped
 * feed query. The v0.1.3 feed fix taught this the hard way: both stores
 * match `cells` as a set, so an empty cell list matches NOTHING, and the
 * old detail route passed `cells: []`, which turned every tap into
 * "This post could not be found" even though the post was in the store.
 * A tapped post was visible in the feed a moment ago, so its cell is
 * irrelevant here; looking it up directly also keeps tap-to-read working
 * when location permission/GPS flakes at tap time.
 *
 * Returns null for a malformed id, an unknown id, a non-post event, or an
 * expired post (same retention window the stores apply). Tombstone caveat:
 * getEvent does not surface the store's deleted flag, so a post whose
 * tombstone arrived after it left the feed can still resolve here once;
 * the feed itself hides it on next load. That staleness window is accepted
 * over the previous behaviour (no tap ever resolving).
 */
export async function getPostCardById(eventId: string): Promise<PostCardModel | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(eventId)) return null;
  const id = eventId.toLowerCase();
  const store = getStore();
  const event = await store.getEvent(id);
  if (!event || event.kind !== EVENT_KIND_POST) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (event.created_at + DEFAULT_RETENTION_SEC <= nowSec) return null;
  const views = await store.countViews(id);
  const ageHours = Math.max(0, (nowSec - event.created_at) / 3600);
  const worldConfirmed = await store.isWorldConfirmed(id);
  markStarPostKnown(id);
  const ownHex = await resolveOwnPubkeyHex();
  const star = starViewFor(id, ownHex);
  // --- RESHARE: same collapsed-cluster mapping as the feed path.
  markResharePostKnown(id);
  return toPostCardModel(
    { event, views, score: rankScore(views, ageHours), ageHours },
    worldConfirmed,
    { stars: star.count, starLabel: star.label, starredByMe: star.starredByMe },
    reshareViewFor(id, ownHex ?? undefined),
  );
}

// --- feed change notifications --------------------------------------------
// The store has no change-event surface, so this module keeps a tiny listener
// registry. composer.ts calls notifyFeedListeners() after a post lands;
// viewTracker.ts calls it when an accepted receipt changes views/score.
// Subscribers re-call listFeedPosts() themselves (they own the query opts).

export type FeedListener = () => void;

const listeners = new Set<FeedListener>();

/**
 * Subscribe to feed mutations. Returns an unsubscribe function.
 * The callback carries no payload - re-query with listFeedPosts().
 */
export function subscribeFeed(cb: FeedListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Notify all subscribers that the feed changed. */
export function notifyFeedListeners(): void {
  for (const cb of listeners) {
    cb();
  }
}

/** Test seam. */
export function __resetFeedListenersForTests(): void {
  listeners.clear();
}
