// SPDX-License-Identifier: Apache-2.0
import { EVENT_KIND_POST, EVENT_KIND_STAR } from '../events/types';
import { makePost } from '../test-helpers';
import { MeshIngressLimiter, TokenBucket } from './rateLimit';

describe('TokenBucket', () => {
  test('burst up to capacity, then empty until refill', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1 / 1000, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    now = 1000;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  test('a rejected take consumes nothing', () => {
    let now = 0;
    const bucket = new TokenBucket(1, 1 / 1000, () => now);
    expect(bucket.take()).toBe(true);
    expect(bucket.peek()).toBe(false);
    expect(bucket.take()).toBe(false);
    now = 1000;
    expect(bucket.take()).toBe(true);
  });
});

describe('MeshIngressLimiter (T20)', () => {
  test('per-sender burst of 5, then throttled, then refilled', () => {
    let now = 0;
    const limiter = new MeshIngressLimiter({ nowMs: () => now });
    // makePost mints a fresh keypair per call, so pin one sender.
    const sender = new Uint8Array(32).fill(7);
    for (let i = 0; i < 5; i++) {
      expect(limiter.allow({ ...makePost(`post ${i}`), pubkey: sender })).toBe(true);
    }
    expect(limiter.allow({ ...makePost('post 5'), pubkey: sender })).toBe(false);
    now = 1000;
    expect(limiter.allow({ ...makePost('post 6'), pubkey: sender })).toBe(true);
    expect(limiter.allow({ ...makePost('post 7'), pubkey: sender })).toBe(false);
  });

  test('per-text bucket throttles repeats of one text across senders', () => {
    let now = 0;
    const limiter = new MeshIngressLimiter({ nowMs: () => now });
    // Distinct authors (distinct pubkeys) repeat the same text.
    const authors = Array.from({ length: 4 }, (_, i) =>
      makePost('reached?', 1_700_000_000 + i),
    );
    // makePost uses one fixed keypair in test-helpers, so vary the
    // sender by rebuilding with a distinct pubkey per author.
    const events = authors.map((e, i) => ({
      ...e,
      pubkey: new Uint8Array(32).fill(i + 1),
      content: 'reached?',
    }));
    expect(events.map((e) => limiter.allow(e))).toEqual([true, true, true, false]);
    now = 2000;
    expect(limiter.allow({ ...events[3], content: 'reached?' })).toBe(true);
  });

  test('fixed-token kinds are sender-limited only, never text-limited', () => {
    const now = 0;
    const limiter = new MeshIngressLimiter({ nowMs: () => now });
    // Four different senders star with the same '+' token: none dropped.
    const stars = Array.from({ length: 4 }, (_, i) => ({
      ...makePost('+'),
      kind: EVENT_KIND_STAR as 4,
      pubkey: new Uint8Array(32).fill(i + 1),
      content: '+',
    }));
    expect(stars.map((e) => limiter.allow(e))).toEqual([true, true, true, true]);
  });

  test('a rejected event consumes no sender token', () => {
    const now = 0;
    const limiter = new MeshIngressLimiter({ nowMs: () => now });
    const spam = Array.from({ length: 3 }, (_, i) =>
      makePost('spam', 1_700_000_000 + i),
    );
    // Same sender, same text: sender bucket has 5, text bucket has 3.
    const first = spam.map((e) => ({ ...e, pubkey: new Uint8Array(32).fill(9) }));
    expect(first.map((e) => limiter.allow(e))).toEqual([true, true, true]);
    // Text bucket empty now; this rejection must not eat a sender token.
    expect(limiter.allow({ ...first[0], content: 'spam' })).toBe(false);
    // A different text from the same sender still has sender tokens.
    expect(limiter.allow({ ...first[0], content: 'fresh text' })).toBe(true);
  });

  test('kind-1 posts with empty content skip the text bucket', () => {
    const now = 0;
    const limiter = new MeshIngressLimiter({ nowMs: () => now });
    // makePost rejects empty content, so build from a valid post and
    // blank the content: the limiter never validates, it only reads.
    const events = Array.from({ length: 6 }, (_, i) => ({
      ...makePost('x', 1_700_000_000 + i),
      kind: EVENT_KIND_POST as 1,
      pubkey: new Uint8Array(32).fill(i + 1),
      content: '',
    }));
    expect(events.map((e) => limiter.allow(e))).toEqual([true, true, true, true, true, true]);
  });
});
