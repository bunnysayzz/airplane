// SPDX-License-Identifier: Apache-2.0
// View-receipt dedup: one countable view per (device, post, UTC day).
// Receipts are kind=2 events with tags=[["e", postIdHex]]; this class tracks
// which (pubkey, post, day-bucket) triples were already counted so replayed
// or duplicate receipts can't inflate view counts.

import { RECEIPT_DAY_BUCKET_S, type UnixSec } from '../events/types';

/** UTC day bucket for a timestamp: floor(ts / 86400). */
export function dayBucket(ts: UnixSec): number {
  return Math.floor(ts / RECEIPT_DAY_BUCKET_S);
}

export class ReceiptDedup {
  private readonly seen = new Set<string>();
  private readonly counts = new Map<string, number>();

  private static key(pubkeyHex: string, postIdHex: string, createdAt: UnixSec): string {
    return `${pubkeyHex}:${postIdHex}:${dayBucket(createdAt)}`;
  }

  /**
   * Record a receipt. Returns true when it is new and countable
   * (first receipt from this device for this post on this UTC day).
   */
  add(pubkeyHex: string, postIdHex: string, createdAt: UnixSec): boolean {
    const key = ReceiptDedup.key(pubkeyHex, postIdHex, createdAt);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.counts.set(postIdHex, (this.counts.get(postIdHex) ?? 0) + 1);
    return true;
  }

  /** Deduplicated view count for a post. */
  count(postIdHex: string): number {
    return this.counts.get(postIdHex) ?? 0;
  }
}
