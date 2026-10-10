// SPDX-License-Identifier: Apache-2.0
// Port interfaces for the storage layer (STORE-1/2/5/7).
//
// These ports keep every consumer (feed, sync, janitor) independent of the
// concrete driver. On device they are backed by op-sqlite (events) and
// react-native-mmkv (KV); on this VM and in tests they are backed by the
// in-memory implementations in ./memory.ts.

import type {
  SignedEvent,
  Hex64,
  FeedPost,
  PeerInfo,
  UnixSec,
} from '@airplane/protocol';

/** Options for {@link StorePort.listFeed}. */
export interface ListFeedOpts {
  /** Geohash-5 cells in scope; a post matches if its geohash is in this set. */
  cells: string[];
  /** Max posts to return. */
  limit: number;
  /**
   * Pagination cursor: only posts with `created_at` strictly older than this
   * are returned. Pass the `created_at` of the last post on the previous page.
   */
  before?: number;
  /** Override for "now" (seconds). Defaults to `Date.now() / 1000`. Test seam. */
  nowSec?: UnixSec;
}

/**
 * Event + receipt + peer persistence (STORE-1/2/5/7).
 *
 * Implementations must be safe to call from any async context; callers do not
 * serialize access.
 */
export interface StorePort {
  /** Insert an event, idempotent by `id` (upsert: re-saving is a no-op). */
  saveEvent(e: SignedEvent): Promise<void>;

  /** Fetch one event by id hex, or null. */
  getEvent(id: Hex64): Promise<SignedEvent | null>;

  /**
   * Feed query: kind-1 posts only, excluding deleted and expired rows,
   * matching one of `cells`, newest first. `views`/`score` are computed from
   * receipts; see `FeedPost` in `@airplane/protocol`.
   */
  listFeed(opts: ListFeedOpts): Promise<FeedPost[]>;

  /**
   * Apply a tombstone to a post: flips `deleted` on the target row.
   * If the post row does not exist yet, the tombstone is remembered and
   * applied when the post arrives (tombstone-wins LWW).
   *
   * Trusts the caller: this is the low-level primitive. Authorship
   * (`tombstone.pubkey == post.pubkey`) is enforced at the `saveEvent`
   * ingress for kind-3 events - a pending entry armed here applies to
   * whatever post arrives with this id.
   */
  markDeleted(postId: Hex64): Promise<void>;

  /**
   * Record a kind-2 view receipt. Returns `false` when a receipt from the
   * same `(pubkey, post, day)` bucket already exists (24 h dedup per device);
   * otherwise stores the receipt and returns `true`.
   */
  saveReceipt(r: SignedEvent): Promise<boolean>;

  /** Number of deduplicated view receipts for a post. */
  countViews(postId: Hex64): Promise<number>;

  /** Insert or refresh a discovered peer record. */
  upsertPeer(p: PeerInfo): Promise<void>;

  /**
   * Delete events with `expires_at < nowSec` (plus their orphaned receipts).
   * Returns the number of event rows removed.
   */
  pruneExpired(nowSec: UnixSec): Promise<number>;
}

/** Tiny string key/value store (STORE-5). Backed by MMKV on device. */
export interface KvPort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * Minimal SQL surface needed by the op-sqlite driver.
 * Provided by the op-sqlite native module in P2/P3; see ./op-sqlite.ts.
 */
export interface DatabasePort {
  /** Run a statement that returns no rows (DDL, INSERT, UPDATE, DELETE). */
  exec(sql: string, params?: unknown[]): Promise<void>;
  /** Run a query and return rows as plain objects keyed by column name. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
