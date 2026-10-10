// SPDX-License-Identifier: Apache-2.0
// op-sqlite driver skeleton (STORE-1).
//
// TODO(P3): link op-sqlite native module. This class is written against the
// DatabasePort interface; on device, construct it with the DatabasePort
// adapter over `open({ name: 'airplane.db' })` from op-sqlite, then call
// `OpSqliteStore.migrate(db)` once at boot before any other method.
// Until the native module is linked, `migrate` is the only method safe to
// call - the rest will attempt real SQL against whatever DatabasePort is
// supplied and are untested on this VM.
//
// Security note: secrets (identity keys, etc.) must NEVER live in SQLite;
// they belong in Keychain/Keystore (P2), not here.

import type {
  SignedEvent,
  Hex64,
  FeedPost,
  PeerInfo,
  UnixSec,
} from '@airplane/protocol';
import type { StorePort, DatabasePort, ListFeedOpts } from './ports';
import { MIGRATION_001, MIGRATION_002 } from './schema';
import {
  DEFAULT_RETENTION_SEC,
  RECEIPT_DAY_BUCKET_SEC,
  bytesToHex,
  hexToBytes,
  rankScore,
} from './memory';

/** Split a multi-statement SQL script on `;` boundaries (DDL has no `;` in strings). */
export function splitStatements(script: string): string[] {
  return script
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface EventRowShape {
  id: Uint8Array;
  pubkey: Uint8Array;
  kind: 1 | 2 | 3;
  created_at: number;
  geohash: string;
  tags: Uint8Array;
  content: string;
  sig: Uint8Array;
}

/** Tags are stored as UTF-8 JSON in the BLOB column (documented choice; CBOR equivalent). */
function encodeTags(tags: string[][]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(tags));
}

function decodeTags(blob: Uint8Array): string[][] {
  return JSON.parse(new TextDecoder().decode(blob)) as string[][];
}

function rowToEvent(row: EventRowShape): SignedEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    geohash: row.geohash,
    tags: decodeTags(row.tags),
    content: row.content,
    sig: row.sig,
  };
}

function taggedPostId(e: SignedEvent): Hex64 | null {
  for (const tag of e.tags) {
    if (tag.length >= 2 && tag[0] === 'e' && /^[0-9a-f]{64}$/.test(tag[1])) {
      return tag[1];
    }
  }
  return null;
}

/**
 * StorePort over a SQL database (op-sqlite on device).
 * BLOB columns are bound as Uint8Array params (supported by op-sqlite).
 */
export class OpSqliteStore implements StorePort {
  /** Tombstones that arrived before their post; see memory.ts for semantics. */
  private readonly pendingTombstones = new Map<Hex64, Set<string> | 'any'>();

  constructor(
    private readonly db: DatabasePort,
    private readonly retentionSec: number = DEFAULT_RETENTION_SEC,
  ) {}

  /**
   * Apply MIGRATION_001 then MIGRATION_002. Idempotent-safe for first boot
   * (CREATE TABLE without IF NOT EXISTS will throw on re-run; call once).
   * For upgrades on existing installs, gate on a schema_version table -
   * TODO(P3) when the native driver lands.
   */
  static async migrate(db: DatabasePort): Promise<void> {
    for (const stmt of splitStatements(MIGRATION_001)) {
      await db.exec(stmt);
    }
    for (const stmt of splitStatements(MIGRATION_002)) {
      await db.exec(stmt);
    }
  }

