// SPDX-License-Identifier: Apache-2.0
// Flood relay engine: pure relay-decision functions + the seen LRU cache.
// Relay rule: relay an event at most once per node, only while ttl > 0,
// after a uniform random jitter of 50..500ms. See docs/spec/flood.md.

import {
  FLOOD_JITTER_MS_MAX,
  FLOOD_JITTER_MS_MIN,
  SEEN_LRU_CAP,
  type Hex64,
} from '../events/types';

/**
 * LRU set of seen event ids, capped at SEEN_LRU_CAP (10000).
 * `add` refreshes recency; the oldest entry is evicted past the cap.
 */
export class SeenCache {
  private readonly map = new Map<Hex64, true>();

  has(eventId: Hex64): boolean {
    return this.map.has(eventId);
  }

  add(eventId: Hex64): void {
    if (this.map.has(eventId)) this.map.delete(eventId);
    this.map.set(eventId, true);
    if (this.map.size > SEEN_LRU_CAP) {
      const oldest = this.map.keys().next().value as Hex64;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Should this node relay the event? False when the event was already seen
 * (loop suppression) or when ttl is exhausted. Callers MUST add the event id
 * to `seen` when they decide to relay.
 */
export function shouldRelay(seen: SeenCache, eventId: Hex64, ttl: number): boolean {
  if (ttl <= 0) return false;
  return !seen.has(eventId);
}

/** Decrement TTL before forwarding; floors at 0. */
export function decrementTtl(ttl: number): number {
  return Math.max(0, ttl - 1);
}

/** Uniform jitter in [50, 500] ms before relaying a received event. */
export function sampleJitterMs(rand: () => number = Math.random): number {
  return FLOOD_JITTER_MS_MIN + rand() * (FLOOD_JITTER_MS_MAX - FLOOD_JITTER_MS_MIN);
}
