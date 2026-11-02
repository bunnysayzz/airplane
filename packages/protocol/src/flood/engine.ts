// SPDX-License-Identifier: Apache-2.0
// Flood relay engine: pure relay-decision functions + the seen LRU cache.
// Relay rule: relay an event at most once per node, only while ttl > 0,
// after a uniform random jitter of 50..500ms. See docs/spec/flood.md.

import {
  FLOOD_JITTER_MS_MAX,
  FLOOD_JITTER_MS_MIN,
  SEEN_LRU_CAP,
  SEEN_TTL_MS,
  type Hex64,
} from '../events/types';

/** Options for {@link SeenCache}. `nowMs` is a test seam; production uses Date.now. */
export interface SeenCacheOpts {
  /** Entry lifetime in ms. Default SEEN_TTL_MS (5 minutes). */
  ttlMs?: number;
  /** Clock, default Date.now. */
  nowMs?: () => number;
}

/**
 * LRU set of seen event ids, capped at SEEN_LRU_CAP (10000) and expired
 * after `ttlMs` (T20). `add` refreshes recency and timestamp; the oldest
 * entry is evicted past the cap, after expired entries are purged first.
 * Expiry is checked per entry on `has`, so a stale id never suppresses
 * a legitimate redelivery, and the map itself is only fully purged when
 * it grows past the cap (keeping `add` O(1) in the common case). Size
 * counts live entries only.
 */
export class SeenCache {
  private readonly map = new Map<Hex64, number>();
  private readonly ttlMs: number;
  private readonly nowMs: () => number;

  constructor(opts: SeenCacheOpts = {}) {
    this.ttlMs = opts.ttlMs ?? SEEN_TTL_MS;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  has(eventId: Hex64): boolean {
    const at = this.map.get(eventId);
    if (at === undefined) return false;
    if (this.nowMs() - at >= this.ttlMs) {
      this.map.delete(eventId);
      return false;
    }
    return true;
  }

  add(eventId: Hex64): void {
    if (this.map.has(eventId)) this.map.delete(eventId);
    this.map.set(eventId, this.nowMs());
    if (this.map.size > SEEN_LRU_CAP) {
      this.purgeExpired();
      while (this.map.size > SEEN_LRU_CAP) {
        const oldest = this.map.keys().next().value as Hex64;
        this.map.delete(oldest);
      }
    }
  }

  /** Remove one id (a delivery that failed after being marked seen). */
  delete(eventId: Hex64): void {
    this.map.delete(eventId);
  }

  /** Drop every entry older than the TTL. */
  purgeExpired(): void {
    const now = this.nowMs();
    for (const [id, at] of this.map) {
      if (now - at >= this.ttlMs) this.map.delete(id);
    }
  }

  get size(): number {
    this.purgeExpired();
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
