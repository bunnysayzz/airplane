// SPDX-License-Identifier: Apache-2.0
// Inbound flood limiting (T20, research priority 10). Pure, no I/O.
// With free pubkeys, per-key bans are useless (a Sybil mints a new key),
// so the limit is anchored to what a flood actually costs: distinct
// events per sender, and repeats of the same post text. This is a
// throttle, not a ban: tokens refill continuously, so honest posting is
// never throttled, and a burst sender is slowed, not silenced forever.
//
// Scope, deliberately narrow: the app applies this ONLY to BLE ingress
// (see transport.ts handleIncoming). The mesh is the scarce resource
// (~1 post/s per collision domain in the research bound); relay ingress
// is NOT throttled here, because a relay replay burst is history, not
// spam, and dropping replayed rows would lose posts that never re-arrive
// (reconnect replays only cover `since` last subscribe). Relay-side
// limits (size gates, signature verification) already apply there.

import { EVENT_KIND_POST, type SignedEvent } from '../events/types';
import { toHex } from '../hex';

/** Token bucket: `capacity` burst tokens, refilling `refillPerMs` tokens per ms. */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastMs = nowMs();
  }

  private refill(): void {
    const now = this.nowMs();
    const elapsed = Math.max(0, now - this.lastMs);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastMs = now;
    }
  }

  /** True when at least one token is available right now (no consumption). */
  peek(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  /** Consume one token if available; false when empty (nothing consumed). */
  take(): boolean {
    if (!this.peek()) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Options for {@link MeshIngressLimiter}. `nowMs` is a test seam. */
export interface MeshIngressLimiterOpts {
  /** Clock, default Date.now. */
  nowMs?: () => number;
  /** Max tracked senders / texts before the oldest entry is evicted. Default 10000. */
  mapCap?: number;
}

/**
 * Per-sender + per-text throttle for BLE ingress.
 * Per sender: 5 tokens, refilling 1/s (research starting values).
 * Per post text: 3 tokens, refilling 1 per 2 s, applied ONLY to kind-1
 * posts with non-empty content. Other kinds carry fixed tokens (star
 * '+'/'-', reshare references), so a shared text bucket would throttle
 * unrelated authors for using the same token; they are sender-limited
 * only. A rejected event consumes nothing.
 */
export class MeshIngressLimiter {
  private readonly senders = new Map<string, TokenBucket>();
  private readonly texts = new Map<string, TokenBucket>();
  private readonly nowMs: () => number;
  private readonly mapCap: number;

  constructor(opts: MeshIngressLimiterOpts = {}) {
    this.nowMs = opts.nowMs ?? Date.now;
    this.mapCap = opts.mapCap ?? 10000;
  }

  private bucketFor(map: Map<string, TokenBucket>, key: string, capacity: number, refillPerMs: number): TokenBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new TokenBucket(capacity, refillPerMs, this.nowMs);
      if (map.size >= this.mapCap) {
        const oldest = map.keys().next().value as string;
        map.delete(oldest);
      }
      map.set(key, bucket);
    }
    return bucket;
  }

  /** True when the event may be stored; false drops it before SQLite. */
  allow(event: SignedEvent): boolean {
    const sender = this.bucketFor(this.senders, toHex(event.pubkey), 5, 1 / 1000);
    if (!sender.peek()) return false;
    let textBucket: TokenBucket | null = null;
    if (event.kind === EVENT_KIND_POST && event.content.length > 0) {
      textBucket = this.bucketFor(this.texts, event.content, 3, 1 / 2000);
      if (!textBucket.peek()) return false;
    }
    sender.take();
    textBucket?.take();
    return true;
  }
}