  async saveEvent(e: SignedEvent): Promise<void> {
    const idHex = bytesToHex(e.id);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = e.created_at + this.retentionSec;
    // A pending tombstone only arms deletion when its author matches the
    // arriving event's author (tombstone authorship, audit P0).
    const pending = this.pendingTombstones.get(idHex);
    const deleted =
      pending !== undefined && (pending === 'any' || pending.has(bytesToHex(e.pubkey))) ? 1 : 0;
    if (deleted) this.pendingTombstones.delete(idHex);
    await this.db.exec(
      `INSERT INTO events
         (id, pubkey, kind, created_at, geohash, tags, content, sig,
          received_at, expires_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      [
        e.id, e.pubkey, e.kind, e.created_at, e.geohash,
        encodeTags(e.tags), e.content, e.sig,
        now, expiresAt, deleted,
      ],
    );
    if (e.kind === 3) {
      const target = taggedPostId(e);
      if (target) await this.applyTombstone(e, target);
    }
  }

  /**
   * Honor a tombstone ONLY when its author pubkey matches the target post's
   * author pubkey (audit P0). Mirrors MemoryEventStore.applyTombstone.
   */
  private async applyTombstone(tomb: SignedEvent, target: Hex64): Promise<void> {
    const key = target.toLowerCase();
    const authorHex = bytesToHex(tomb.pubkey);
    const rows = await this.db.query<{ pubkey: Uint8Array }>(
      `SELECT pubkey FROM events WHERE id = ?`,
      [hexToBytes(key)],
    );
    if (rows.length > 0) {
      if (bytesToHex(rows[0].pubkey) === authorHex) {
        await this.db.exec(`UPDATE events SET deleted = 1 WHERE id = ?`, [hexToBytes(key)]);
      }
      // else: forged/mismatched tombstone - stored, not honored.
    } else {
      // Tombstone-wins: remember the AUTHOR so a late-arriving post is
      // checked before its deleted flag is set. Never narrows a pending
      // entry armed by the trusted markDeleted primitive ('any' stays 'any').
      const existing = this.pendingTombstones.get(key);
      if (existing === undefined) {
        this.pendingTombstones.set(key, new Set<string>([authorHex]));
      } else if (existing !== 'any') {
        existing.add(authorHex);
      }
    }
  }

  async getEvent(id: Hex64): Promise<SignedEvent | null> {
    const rows = await this.db.query<EventRowShape>(
      `SELECT id, pubkey, kind, created_at, geohash, tags, content, sig
       FROM events WHERE id = ?`,
      [hexToBytes(id.toLowerCase())],
    );
    return rows.length > 0 ? rowToEvent(rows[0]) : null;
  }

  async listFeed(opts: ListFeedOpts): Promise<FeedPost[]> {
    if (opts.cells.length === 0 || opts.limit <= 0) return [];
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const placeholders = opts.cells.map(() => '?').join(', ');
    const rows = await this.db.query<EventRowShape & { views: number }>(
      `SELECT e.id, e.pubkey, e.kind, e.created_at, e.geohash, e.tags,
              e.content, e.sig, COALESCE(v.views, 0) AS views
       FROM events e
       LEFT JOIN view_counts v ON v.post_id = e.id
       WHERE e.kind = 1
         AND e.deleted = 0
         AND e.expires_at > ?
         AND e.geohash IN (${placeholders})
         AND (? IS NULL OR e.created_at < ?)
       ORDER BY e.created_at DESC
       LIMIT ?`,
      [now, ...opts.cells, opts.before ?? null, opts.before ?? null, opts.limit],
    );
    return rows.map((row) => {
      const event = rowToEvent(row);
      const ageHours = Math.max(0, (now - event.created_at) / 3600);
      return {
        event,
        views: row.views,
        score: rankScore(row.views, ageHours),
        ageHours,
      } satisfies FeedPost;
    });
  }

  async markDeleted(postId: Hex64): Promise<void> {
    const key = postId.toLowerCase();
    await this.db.exec(`UPDATE events SET deleted = 1 WHERE id = ?`, [
      hexToBytes(key),
    ]);
    // If the row did not exist yet, remember the tombstone for when it arrives.
    // NOTE: the trusted-primitive semantics of memory.ts apply here too - a
    // pending entry armed via markDeleted cannot know the tombstone's author.
    const check = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE id = ?`,
      [hexToBytes(key)],
    );
    if (check.length === 0 || check[0].n === 0) {
      this.pendingTombstones.set(key, 'any');
    }
  }

