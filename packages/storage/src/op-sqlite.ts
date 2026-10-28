// SPDX-License-Identifier: Apache-2.0
// op-sqlite driver (STORE-1).
//
// StorePort over a SQL database (op-sqlite on device). Construct with the
// DatabasePort adapter over `open({ name: 'airplane.db' })` from op-sqlite,
// then call `OpSqliteStore.migrate(db)` once at boot before any other method.
//
// Security note: secrets (identity keys, etc.) must NEVER live in SQLite;
// they belong in Keychain/Keystore (P2), not here.
//
// Deletion model: the `tombstones` table (MIGRATION_003) is the source of
// truth for deletions - durable across restarts. A row is (target post,
// tombstone author); a zero-length author blob X'' is the 'any' sentinel
// armed by the trusted markDeleted primitive.

import type {
  SignedEvent,
  Hex64,
  FeedPost,
  PeerInfo,
  UnixSec,
} from '@airplane/protocol';
import { EVENT_KIND_STAR } from '@airplane/protocol';
import type { StorePort, DatabasePort, ListFeedOpts } from './ports';
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005 } from './schema';
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

/**
 * Per-connection transaction queue: emulated BEGIN IMMEDIATE transactions
 * must never overlap on one connection, or the second BEGIN fails and the
 * post or receipt it carried is lost. Each transaction chains onto the
 * previous transaction's settled promise for the same port, so concurrent
 * saveEvent/saveReceipt calls serialize instead of nesting BEGINs. A
 * failure in one transaction never blocks the next (the stored chain
 * promise always settles).
 */
const txQueues = new WeakMap<DatabasePort, Promise<void>>();

