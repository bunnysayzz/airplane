// SPDX-License-Identifier: Apache-2.0
// Persistent feed cache: previously loaded posts stay visible.
//
// Diagnosis (see the Timeline change): the feed query is cell scoped
// (apps/mobile/services/airplane/feed.ts plus packages/storage/src
// op-sqlite.ts listFeed, which returns [] for an empty cell list), and
// Timeline replaced its whole list with every refresh result
// (apps/mobile/screens/Timeline/timeline.tsx). So any refresh that
// resolved to no matching rows, an empty scope, or a new cell window
// wiped the visible list, even though the posts were still in the
// on-device store. Losing peers does not delete anything; it only
// stops new arrivals, and the next refresh then shows the empty
// result instead of the last loaded feed.
//
// This module is the fix at the display layer: the last loaded cards
// are persisted in the app KV store (MMKV on device, never a server),
// and a refresh that returns nothing falls back to them instead of
// blanking the list. Fresh posts merge at the top on refresh, with
// duplicates removed by event id. The store query, ranking, and cell
// scoping are unchanged: a live result still comes from the store,
// and this cache only fills the gap when the live result is empty.
//
// Retention is by count and size, never by time alone. There is no
// expiry clock in this file: a cached card stays until it is pushed
// out by the caps below, even past the store 24 h retention window.
// That is deliberate, and it is the behaviour requested for this
// track: a social media style cache, not a time based cache. Cached
// cards are the same public by design post bodies the store already
// holds locally, so nothing new is stored, only kept visible longer.
// A cached card whose store row has since expired may still fail to
// open in detail (the detail route reads the store directly); the
// feed list itself is what this cache preserves.

import type { KvPort } from '@airplane/storage';
import type { PostCardModel } from './types';

/** KV key for the persisted cache. Versioned so a future shape change
 *  can ignore (not migrate) an old payload. */
export const FEED_CACHE_KEY = 'feedCache.v1';

/** Max cached cards kept per geohash-5 cell, in display order. A page
 *  is 50 cards, so 100 per cell holds about two full screens of a
 *  local feed before older cards in that cell drop out. */
export const FEED_CACHE_MAX_PER_CELL = 100;

/** Max cached cards kept in total, in display order. With 100 per
 *  cell this holds five full cells, or more partial cells. */
export const FEED_CACHE_MAX_TOTAL = 500;

/** Max serialized cache size in bytes. A typical card is a few
 *  hundred bytes, so 500 cards sit well under this cap; the cap is a
 *  backstop against unbounded KV growth, not the usual trim. */
export const FEED_CACHE_MAX_BYTES = 512 * 1024;

/** What a feed load shows: live store rows, saved cards, or nothing. */
export type FeedDisplayState = 'live' | 'cached' | 'empty';

/** Result of resolving one refresh against the cache. */
export interface FeedDisplay {
  /** Cards to show. */
  posts: PostCardModel[];
  /** Which source the shown cards came from. */
  state: FeedDisplayState;
  /** Cards to persist, or null when nothing new should be saved. */
  cacheToSave: PostCardModel[] | null;
}

/** Merge fresh cards with saved cards: fresh first, in fresh order,
 *  then saved cards not already present, deduplicated by event id. */
export function mergeFeedCards(
  fresh: PostCardModel[],
  saved: PostCardModel[],
): PostCardModel[] {
  const seen = new Set<string>();
  const out: PostCardModel[] = [];
  for (const card of [...fresh, ...saved]) {
    if (seen.has(card.eventId)) continue;
    seen.add(card.eventId);
    out.push(card);
  }
  return out;
}

/**
 * Trim cards to the retention caps, preserving display order. Cards
 * past the per cell cap, past the total cap, or past the byte cap are
 * dropped from the end of the list, so the cards at the top of the
 * feed survive longest. No card is dropped for its age.
 */
export function trimFeedCache(cards: PostCardModel[]): PostCardModel[] {
  const seen = new Set<string>();
  const perCell = new Map<string, number>();
  const kept: PostCardModel[] = [];
  for (const card of cards) {
    if (seen.has(card.eventId)) continue;
    seen.add(card.eventId);
    const count = perCell.get(card.geohash) ?? 0;
    if (count >= FEED_CACHE_MAX_PER_CELL) continue;
    perCell.set(card.geohash, count + 1);
    kept.push(card);
    if (kept.length >= FEED_CACHE_MAX_TOTAL) break;
  }
  while (
    kept.length > 0 &&
    JSON.stringify({ version: 1, cards: kept }).length > FEED_CACHE_MAX_BYTES
  ) {
    kept.pop();
  }
  return kept;
}

/**
 * Decide what one refresh shows. A non empty fresh result is live
 * and is merged with the cache, then saved. An empty fresh result
 * keeps the current on screen cards when there are any, else the
 * saved cards, and never returns an empty list while either exists.
 * An empty result with no current and no saved cards is genuinely
 * empty. This is a pure function so the state machine is unit
 * tested without rendering the Timeline.
 */
export function resolveFeedDisplay(
  fresh: PostCardModel[],
  cached: PostCardModel[],
  current: PostCardModel[],
): FeedDisplay {
  if (fresh.length > 0) {
    const posts = trimFeedCache(mergeFeedCards(fresh, mergeFeedCards(cached, current)));
    return { posts, state: 'live', cacheToSave: posts };
  }
  if (current.length > 0) {
    return { posts: current, state: 'cached', cacheToSave: null };
  }
  if (cached.length > 0) {
    return { posts: cached, state: 'cached', cacheToSave: null };
  }
  return { posts: [], state: 'empty', cacheToSave: null };
}

/** True when any cached card belongs to one of the given cells. */
export function hasCachedPostsForCells(
  cached: PostCardModel[],
  cells: string[],
): boolean {
  const scope = new Set(cells);
  return cached.some(card => scope.has(card.geohash));
}

/** Minimal shape check for a persisted card. Rows that fail are
 *  dropped, never rendered, so a corrupt or old payload cannot break
 *  the feed. Post and message text is never logged here. */
function isValidCard(value: unknown): value is PostCardModel {
  if (typeof value !== 'object' || value === null) return false;
  const card = value as Record<string, unknown>;
  return (
    typeof card.eventId === 'string' &&
    typeof card.createdAtMs === 'number' &&
    typeof card.authorLabel === 'string' &&
    typeof card.body === 'string' &&
    typeof card.geohash === 'string' &&
    typeof card.views === 'number' &&
    typeof card.score === 'number' &&
    typeof card.worldConfirmed === 'boolean' &&
    typeof card.stars === 'number' &&
    typeof card.starLabel === 'string' &&
    typeof card.starredByMe === 'boolean' &&
    typeof card.reshares === 'number' &&
    typeof card.resharedByMe === 'boolean'
  );
}

/** Load the persisted cache. Corrupt, wrong shape, or missing
 *  payloads all read as an empty cache, never a throw. */
export async function loadFeedCache(kv: KvPort): Promise<PostCardModel[]> {
  try {
    const raw = await kv.get(FEED_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; cards?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.cards)) return [];
    return trimFeedCache(parsed.cards.filter(isValidCard));
  } catch {
    return [];
  }
}

/** Persist cards under the retention caps. Never throws: a cache
 *  write failure must not break a feed load that already succeeded. */
export async function saveFeedCache(kv: KvPort, cards: PostCardModel[]): Promise<void> {
  try {
    await kv.set(FEED_CACHE_KEY, JSON.stringify({ version: 1, cards: trimFeedCache(cards) }));
  } catch {
    // Cache persistence is best effort; the live list is unaffected.
  }
}