  async saveReceipt(r: SignedEvent): Promise<boolean> {
    if (r.kind !== 2) {
      throw new Error(`saveReceipt: expected kind 2, got kind ${r.kind}`);
    }
    const postId = taggedPostId(r);
    if (!postId) throw new Error('saveReceipt: receipt has no ["e", postId] tag');
    const dayBucket = Math.floor(r.created_at / RECEIPT_DAY_BUCKET_SEC);
    const dup = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM receipts
       WHERE pubkey = ? AND post_id = ? AND day_bucket = ?`,
      [r.pubkey, hexToBytes(postId), dayBucket],
    );
    if (dup.length > 0 && dup[0].n > 0) return false;

    const now = Math.floor(Date.now() / 1000);
    await this.db.exec(
      `INSERT INTO events
         (id, pubkey, kind, created_at, geohash, tags, content, sig,
          received_at, expires_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO NOTHING`,
      [
        r.id, r.pubkey, r.kind, r.created_at, r.geohash,
        encodeTags(r.tags), r.content, r.sig,
        now, r.created_at + this.retentionSec,
      ],
    );
    await this.db.exec(
      `INSERT INTO receipts (pubkey, post_id, day_bucket, event_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [r.pubkey, hexToBytes(postId), dayBucket, r.id, r.created_at],
    );
    await this.db.exec(
      `INSERT INTO view_counts (post_id, views, updated_at)
       VALUES (?, 1, ?)
       ON CONFLICT(post_id) DO UPDATE SET
         views = views + 1, updated_at = excluded.updated_at`,
      [hexToBytes(postId), now],
    );
    return true;
  }

  async countViews(postId: Hex64): Promise<number> {
    const rows = await this.db.query<{ views: number }>(
      `SELECT views FROM view_counts WHERE post_id = ?`,
      [hexToBytes(postId.toLowerCase())],
    );
    return rows.length > 0 ? rows[0].views : 0;
  }

  async upsertPeer(p: PeerInfo): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const lastSeen = p.lastSeenSec ?? now;
    await this.db.exec(
      `INSERT INTO peers (peer_id, first_seen, last_seen, rssi, mtu, platform)
       VALUES (?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(peer_id) DO UPDATE SET
         first_seen = min(peers.first_seen, excluded.first_seen),
         last_seen = excluded.last_seen,
         rssi = excluded.rssi`,
      [p.peerId, lastSeen, lastSeen, p.rssi ?? null],
    );
  }

  async pruneExpired(nowSec: UnixSec): Promise<number> {
    const count = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE expires_at < ?`,
      [nowSec],
    );
    await this.db.exec(
      `DELETE FROM receipts
       WHERE post_id IN (SELECT id FROM events WHERE expires_at < ?)`,
      [nowSec],
    );
    await this.db.exec(`DELETE FROM events WHERE expires_at < ?`, [nowSec]);
    // Drop view_counts orphaned by pruned posts.
    await this.db.exec(
      `DELETE FROM view_counts
       WHERE post_id NOT IN (SELECT id FROM events)`,
      [],
    );
    return count.length > 0 ? count[0].n : 0;
  }

  async markWorldConfirmed(eventId: Hex64): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.exec(
      `INSERT INTO world_confirmed (event_id, confirmed_at)
       VALUES (?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
      [hexToBytes(eventId), now],
    );
  }

  async isWorldConfirmed(eventId: Hex64): Promise<boolean> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM world_confirmed WHERE event_id = ?`,
      [hexToBytes(eventId)],
    );
    return rows.length > 0 && rows[0].n > 0;
  }

  async getUnconfirmed(): Promise<Hex64[]> {
    const rows = await this.db.query<{ id: Uint8Array }>(
      `SELECT e.id AS id FROM events e
       WHERE e.kind = 1 AND e.deleted = 0
         AND NOT EXISTS (
           SELECT 1 FROM world_confirmed w WHERE w.event_id = e.id
         )`,
      [],
    );
    return rows.map((r) => bytesToHex(r.id));
  }
}