async function runTransaction<T>(db: DatabasePort, fn: () => Promise<T>): Promise<T> {
  const prev = txQueues.get(db) ?? Promise.resolve();
  const run = prev.then(() => runTransactionInner(db, fn));
  txQueues.set(
    db,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Run fn atomically. Uses the port's native transaction when present;
 * otherwise emulates with BEGIN IMMEDIATE / COMMIT / ROLLBACK via exec.
 * On throw, rolls back and rethrows. A BEGIN failure propagates to the
 * caller (it is never swallowed here); callers that fire-and-forget must
 * log it instead of dropping it.
 */
async function runTransactionInner<T>(db: DatabasePort, fn: () => Promise<T>): Promise<T> {
  if (db.transaction) return db.transaction(fn);
  await db.exec('BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // The tx already ended (e.g. a constraint abort rolled it back);
      // the original error is what matters.
    }
    throw e;
  }
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

/** One stored kind-4 row (MIGRATION_004); kind is always EVENT_KIND_STAR. */
interface StarEventRowShape {
  event_id: Uint8Array;
  pubkey: Uint8Array;
  created_at: number;
  geohash: string;
  tags: Uint8Array;
  content: string;
  sig: Uint8Array;
}

/** Row shape for the reshare_events table (kind is always 5, not selected). */
interface ReshareEventRowShape {
  id: Uint8Array;
  pubkey: Uint8Array;
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
  constructor(
    private readonly db: DatabasePort,
    private readonly retentionSec: number = DEFAULT_RETENTION_SEC,
  ) {}

  /**
   * Version-gated, idempotent migration runner.
   *
   * - `schema_version` is bootstrapped with CREATE TABLE IF NOT EXISTS (not
   *   a numbered migration) and MAX(version) is read as the current level.
   * - v >= 5: no-op (re-running migrate on an up-to-date DB is safe).
   * - v == 4: apply 005 (reshare events table).
   * - v == 0: legacy pre-versioning DBs are detected via sqlite_master:
   *   no `events` table -> fresh install (apply 001, 002, 003, 004, 005);
   *   `events` without `world_confirmed` -> 001-only install (apply 002,
   *   003, 004, 005); both present -> 002-era install (apply 003, 004,
   *   005 only; re-running 002's plain CREATE TABLE would throw).
   * - v == 1: apply 002, 003, 004, 005. v == 2: apply 003, 004, 005.
   *   v == 3: apply 004, 005.
   * - Each numbered migration runs inside a transaction (BEGIN IMMEDIATE;
   *   COMMIT; ROLLBACK + rethrow on error) together with its version row,
   *   so a kill between the DDL commit and the version insert cannot
   *   brick the store: re-running a migration whose tables already exist
   *   is safe (IF NOT EXISTS) and records the missing version row.
   *   A failed upgrade records no version row and can be retried.
   */
  static async migrate(db: DatabasePort): Promise<void> {
    await db.exec(
      `CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    const vRows = await db.query<{ v: number | null }>(
      `SELECT MAX(version) AS v FROM schema_version`,
    );
    const v = vRows.length > 0 && vRows[0].v != null ? vRows[0].v : 0;

    const applyMigration = async (version: number, script: string): Promise<void> => {
      // PRAGMAs (e.g. journal_mode in 001) cannot run inside a transaction;
      // hoist them out and wrap the DDL/DML remainder atomically.
      const stmts = splitStatements(script);
      for (const s of stmts.filter((stmt) => /^pragma\b/i.test(stmt))) {
        await db.exec(s);
      }
      // The version row lives inside the same transaction as the DDL, so
      // a kill mid-migration leaves either neither or both on disk. A
      // later migrate then resumes instead of re-applying DDL over
      // tables that already exist (002/004 are IF NOT EXISTS as well).
      await runTransaction(db, async () => {
        for (const s of stmts.filter((stmt) => !/^pragma\b/i.test(stmt))) {
          await db.exec(s);
        }
        await db.exec(
          `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`,
          [version, Math.floor(Date.now() / 1000)],
        );
      });
    };

    if (v >= 5) return;
    if (v === 4) {
      await applyMigration(5, MIGRATION_005);
      return;
    }
    if (v === 0) {
      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'world_confirmed')`,
      );
      const names = new Set(tables.map((t) => t.name));
      if (!names.has('events')) {
        await applyMigration(1, MIGRATION_001);
        await applyMigration(2, MIGRATION_002);
      } else if (!names.has('world_confirmed')) {
        await applyMigration(2, MIGRATION_002);
      }
      // else: 002-era legacy DB - 001+002 already applied, skip to 003.
      await applyMigration(3, MIGRATION_003);
      await applyMigration(4, MIGRATION_004);
      await applyMigration(5, MIGRATION_005);
      return;
    }
    if (v === 1) {
      await applyMigration(2, MIGRATION_002);
      await applyMigration(3, MIGRATION_003);
      await applyMigration(4, MIGRATION_004);
      await applyMigration(5, MIGRATION_005);
      return;
    }
    if (v === 2) {
      await applyMigration(3, MIGRATION_003);
      await applyMigration(4, MIGRATION_004);
      await applyMigration(5, MIGRATION_005);
      return;
    }
    // v === 3 falls through: only 004 and 005 remain.
    await applyMigration(4, MIGRATION_004);
    await applyMigration(5, MIGRATION_005);
  }

  async saveEvent(e: SignedEvent): Promise<void> {
    const authorHex = bytesToHex(e.pubkey);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = e.created_at + this.retentionSec;
    await runTransaction(this.db, async () => {
      // Tombstone-wins: a tombstone row armed before the post arrived
      // deletes it when its author matches the arriving event's author, or
      // when the trusted markDeleted primitive armed the zero-length 'any'
      // sentinel.
      const tombRows = await this.db.query<{ author: Uint8Array }>(
        `SELECT author FROM tombstones WHERE target_id = ?`,
        [e.id],
      );
      const deleted = tombRows.some(
        (r) => r.author.length === 0 || bytesToHex(r.author) === authorHex,
      )
        ? 1
        : 0;
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
        if (target) await this.applyTombstone(e, target, now);
      }
    });
  }

  /**
   * Record a tombstone and honor it ONLY when its author pubkey matches the
   * target post's author pubkey. A forged/mismatched tombstone is stored
   * (relay/dedup integrity) but deletes nothing; a late-arriving post
   * re-checks the tombstones table in saveEvent (authorship-gated).
   */
  private async applyTombstone(tomb: SignedEvent, target: Hex64, now: number): Promise<void> {
    const key = target.toLowerCase();
    const authorHex = bytesToHex(tomb.pubkey);
    const targetBytes = hexToBytes(key);
    await this.db.exec(
      `INSERT INTO tombstones (target_id, author, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_id, author) DO NOTHING`,
      [targetBytes, tomb.pubkey, now],
    );
    const rows = await this.db.query<{ pubkey: Uint8Array }>(
      `SELECT pubkey FROM events WHERE id = ?`,
      [targetBytes],
    );
    if (rows.length > 0 && bytesToHex(rows[0].pubkey) === authorHex) {
      await this.db.exec(`UPDATE events SET deleted = 1 WHERE id = ?`, [targetBytes]);
    }
  }

  /**
   * Reshare events (kind 5) live in their own table: the events table
   * CHECK forbids kind 5, and reshare rows must never enter the feed
   * query or the World-sync unconfirmed set. INSERT OR IGNORE keeps the
   * save idempotent by id (re-saving is a no-op, never a clobber).
   */
  async saveReshareEvent(e: SignedEvent): Promise<void> {
    if (e.kind !== 5) {
      throw new Error(`saveReshareEvent: expected kind 5, got kind ${e.kind}`);
    }
    const target = taggedPostId(e);
    if (!target) {
      throw new Error('saveReshareEvent: reshare has no ["e", postId] tag');
    }
    const now = Math.floor(Date.now() / 1000);
    await this.db.exec(
      `INSERT OR IGNORE INTO reshare_events
       (id, pubkey, created_at, geohash, target_id, tags, content, sig, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.pubkey, e.created_at, e.geohash, hexToBytes(target), encodeTags(e.tags), e.content, e.sig, now],
    );
  }

  /** All stored reshare events, oldest first (rehydration replay order). */
  async listReshareEvents(): Promise<SignedEvent[]> {
    const rows = await this.db.query<ReshareEventRowShape>(
      `SELECT id, pubkey, created_at, geohash, tags, content, sig
       FROM reshare_events ORDER BY created_at ASC, id ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      pubkey: row.pubkey,
      created_at: row.created_at,
      kind: 5 as const,
      geohash: row.geohash,
      tags: decodeTags(row.tags),
      content: row.content,
      sig: row.sig,
    }));
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
    if (opts.beforeId !== undefined && opts.before === undefined) {
      throw new Error('listFeed: beforeId requires before');
    }
    const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const placeholders = opts.cells.map(() => '?').join(', ');
    const params: unknown[] = [now, ...opts.cells];
    let cursor = `AND (? IS NULL OR e.created_at < ?)`;
    if (opts.beforeId !== undefined) {
      // (created_at, id) tuple cursor: only rows strictly older than
      // (before, beforeId). BLOB id comparison is byte-wise, valid for
      // fixed 32-byte ids.
      cursor = `AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))`;
      params.push(opts.before, opts.before, hexToBytes(opts.beforeId));
    } else {
      params.push(opts.before ?? null, opts.before ?? null);
    }
    params.push(opts.limit);
    const rows = await this.db.query<EventRowShape & { views: number }>(
      `SELECT e.id, e.pubkey, e.kind, e.created_at, e.geohash, e.tags,
              e.content, e.sig, COALESCE(v.views, 0) AS views
       FROM events e
       LEFT JOIN view_counts v ON v.post_id = e.id
       WHERE e.kind = 1
         AND e.deleted = 0
         AND e.expires_at > ?
         AND e.geohash IN (${placeholders})
         ${cursor}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
      params,
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
    const idBytes = hexToBytes(key);
    const now = Math.floor(Date.now() / 1000);
    // Trusted primitive: arms the zero-length-author 'any' sentinel, which
    // applies to whatever post arrives with this id (tombstone-wins LWW).
    // Always armed, even when the post row doesn't exist yet - covers
    // post-arrives-later.
    await runTransaction(this.db, async () => {
      await this.db.exec(`UPDATE events SET deleted = 1 WHERE id = ?`, [idBytes]);
      await this.db.exec(
        `INSERT INTO tombstones (target_id, author, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(target_id, author) DO NOTHING`,
        [idBytes, new Uint8Array(0), now],
      );
    });
  }

  async saveReceipt(r: SignedEvent): Promise<boolean> {
    if (r.kind !== 2) {
      throw new Error(`saveReceipt: expected kind 2, got kind ${r.kind}`);
    }
    const postId = taggedPostId(r);
    if (!postId) throw new Error('saveReceipt: receipt has no ["e", postId] tag');
    const dayBucket = Math.floor(r.created_at / RECEIPT_DAY_BUCKET_SEC);
    const now = Math.floor(Date.now() / 1000);
    try {
      return await runTransaction(this.db, async () => {
        const dup = await this.db.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM receipts
           WHERE pubkey = ? AND post_id = ? AND day_bucket = ?`,
          [r.pubkey, hexToBytes(postId), dayBucket],
        );
        if (dup.length > 0 && dup[0].n > 0) return false;

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
      });
    } catch (e) {
      // TOCTOU guard: a concurrent saveReceipt won the (pubkey, post, day)
      // race between our dedup SELECT and INSERT. The transaction rolled
      // back; the receipt is a duplicate, so report false, never throw.
      if (e instanceof Error && /UNIQUE|PRIMARY/i.test(e.message)) return false;
      throw e;
    }
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
    // "Absent keeps previous": the raw lastSeen (possibly NULL) drives the
    // conflict clause via COALESCE, while the INSERT path falls back to now
    // to satisfy the NOT NULL columns on first insert. earliest first_seen
    // wins via min(); rssi always takes the new value.
    const lastSeen: number | null = p.lastSeenSec ?? null;
    await this.db.exec(
      `INSERT INTO peers (peer_id, first_seen, last_seen, rssi, mtu, platform)
       VALUES (?, COALESCE(?, ?), COALESCE(?, ?), ?, NULL, NULL)
       ON CONFLICT(peer_id) DO UPDATE SET
         first_seen = min(peers.first_seen, COALESCE(?, peers.first_seen)),
         last_seen = COALESCE(?, peers.last_seen),
         rssi = excluded.rssi`,
      [p.peerId, lastSeen, now, lastSeen, now, p.rssi ?? null, lastSeen, lastSeen],
    );
  }

  async pruneExpired(nowSec: UnixSec): Promise<number> {
    // One transaction covering every table, so a kill mid-prune cannot
    // leave receipts deleted but events present (or orphaned view
    // counts). The count is measured inside the same transaction, so
    // concurrent inserts cannot skew it. Star, reshare, receipt,
    // confirmation, tombstone, and known-post rows are removed only
    // when their target post expired: rows for still-live posts are
    // never wiped by age alone, and a tombstone armed before its post
    // arrives (no events row yet) must survive prune, or the deleted
    // post would resurrect on arrival. View counts are the exception:
    // they are dropped when no events row remains, since a count for a
    // post with no row can never be displayed.
    return runTransaction(this.db, async () => {
      const count = await this.db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events WHERE expires_at < ?`,
        [nowSec],
      );
      const expired = `SELECT id FROM events WHERE expires_at < ?`;
      await this.db.exec(
        `DELETE FROM star_events WHERE target_id IN (${expired})`,
        [nowSec],
      );
      await this.db.exec(
        `DELETE FROM reshare_events WHERE target_id IN (${expired})`,
        [nowSec],
      );
      await this.db.exec(
        `DELETE FROM receipts WHERE post_id IN (${expired})`,
        [nowSec],
      );
      await this.db.exec(
        `DELETE FROM world_confirmed WHERE event_id IN (${expired})`,
        [nowSec],
      );
      await this.db.exec(
        `DELETE FROM tombstones WHERE target_id IN (${expired})`,
        [nowSec],
      );
      await this.db.exec(
        `DELETE FROM star_known_posts WHERE post_id IN (${expired})`,
        [nowSec],
      );
      await this.db.exec(`DELETE FROM events WHERE expires_at < ?`, [nowSec]);
      await this.db.exec(
        `DELETE FROM view_counts
         WHERE post_id NOT IN (SELECT id FROM events)`,
        [],
      );
      return count.length > 0 ? count[0].n : 0;
    });
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

  async listWorldConfirmed(ids: Hex64[]): Promise<Set<Hex64>> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await this.db.query<{ event_id: Uint8Array }>(
      `SELECT event_id FROM world_confirmed WHERE event_id IN (${placeholders})`,
      ids.map((id) => hexToBytes(id.toLowerCase())),
    );
    return new Set(rows.map((r) => bytesToHex(r.event_id)));
  }

  async getUnconfirmed(): Promise<Hex64[]> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.db.query<{ id: Uint8Array }>(
      `SELECT e.id AS id FROM events e
       WHERE e.kind = 1 AND e.deleted = 0 AND e.expires_at > ?
         AND NOT EXISTS (
           SELECT 1 FROM world_confirmed w WHERE w.event_id = e.id
         )`,
      [now],
    );
    return rows.map((r) => bytesToHex(r.id));
  }

  // ------------------------------------------------------------------
  // Stars (T17): durable kind-4 events + known posts (MIGRATION_004).
  // Callers verify the signature before saveStarEvent; the store trusts
  // that, exactly as saveEvent trusts its callers for other kinds.
  // ------------------------------------------------------------------

  async saveStarEvent(e: SignedEvent): Promise<void> {
    const target = taggedPostId(e);
    if (target === null) return;
    await this.db.exec(
      `INSERT INTO star_events
         (event_id, pubkey, target_id, created_at, geohash, tags, content, sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
      [
        e.id, e.pubkey, hexToBytes(target), e.created_at, e.geohash,
        encodeTags(e.tags), e.content, e.sig,
      ],
    );
  }

  async saveStarKnownPost(postId: Hex64): Promise<void> {
    await this.db.exec(
      `INSERT INTO star_known_posts (post_id) VALUES (?)
       ON CONFLICT(post_id) DO NOTHING`,
      [hexToBytes(postId)],
    );
  }

  async listStarEvents(): Promise<SignedEvent[]> {
    const rows = await this.db.query<StarEventRowShape>(
      `SELECT event_id, pubkey, created_at, geohash, tags, content, sig
       FROM star_events ORDER BY created_at ASC, event_id ASC`,
    );
    return rows.map((row) => ({
      id: row.event_id,
      pubkey: row.pubkey,
      created_at: row.created_at,
      kind: EVENT_KIND_STAR,
      geohash: row.geohash,
      tags: decodeTags(row.tags),
      content: row.content,
      sig: row.sig,
    }));
  }

  async listStarKnownPosts(): Promise<Hex64[]> {
    const rows = await this.db.query<{ post_id: Uint8Array }>(
      `SELECT post_id FROM star_known_posts`,
    );
    return rows.map((r) => bytesToHex(r.post_id));
  }
}
