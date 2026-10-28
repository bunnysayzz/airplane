// SPDX-License-Identifier: Apache-2.0
// In-memory StorePort + KvPort. Fully tested; used by unit tests and as the
// reference semantics for the native drivers (op-sqlite / MMKV).

import type {
  SignedEvent,
  Hex64,
  FeedPost,
  PeerInfo,
  UnixSec,
} from '@airplane/protocol';
import type { StorePort, KvPort, ListFeedOpts } from './ports';

/** Default post retention: 24 h (blueprint §5.5). */
export const DEFAULT_RETENTION_SEC = 24 * 3600;

/** View-receipt dedup bucket: one bucket per UTC day (blueprint §3). */
export const RECEIPT_DAY_BUCKET_SEC = 86400;

/**
 * Ranking score. Mirrors the protocol formula
 * `log10(1 + views) / (ageHours + 2) ^ RANK_GRAVITY` (RANK_GRAVITY = 1.5).
 * listFeed sorts newest-first; score is computed for downstream ranking.
 */
export function rankScore(views: number, ageHours: number): number {
  return Math.log10(1 + views) / Math.pow(ageHours + 2, 1.5);
}

const HEX_DIGITS = '0123456789abcdef';

/** Lowercase hex encode (32 B id/pubkey -> 64 chars). */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_DIGITS[bytes[i] >> 4] + HEX_DIGITS[bytes[i] & 0x0f];
  }
  return out;
}

/** Hex decode. Throws on odd length or non-hex chars. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hexToBytes: odd length ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX_DIGITS.indexOf(hex[2 * i].toLowerCase());
    const lo = HEX_DIGITS.indexOf(hex[2 * i + 1].toLowerCase());
    if (hi < 0 || lo < 0) throw new Error(`hexToBytes: invalid hex in "${hex}"`);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function cloneEvent(e: SignedEvent): SignedEvent {
  return {
    id: e.id.slice(),
    pubkey: e.pubkey.slice(),
    created_at: e.created_at,
    kind: e.kind,
    geohash: e.geohash,
    tags: e.tags.map((t) => t.slice()),
    content: e.content,
    sig: e.sig.slice(),
  };
}

/** Extract the referenced post id hex from a receipt/tombstone `["e", id]` tag. */
function taggedPostId(e: SignedEvent): Hex64 | null {
  for (const tag of e.tags) {
    if (tag.length >= 2 && tag[0] === 'e' && /^[0-9a-f]{64}$/.test(tag[1])) {
      return tag[1];
    }
  }
  return null;
}

interface EventRow {
  event: SignedEvent;
  receivedAt: UnixSec;
  expiresAt: UnixSec;
  deleted: boolean;
}

export interface MemoryEventStoreOpts {
  /** Seconds after `created_at` when a post expires. Default 24 h. */
  retentionSec?: number;
}

/**
 * Map-based StorePort. Reference implementation of the store semantics:
 * idempotent upserts, tombstone-wins deletion, per-(device, day) receipt
 * dedup, TTL pruning, and geohash-scoped feed queries.
 */
export class MemoryEventStore implements StorePort {
  private readonly events = new Map<Hex64, EventRow>();
  /** (pubkeyHex, postHex, dayBucket) keys for receipt dedup. */
  private readonly receiptKeys = new Set<string>();
  private readonly viewCounts = new Map<Hex64, number>();
  private readonly peers = new Map<string, PeerInfo>();
  /**
   * Tombstones that arrived before their post; postId -> tombstone AUTHOR
   * pubkey hexes, or 'any' when armed by the trusted markDeleted primitive
   * (which cannot know the tombstone's author). Authorship is checked when
   * the post row arrives, so a forged tombstone from another key can never
   * arm a pending deletion.
   */
  private readonly pendingTombstones = new Map<Hex64, Set<string> | 'any'>();
  private readonly retentionSec: number;
  /**
   * World confirmation (hybrid plan §4): event id hex -> confirmed_at sec.
   * Client-side only; sticky (no un-confirm).
   */
  private readonly worldConfirmed = new Map<Hex64, UnixSec>();
  /**
   * Stars (T17): verified kind-4 events by event id hex, and known post
   * ids. Same idempotent semantics as the SQLite star tables.
   */
  private readonly starEvents = new Map<Hex64, SignedEvent>();
  private readonly starKnownPosts = new Set<Hex64>();
  /** Stored reshare events by id hex (kind 5 lives apart from events). */
  private readonly reshareEvents = new Map<Hex64, SignedEvent>();

