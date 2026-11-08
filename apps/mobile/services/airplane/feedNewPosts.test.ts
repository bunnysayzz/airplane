// SPDX-License-Identifier: Apache-2.0
// extractNewPostCards tests: the pill tap surfaces cards that are new to
// this view at the top, newest first, regardless of their ranked position
// in the refreshed page.

import { extractNewPostCards } from './feed';
import type { PostCardModel } from './types';

function makeCard(eventId: string, createdAtMs: number, score = 0): PostCardModel {
  return {
    eventId,
    createdAtMs,
    authorLabel: 'author',
    body: 'test post',
    geohash: 'tdr1v',
    views: 0,
    score,
    worldConfirmed: false,
    authorPubkeyHex: 'a'.repeat(64),
    reshares: 0,
    resharedByMe: false,
    stars: 0,
    starLabel: '',
    starredByMe: false,
  };
}

describe('extractNewPostCards', () => {
  test('empty before set means a first load, so nothing is treated as new', () => {
    const cards = [makeCard('a'.repeat(64), 1000)];
    expect(extractNewPostCards(new Set(), cards)).toEqual([]);
  });

  test('no new cards when every card was already on screen', () => {
    const cards = [makeCard('a'.repeat(64), 2000, 0.2), makeCard('b'.repeat(64), 1000, 0.1)];
    const before = new Set(['a'.repeat(64), 'b'.repeat(64)]);
    expect(extractNewPostCards(before, cards)).toEqual([]);
  });

  test('fresh cards buried below viewed cards come out newest first', () => {
    // Ranked page order: viewed posts first (higher score), then the
    // fresh posts. The tap must still surface the fresh ones,
    // newest first, at the top.
    const viewedOld = makeCard('a'.repeat(64), 1000, 0.2);
    const viewedOlder = makeCard('b'.repeat(64), 500, 0.1);
    const freshNewest = makeCard('c'.repeat(64), 3000, 0);
    const freshOlder = makeCard('d'.repeat(64), 2500, 0);
    const cards = [viewedOld, viewedOlder, freshNewest, freshOlder];
    const before = new Set(['a'.repeat(64), 'b'.repeat(64)]);
    expect(extractNewPostCards(before, cards)).toEqual([freshNewest, freshOlder]);
  });

  test('equal timestamps break ties by event id, highest first', () => {
    const lower = makeCard('a'.repeat(64), 2000, 0);
    const higher = makeCard('f'.repeat(64), 2000, 0);
    const before = new Set(['0'.repeat(64)]);
    expect(extractNewPostCards(before, [lower, higher])).toEqual([higher, lower]);
  });

  test('input order is not mutated', () => {
    const freshNewest = makeCard('c'.repeat(64), 3000, 0);
    const freshOlder = makeCard('d'.repeat(64), 2500, 0);
    const cards = [freshOlder, freshNewest];
    const before = new Set(['0'.repeat(64)]);
    extractNewPostCards(before, cards);
    expect(cards).toEqual([freshOlder, freshNewest]);
  });
});
