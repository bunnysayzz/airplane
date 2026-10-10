// SPDX-License-Identifier: Apache-2.0
// Feed query + mapping to the card view-model.
//
// Reads kind-1 posts from the store (geohash-scoped), re-sorts by the
// protocol ranking score (highest first), and maps each FeedPost to the
// PostCardModel the card UI consumes. Relative-time formatting stays in the
// card; this layer keeps the raw `createdAtMs` timestamp.

import { toHex, type FeedPost } from '@airplane/protocol';
import type { ListFeedOpts } from '@airplane/storage';
import type { PostCardModel } from './types';
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

/** "anon·" + first 4 hex chars of the author pubkey. */
export function authorLabelFor(pubkey: Uint8Array): string {
  return 'anon·' + toHex(pubkey).slice(0, 4);
}

/** True when the event carries the signed ["uplink","1"] opt-in tag. */
export function hasUplinkTag(tags: string[][]): boolean {
  return tags.some((t) => t.length >= 2 && t[0] === 'uplink' && t[1] === '1');
}

/** Pure mapping: protocol FeedPost -> card view-model. Unit-tested. */
export function toPostCardModel(post: FeedPost): PostCardModel {
  return {
    eventId: toHex(post.event.id),
    createdAtMs: post.event.created_at * 1000,
    authorLabel: authorLabelFor(post.event.pubkey),
    body: post.event.content,
    geohash: post.event.geohash,
    views: post.views,
    score: post.score,
    uplinked: hasUplinkTag(post.event.tags),
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
  const posts = await getStore().listFeed(storeOpts);
  const ranked = [...posts].sort((a, b) => b.score - a.score);
  return ranked.map(toPostCardModel);
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