  constructor(opts: MemoryEventStoreOpts = {}) {
    this.retentionSec = opts.retentionSec ?? DEFAULT_RETENTION_SEC;
  }

  async saveEvent(e: SignedEvent): Promise<void> {
    const idHex = bytesToHex(e.id);
    const existing = this.events.get(idHex);
    if (existing) {
      // Upsert by id: re-saving is a no-op (never clobber tombstone state).
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    // A pending tombstone only arms deletion when its author matches the
    // arriving event's author (tombstone authorship, audit P0).
    const pendingAuthors = this.pendingTombstones.get(idHex);
    const pendingMatch =
      pendingAuthors !== undefined &&
      (pendingAuthors === 'any' || pendingAuthors.has(bytesToHex(e.pubkey)));
    const row: EventRow = {
      event: cloneEvent(e),
      receivedAt: now,
      expiresAt: e.created_at + this.retentionSec,
      deleted: pendingMatch,
    };
    if (pendingMatch) this.pendingTombstones.delete(idHex);
    this.events.set(idHex, row);

    // A kind-3 tombstone applies deletion to its target post immediately -
    // but ONLY when the tombstone's author pubkey matches the post's author.
    if (e.kind === 3) {
      const target = taggedPostId(e);
      if (target) await this.applyTombstone(e, target);
    }
  }

  /**
   * Reshare events (kind 5) live apart from the events map, mirroring the
   * SQLite table: the events table CHECK forbids kind 5. Idempotent by id.
   */
  async saveReshareEvent(e: SignedEvent): Promise<void> {
    if (e.kind !== 5) {
      throw new Error(`saveReshareEvent: expected kind 5, got kind ${e.kind}`);
    }
    if (!taggedPostId(e)) {
      throw new Error('saveReshareEvent: reshare has no ["e", postId] tag');
    }
    const idHex = bytesToHex(e.id);
    if (this.reshareEvents.has(idHex)) return;
    this.reshareEvents.set(idHex, cloneEvent(e));
  }

  /** All stored reshare events, oldest first (rehydration replay order). */
  async listReshareEvents(): Promise<SignedEvent[]> {
    return [...this.reshareEvents.values()]
      .map((e) => cloneEvent(e))
      .sort(
        (a, b) =>
          a.created_at - b.created_at || (bytesToHex(a.id) > bytesToHex(b.id) ? 1 : -1),
      );
  }

  async getEvent(id: Hex64): Promise<SignedEvent | null> {
    const row = this.events.get(id.toLowerCase());
    return row ? cloneEvent(row.event) : null;
  }

  async getPostState(id: Hex64): Promise<{ deleted: boolean; expiresAt: number } | null> {
    const row = this.events.get(id.toLowerCase());
    return row ? { deleted: row.deleted, expiresAt: row.expiresAt } : null;
  }

  async listFeed(opts: ListFeedOpts): Promise<FeedPost[]> {
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const cells = new Set(opts.cells);
    // Tie-break cursor for equal created_at rows. Requires `before`: only
    // rows with (created_at, id) strictly older than (before, beforeId)
    // are returned.
    const beforeIdHex = opts.beforeId?.toLowerCase() ?? null;
    const posts: FeedPost[] = [];
    for (const [idHex, row] of this.events) {
      const e = row.event;
      if (e.kind !== 1) continue;
      if (row.deleted) continue;
      if (row.expiresAt <= now) continue;
      if (!cells.has(e.geohash)) continue;
      if (opts.before !== undefined) {
        if (beforeIdHex === null) {
          // before-only: legacy behavior, unchanged.
          if (e.created_at >= opts.before) continue;
        } else {
          // (created_at, id) strictly older than (before, beforeId).
          if (e.created_at > opts.before) continue;
          if (e.created_at === opts.before && idHex >= beforeIdHex) continue;
        }
      }
      const views = this.viewCounts.get(idHex) ?? 0;
      const ageHours = Math.max(0, (now - e.created_at) / 3600);
      posts.push({
        event: cloneEvent(e),
        views,
        score: rankScore(views, ageHours),
        ageHours,
      });
    }
    // Deterministic newest-first: (created_at desc, id hex desc). The id
    // tie-break makes pagination by (before, beforeId) stable even when
    // several posts share a created_at second.
    posts.sort((a, b) => {
      if (b.event.created_at !== a.event.created_at) {
        return b.event.created_at - a.event.created_at;
      }
      const aHex = bytesToHex(a.event.id);
      const bHex = bytesToHex(b.event.id);
      if (aHex === bHex) return 0;
      return bHex > aHex ? 1 : -1;
    });
    return posts.slice(0, Math.max(0, opts.limit));
  }

  /**
   * Honor a tombstone ONLY when its author pubkey matches the target post's
   * author pubkey (audit P0: unenforceable with ephemeral keys, meaningful
   * now that the device keypair is stable). A tombstone from any other key
   * is stored as an event (relay/dedup integrity) but deletes nothing.
   * If the post row does not exist yet, the tombstone's AUTHOR is remembered
   * and checked when the post arrives (tombstone-wins LWW, authorship-gated).
   */
  private async applyTombstone(tomb: SignedEvent, target: Hex64): Promise<void> {
    const key = target.toLowerCase();
    const authorHex = bytesToHex(tomb.pubkey);
    const row = this.events.get(key);
    if (row) {
      if (bytesToHex(row.event.pubkey) === authorHex) {
        row.deleted = true;
      }
      // else: forged/mismatched tombstone - stored, not honored.
    } else {
      // Never narrows a pending entry armed by the trusted markDeleted
      // primitive ('any' stays 'any').
      const existing = this.pendingTombstones.get(key);
      if (existing === undefined) {
        this.pendingTombstones.set(key, new Set<string>([authorHex]));
      } else if (existing !== 'any') {
        existing.add(authorHex);
      }
    }
  }

  async markDeleted(postId: Hex64): Promise<void> {
    const key = postId.toLowerCase();
    const row = this.events.get(key);
    if (row) {
      row.deleted = true;
    } else {
      // Tombstone-wins: remember until the post row arrives. NOTE: this is
      // the low-level primitive and trusts the caller - authorship is
      // enforced at the saveEvent ingress for kind-3 events (applyTombstone).
      // A pending entry armed via markDeleted cannot know the tombstone's
      // author, so it applies to whatever post arrives with this id.
      this.pendingTombstones.set(key, 'any');
    }
  }

  async saveReceipt(r: SignedEvent): Promise<boolean> {
    if (r.kind !== 2) {
      throw new Error(`saveReceipt: expected kind 2, got kind ${r.kind}`);
    }
    const postId = taggedPostId(r);
    if (!postId) {
      throw new Error('saveReceipt: receipt has no ["e", postId] tag');
    }
    const dayBucket = Math.floor(r.created_at / RECEIPT_DAY_BUCKET_SEC);
    const dedupKey = `${bytesToHex(r.pubkey)}:${postId}:${dayBucket}`;
    if (this.receiptKeys.has(dedupKey)) return false;

    this.receiptKeys.add(dedupKey);
    this.viewCounts.set(postId, (this.viewCounts.get(postId) ?? 0) + 1);
    // Receipts are events too: keep the row for relay/dedup integrity.
    await this.saveEvent(r);
    return true;
  }

  async countViews(postId: Hex64): Promise<number> {
    return this.viewCounts.get(postId.toLowerCase()) ?? 0;
  }

  async upsertPeer(p: PeerInfo): Promise<void> {
    const prev = this.peers.get(p.peerId);
    this.peers.set(p.peerId, {
      peerId: p.peerId,
      rssi: p.rssi ?? prev?.rssi,
      lastSeenSec: p.lastSeenSec ?? prev?.lastSeenSec,
    });
  }

  async pruneExpired(nowSec: UnixSec): Promise<number> {
    let removed = 0;
    const prunedPosts = new Set<Hex64>();
    for (const [idHex, row] of this.events) {
      if (row.expiresAt < nowSec) {
        this.events.delete(idHex);
        removed++;
        if (row.event.kind === 1) prunedPosts.add(idHex);
      }
    }
    // Drop receipts orphaned by pruned posts + their dedup keys / view counts.
    for (const postHex of prunedPosts) {
      for (const [idHex, row] of this.events) {
        if (row.event.kind === 2 && taggedPostId(row.event) === postHex) {
          this.events.delete(idHex);
          removed++;
        }
      }
      this.viewCounts.delete(postHex);
      for (const key of this.receiptKeys) {
        if (key.includes(`:${postHex}:`)) this.receiptKeys.delete(key);
      }
      // Same all-tables coverage as the SQLite prune, keyed on the
      // expired post set only: star/reshare rows for live posts, and
      // pending tombstones for posts that never arrived, survive.
      this.worldConfirmed.delete(postHex);
      this.starKnownPosts.delete(postHex);
      for (const [idHex, event] of this.starEvents) {
        if (taggedPostId(event) === postHex) this.starEvents.delete(idHex);
      }
      for (const [idHex, event] of this.reshareEvents) {
        if (taggedPostId(event) === postHex) this.reshareEvents.delete(idHex);
      }
    }
    return removed;
  }

  async markWorldConfirmed(eventId: Hex64): Promise<void> {
    const key = eventId.toLowerCase();
    if (!this.worldConfirmed.has(key)) {
      this.worldConfirmed.set(key, Math.floor(Date.now() / 1000));
    }
  }

  async isWorldConfirmed(eventId: Hex64): Promise<boolean> {
    return this.worldConfirmed.has(eventId.toLowerCase());
  }

  async listWorldConfirmed(ids: Hex64[]): Promise<Set<Hex64>> {
    const out = new Set<Hex64>();
    for (const id of ids) {
      const key = id.toLowerCase();
      if (this.worldConfirmed.has(key)) out.add(key);
    }
    return out;
  }

  async getUnconfirmed(): Promise<Hex64[]> {
    const now = Math.floor(Date.now() / 1000);
    const out: Hex64[] = [];
    for (const [idHex, row] of this.events) {
      if (row.event.kind !== 1) continue;
      if (row.deleted) continue;
      if (row.expiresAt <= now) continue; // expired posts need no relay push
      if (this.worldConfirmed.has(idHex)) continue;
      out.push(idHex);
    }
    return out;
  }

  // Stars (T17): same semantics as the SQLite star tables.

  async saveStarEvent(e: SignedEvent): Promise<void> {
    const idHex = bytesToHex(e.id);
    if (!this.starEvents.has(idHex)) {
      this.starEvents.set(idHex, cloneEvent(e));
    }
  }

  async saveStarKnownPost(postId: Hex64): Promise<void> {
    this.starKnownPosts.add(postId.toLowerCase());
  }

  async listStarEvents(): Promise<SignedEvent[]> {
    return [...this.starEvents.values()]
      .map((e) => cloneEvent(e))
      .sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at - b.created_at;
        return bytesToHex(a.id) < bytesToHex(b.id) ? -1 : 1;
      });
  }

  async listStarKnownPosts(): Promise<Hex64[]> {
    return [...this.starKnownPosts];
  }
}

/** Map-based KvPort. */
export class MemoryKv implements KvPort {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
}
