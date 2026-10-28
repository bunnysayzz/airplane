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
  /**
   * Tie-break cursor for equal created_at rows: only rows with
   * (created_at, id) strictly older than (before, beforeId) are returned.
   * Requires `before`.
   */
  beforeId?: Hex64;
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

  /** Deleted/expired state for one post row, or null when unknown. */
  getPostState(id: Hex64): Promise<PostState | null>;

  /**
   * Reshare events (kind 5) live apart from the kind-1/2/3 events table:
   * that table's CHECK forbids kind 5, and reshare rows must never leak
   * into the feed query or the World-sync unconfirmed set. Insert is
   * idempotent by `id` (re-saving is a no-op). Throws when the event is
   * not kind 5 or carries no valid original-post `e` tag.
   */
  saveReshareEvent(e: SignedEvent): Promise<void>;

  /** All stored reshare events, oldest first (rehydration replay order). */
  listReshareEvents(): Promise<SignedEvent[]>;

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

  // ------------------------------------------------------------------
  // World confirmation (hybrid single-feed plan §4). Client-side only:
  // tracks which event IDs have been observed on at least one Nostr relay.
  // Never part of the signed payload, never relayed. Sticky by design.
  // ------------------------------------------------------------------

  /** Mark an event ID as confirmed on World. Idempotent. */
  markWorldConfirmed(eventId: Hex64): Promise<void>;

  /** True when the event ID has been confirmed on World. */
  isWorldConfirmed(eventId: Hex64): Promise<boolean>;

  /**
   * Batch form of isWorldConfirmed: the confirmed subset of `ids` in one
   * query. Feed pages must use this (one query per page, not per card).
   */
  listWorldConfirmed(ids: Hex64[]): Promise<Set<Hex64>>;

  /**
   * Event IDs of kind-1 posts known locally but not yet World-confirmed.
   * Used by the sync engine to decide what to push / query.
   */
  getUnconfirmed(): Promise<Hex64[]>;

  // ------------------------------------------------------------------
  // Stars (T17). Client-side only: durable star state so counts and the
  // device's own star survive restarts. Never relayed, never ranked.
  // ------------------------------------------------------------------

  /**
   * Persist one verified kind-4 star/unstar event. Idempotent by event
   * id (re-saving is a no-op). Only verified events are stored; callers
   * verify the signature before calling.
   */
  saveStarEvent(e: SignedEvent): Promise<void>;

  /** Mark a post id as known for star purposes. Idempotent. */
  saveStarKnownPost(postId: Hex64): Promise<void>;

  /** All stored verified kind-4 events, oldest first. */
  listStarEvents(): Promise<SignedEvent[]>;

  /** All stored known post ids. */
  listStarKnownPosts(): Promise<Hex64[]>;
}

/** Deleted/expired state for one stored post row. */
export interface PostState {
  /** True when a tombstone (or markDeleted) flagged this row deleted. */
  deleted: boolean;
  /** Seconds after which the row is expired (created_at + retention). */
  expiresAt: number;
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
  /**
   * Run fn atomically; on throw, roll back. When absent the driver must
   * emulate with BEGIN IMMEDIATE / COMMIT / ROLLBACK via exec.
   */
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}
