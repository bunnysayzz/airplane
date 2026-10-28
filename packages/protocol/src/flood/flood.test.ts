// SPDX-License-Identifier: Apache-2.0
import {
  SeenCache,
  decrementTtl,
  sampleJitterMs,
  shouldRelay,
} from './engine';
import {
  FLOOD_JITTER_MS_MAX,
  FLOOD_JITTER_MS_MIN,
  SEEN_LRU_CAP,
} from '../events/types';
import { toHex } from '../hex';
import { makePost } from '../test-helpers';
import { eventId } from '../codec/cbor';

function idHex(): string {
  const event = makePost('flood ' + Math.random());
  return toHex(eventId(event));
}

describe('flood engine', () => {
  test('shouldRelay: true for fresh event with ttl>0', () => {
    const seen = new SeenCache();
    expect(shouldRelay(seen, idHex(), 7)).toBe(true);
  });

  test('shouldRelay: false when ttl is 0 or negative', () => {
    const seen = new SeenCache();
    expect(shouldRelay(seen, idHex(), 0)).toBe(false);
    expect(shouldRelay(seen, idHex(), -3)).toBe(false);
  });

  test('shouldRelay: false for already-seen event (loop suppression)', () => {
    const seen = new SeenCache();
    const id = idHex();
    seen.add(id);
    expect(shouldRelay(seen, id, 7)).toBe(false);
  });

  test('decrementTtl floors at 0', () => {
    expect(decrementTtl(7)).toBe(6);
    expect(decrementTtl(1)).toBe(0);
    expect(decrementTtl(0)).toBe(0);
  });

  test('relay chain of 8 nodes with TTL 7 terminates', () => {
    // Nodes 0..7 in a line; node 0 originates with ttl=7.
    const nodes = Array.from({ length: 8 }, () => new SeenCache());
    const event = makePost('chain');
    const id = toHex(eventId(event));

    let relays = 0;
    // node 0 -> node 1 carries ttl 7
    const queue: Array<{ node: number; ttl: number }> = [{ node: 1, ttl: 7 }];
    const MAX_STEPS = 1000;
    let steps = 0;
    while (queue.length > 0 && steps++ < MAX_STEPS) {
      const { node, ttl } = queue.shift() as { node: number; ttl: number };
      const seen = nodes[node];
      if (!shouldRelay(seen, id, ttl)) continue;
      seen.add(id);
      relays++;
      if (node + 1 < nodes.length) {
        queue.push({ node: node + 1, ttl: decrementTtl(ttl) });
      }
    }
    expect(steps).toBeLessThan(MAX_STEPS); // terminated, no infinite relay
    expect(relays).toBe(7); // one relay per hop, ttl exhausted exactly at the end
    // Every node saw the event exactly once.
    for (const seen of nodes.slice(1)) expect(seen.has(id)).toBe(true);
  });

  test('two-node loop does not relay forever (dedup convergence)', () => {
    const a = new SeenCache();
    const b = new SeenCache();
    const id = idHex();
    let sends = 0;
    // A originates, sends to B with ttl 7.
    const inbox: Array<{ to: SeenCache; from: SeenCache; ttl: number }> = [
      { to: b, from: a, ttl: 7 },
    ];
    a.add(id);
    sends++;
    let steps = 0;
    while (inbox.length > 0 && steps++ < 100) {
      const { to, from, ttl } = inbox.shift() as {
        to: SeenCache;
        from: SeenCache;
        ttl: number;
      };
      if (!shouldRelay(to, id, ttl)) continue;
      to.add(id);
      sends++;
      // Naive peer rebroadcasts back to the sender too.
      inbox.push({ to: from, from: to, ttl: decrementTtl(ttl) });
    }
    expect(steps).toBeLessThan(100);
    expect(sends).toBe(2); // A->B, B->A; A's seen cache kills the loop
  });

  test('SeenCache is an LRU capped at 10000', () => {
    const seen = new SeenCache();
    for (let i = 0; i < SEEN_LRU_CAP + 500; i++) seen.add(`id-${i}`);
    expect(seen.size).toBe(SEEN_LRU_CAP);
    expect(seen.has('id-0')).toBe(false); // oldest evicted
    expect(seen.has(`id-${SEEN_LRU_CAP + 499}`)).toBe(true);
    // Re-adding refreshes recency.
    seen.add('id-1');
    seen.add('id-overflow');
    expect(seen.has('id-1')).toBe(true);
  });

  test('jitter stays within [50, 500] ms', () => {
    expect(sampleJitterMs(() => 0)).toBe(FLOOD_JITTER_MS_MIN);
    expect(sampleJitterMs(() => 1)).toBe(FLOOD_JITTER_MS_MAX);
    expect(sampleJitterMs(() => 0.5)).toBe(275);
    for (let i = 0; i < 1000; i++) {
      const j = sampleJitterMs();
      expect(j).toBeGreaterThanOrEqual(50);
      expect(j).toBeLessThanOrEqual(500);
    }
  });
});
