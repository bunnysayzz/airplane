// SPDX-License-Identifier: Apache-2.0
// Feed cache tests: merge order and dedup, count and size caps with
// no time expiry, the refresh display state machine, and KV round trip.

import { MemoryKv } from '@airplane/storage';
import {
  FEED_CACHE_MAX_BYTES,
  FEED_CACHE_MAX_PER_CELL,
  FEED_CACHE_MAX_TOTAL,
  hasCachedPostsForCells,
  loadFeedCache,
  mergeFeedCards,
  resolveFeedDisplay,
  saveFeedCache,
  trimFeedCache,
} from './feedCache';
import type { PostCardModel } from './types';

function card(eventId: string, geohash: string, createdAtMs = 1000): PostCardModel {
  return {
    eventId,
    createdAtMs,
    authorLabel: 'quiet fox·a3f9',
    authorPubkeyHex: 'aa'.repeat(32),
    body: 'hello',
    geohash,
    views: 0,
    score: 0,
    worldConfirmed: false,
    stars: 0,
    starLabel: '',
    starredByMe: false,
    reshares: 0,
    resharedByMe: false,
  };
}

describe('mergeFeedCards', () => {
  test('fresh cards come first, saved cards follow, duplicates removed', () => {
    const merged = mergeFeedCards(
      [card('aa', 'cellA'), card('bb', 'cellA')],
      [card('bb', 'cellA'), card('cc', 'cellB')],
    );
    expect(merged.map(c => c.eventId)).toEqual(['aa', 'bb', 'cc']);
  });
});

describe('trimFeedCache', () => {
  test('keeps at most 100 cards per cell, in display order', () => {
    const cards = Array.from({ length: 150 }, (_, i) =>
      card(`id${String(i).padStart(3, '0')}`, 'cellA', 1000 + i),
    );
    const trimmed = trimFeedCache(cards);
    expect(trimmed).toHaveLength(FEED_CACHE_MAX_PER_CELL);
    expect(trimmed[0].eventId).toBe('id000');
    expect(trimmed[trimmed.length - 1].eventId).toBe('id099');
  });

  test('keeps at most 500 cards in total across cells', () => {
    const cards = Array.from({ length: 600 }, (_, i) =>
      card(`id${String(i).padStart(3, '0')}`, `cell${i % 10}`, 1000 + i),
    );
    expect(trimFeedCache(cards)).toHaveLength(FEED_CACHE_MAX_TOTAL);
  });

  test('drops cards from the end until the serialized cache fits the byte cap', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      ...card(`id${String(i).padStart(2, '0')}`, 'cellA'),
      body: 'x'.repeat(20000),
    }));
    const trimmed = trimFeedCache(big);
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.length).toBeLessThan(big.length);
    expect(
      JSON.stringify({ version: 1, cards: trimmed }).length,
    ).toBeLessThanOrEqual(FEED_CACHE_MAX_BYTES);
  });

  test('age alone never drops a card: a very old card is retained', () => {
    const old = card('old', 'cellA', 0);
    expect(trimFeedCache([old])).toEqual([old]);
  });
});

describe('resolveFeedDisplay', () => {
  test('a non empty fresh result merges at top and is saved', () => {
    const fresh = [card('new', 'cellA', 3000)];
    const cached = [card('old', 'cellB', 1000)];
    const display = resolveFeedDisplay(fresh, cached, []);
    expect(display.state).toBe('live');
    expect(display.posts.map(c => c.eventId)).toEqual(['new', 'old']);
    expect(display.cacheToSave).toEqual(display.posts);
  });

  test('an empty fresh result keeps the current on screen cards', () => {
    const current = [card('seen', 'cellA')];
    const display = resolveFeedDisplay([], [card('saved', 'cellA')], current);
    expect(display.state).toBe('cached');
    expect(display.posts).toEqual(current);
    expect(display.cacheToSave).toBeNull();
  });

  test('an empty fresh result with nothing on screen falls back to saved cards', () => {
    const cached = [card('saved', 'cellA')];
    const display = resolveFeedDisplay([], cached, []);
    expect(display.state).toBe('cached');
    expect(display.posts).toEqual(cached);
  });

  test('an empty fresh result with no current and no saved cards is empty', () => {
    const display = resolveFeedDisplay([], [], []);
    expect(display.state).toBe('empty');
    expect(display.posts).toEqual([]);
  });

  test('a fresh result deduplicates against saved cards', () => {
    const display = resolveFeedDisplay(
      [card('same', 'cellA')],
      [card('same', 'cellA'), card('older', 'cellA')],
      [],
    );
    expect(display.posts.map(c => c.eventId)).toEqual(['same', 'older']);
  });
});

describe('hasCachedPostsForCells', () => {
  test('true only when a cached card belongs to the given cells', () => {
    expect(hasCachedPostsForCells([card('a', 'cellA')], ['cellA', 'cellB'])).toBe(true);
    expect(hasCachedPostsForCells([card('a', 'cellA')], ['cellC'])).toBe(false);
    expect(hasCachedPostsForCells([], ['cellA'])).toBe(false);
  });
});

describe('KV round trip', () => {
  test('saved cards load back, and corrupt payloads load as empty', async () => {
    const kv = new MemoryKv();
    await saveFeedCache(kv, [card('a', 'cellA'), card('b', 'cellB')]);
    expect((await loadFeedCache(kv)).map(c => c.eventId)).toEqual(['a', 'b']);
    await kv.set('feedCache.v1', 'not json');
    expect(await loadFeedCache(kv)).toEqual([]);
    await kv.set('feedCache.v1', JSON.stringify({ version: 99, cards: [] }));
    expect(await loadFeedCache(kv)).toEqual([]);
  });

  test('invalid rows are dropped, valid rows load', async () => {
    const kv = new MemoryKv();
    await kv.set(
      'feedCache.v1',
      JSON.stringify({ version: 1, cards: [card('good', 'cellA'), { eventId: 'bad' }] }),
    );
    expect((await loadFeedCache(kv)).map(c => c.eventId)).toEqual(['good']);
  });
});
