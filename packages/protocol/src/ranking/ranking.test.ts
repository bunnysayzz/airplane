// SPDX-License-Identifier: Apache-2.0
import { ageHours, rankPosts, scorePost } from './score';
import { RANK_GRAVITY } from '../events/types';
import { makePost } from '../test-helpers';

const NOW = 1_700_000_000;

describe('ranking', () => {
  test('score matches the formula log10(2+views)/(ageHours+2)^1.5', () => {
    // views=9, age=0 → log10(11) / 2^1.5
    expect(scorePost(9, 0)).toBeCloseTo(Math.log10(11) / Math.pow(2, RANK_GRAVITY), 12);
    // views=0 scores like one view used to: log10(2) / 2^1.5, never zero.
    expect(scorePost(0, 0)).toBeCloseTo(Math.log10(2) / Math.pow(2, RANK_GRAVITY), 12);
    expect(scorePost(99, 2)).toBeCloseTo(Math.log10(101) / Math.pow(4, 1.5), 12);
  });

  test('a fresh unseen post outranks a day-old viewed post', () => {
    const unseen = { event: makePost('unseen', NOW - 60), views: 0 };
    const seen = { event: makePost('seen', NOW - 24 * 3600), views: 10 };
    const ranked = rankPosts([seen, unseen], NOW);
    expect(ranked[0].event.content).toBe('unseen');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test('a recent viewed post still outranks a fresh unseen one', () => {
    const unseen = { event: makePost('unseen', NOW - 60), views: 0 };
    const recent = { event: makePost('recent', NOW - 3600), views: 2 };
    const ranked = rankPosts([unseen, recent], NOW);
    expect(ranked[0].event.content).toBe('recent');
  });

  test('more views outranks fewer views at equal age', () => {
    const hot = { event: makePost('hot', NOW - 3600), views: 100 };
    const cold = { event: makePost('cold', NOW - 3600), views: 10 };
    const ranked = rankPosts([cold, hot], NOW);
    expect(ranked[0].event.content).toBe('hot');
    expect(ranked[1].event.content).toBe('cold');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test('newer outranks older at equal views', () => {
    const fresh = { event: makePost('fresh', NOW - 3600), views: 10 };
    const stale = { event: makePost('stale', NOW - 48 * 3600), views: 10 };
    const ranked = rankPosts([stale, fresh], NOW);
    expect(ranked[0].event.content).toBe('fresh');
  });

  test('gravity decay is monotonic: older always scores lower at fixed views', () => {
    let prev = scorePost(50, 0);
    for (let age = 1; age <= 72; age++) {
      const s = scorePost(50, age);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
  });

  test('a much-viewed day-old post no longer beats a fresh unseen one', () => {
    const viral = { event: makePost('viral', NOW - 24 * 3600), views: 10000 };
    const unseen = { event: makePost('unseen', NOW - 60), views: 0 };
    const ranked = rankPosts([unseen, viral], NOW);
    expect(ranked[0].event.content).toBe('unseen');
  });

  test('equal scores keep insertion order (stable sort)', () => {
    // Same age and same views, so identical scores: the ranked order must
    // follow the input order, not shuffle the two posts.
    const first = { event: makePost('first', NOW - 60), views: 0 };
    const second = { event: makePost('second', NOW - 60), views: 0 };
    const ranked = rankPosts([first, second], NOW);
    expect(ranked[0].score).toBe(ranked[1].score);
    expect(ranked.map((p) => p.event.content)).toEqual(['first', 'second']);
  });

  test('rankPosts attaches views, score and ageHours', () => {
    const [post] = rankPosts([{ event: makePost('meta', NOW - 7200), views: 42 }], NOW);
    expect(post.views).toBe(42);
    expect(post.ageHours).toBeCloseTo(2, 9);
    expect(post.score).toBeCloseTo(scorePost(42, 2), 12);
  });

  test('ageHours floors at 0 for future timestamps', () => {
    expect(ageHours(NOW + 3600, NOW)).toBe(0);
  });
});
