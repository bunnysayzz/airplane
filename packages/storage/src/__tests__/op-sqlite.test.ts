// SPDX-License-Identifier: Apache-2.0
// OpSqliteStore behavior tests against node:sqlite (real SQL, no mocks).
//
// A small async DatabasePort adapter wraps DatabaseSync. Most tests use the
// adapter WITHOUT a native transaction so the driver's BEGIN IMMEDIATE /
// COMMIT / ROLLBACK emulation path is exercised; one test enables the native
// path.

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SignedEvent, Hex64 } from '@airplane/protocol';
import { NobleCrypto, StarCounter, createStarEvent, createUnstarEvent } from '@airplane/protocol';
import type { DatabasePort } from '../ports';
import { OpSqliteStore, splitStatements } from '../op-sqlite';
import { MIGRATION_001, MIGRATION_002 } from '../schema';
import { bytesToHex, hexToBytes } from '../memory';

type BindParam = string | number | bigint | Uint8Array | null;

/** Minimal async DatabasePort over node:sqlite's synchronous API. */
function makePort(db: DatabaseSync, nativeTx: boolean): DatabasePort {
  const port: DatabasePort = {
    exec: async (sql: string, params: unknown[] = []): Promise<void> => {
      if (params.length === 0) {
        db.exec(sql); // multi-statement DDL scripts
      } else {
        db.prepare(sql).run(...(params as BindParam[]));
      }
    },
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      db.prepare(sql).all(...(params as BindParam[])) as T[],
  };
  if (nativeTx) {
    port.transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already ended; the original error matters.
        }
        throw e;
      }
    };
  }
  return port;
}

function seedBytes(seed: number, len = 32): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed + i * 7) & 0xff;
  return b;
}

interface FixtureOpts {
  seed: number;
  kind?: 1 | 2 | 3 | 4 | 5;
  geohash?: string;
  createdAt?: number;
  tags?: string[][];
  content?: string;
  pubkey?: Uint8Array;
}

function makeEvent(o: FixtureOpts): SignedEvent {
  return {
    id: seedBytes(o.seed),
    pubkey: o.pubkey ?? seedBytes(o.seed + 1000),
    created_at: o.createdAt ?? Math.floor(Date.now() / 1000),
    kind: o.kind ?? 1,
    geohash: o.geohash ?? 'tdr1v',
    tags: o.tags ?? [],
    content: o.content ?? 'hello world',
    sig: seedBytes(o.seed + 2000, 64),
  };
}

function makeReceipt(seed: number, postId: Hex64, createdAt: number): SignedEvent {
  return makeEvent({ seed, kind: 2, tags: [['e', postId]], content: '', createdAt });
}

const NOW = Math.floor(Date.now() / 1000);

const openDbs: DatabaseSync[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()!.close();
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Raw-SQL event insert: simulates data written by a pre-003 app version. */
async function legacyInsertEvent(port: DatabasePort, e: SignedEvent): Promise<void> {
  await port.exec(
    `INSERT INTO events
       (id, pubkey, kind, created_at, geohash, tags, content, sig,
        received_at, expires_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      e.id, e.pubkey, e.kind, e.created_at, e.geohash,
      new TextEncoder().encode(JSON.stringify(e.tags)),
      e.content, e.sig,
      NOW, e.created_at + 24 * 3600,
    ],
  );
}

async function migratedDb(nativeTx = false): Promise<{ db: DatabaseSync; port: DatabasePort }> {
  const db = new DatabaseSync(':memory:');
  openDbs.push(db);
  const port = makePort(db, nativeTx);
  await OpSqliteStore.migrate(port);
  return { db, port };
}

async function schemaVersion(port: DatabasePort): Promise<number[]> {
  const rows = await port.query<{ version: number }>(
    `SELECT version FROM schema_version ORDER BY version`,
  );
  return rows.map((r) => r.version);
}

describe('migrate', () => {
  test('idempotent: running twice is a no-op, MAX(version) = 6', async () => {
    const { port } = await migratedDb();
    await OpSqliteStore.migrate(port);
    await OpSqliteStore.migrate(port);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
    const max = await port.query<{ v: number }>(`SELECT MAX(version) AS v FROM schema_version`);
    expect(max[0].v).toBe(6);
    // Tables from all six migrations exist.
    for (const t of ['events', 'world_confirmed', 'tombstones', 'star_events', 'star_known_posts', 'reshare_events', 'schema_version']) {
      const rows = await port.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [t],
      );
      expect(rows).toHaveLength(1);
    }
  });

  test('upgrade path: legacy 001-only DB keeps its data, reaches version 6', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    // Simulate a pre-versioning install: 001 statements only, no schema_version.
    for (const stmt of splitStatements(MIGRATION_001)) {
      await port.exec(stmt);
    }
    const store = new OpSqliteStore(port);
    const e = makeEvent({ seed: 101, content: 'legacy post' });
    await legacyInsertEvent(port, e); // written by the old app version

    await OpSqliteStore.migrate(port);

    expect(await schemaVersion(port)).toEqual([2, 3, 4, 5, 6]); // 001 was legacy, not re-recorded
    const got = await store.getEvent(bytesToHex(e.id));
    expect(got).not.toBeNull();
    expect(got!.content).toBe('legacy post'); // no data wipe
    expect(
      await port.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'world_confirmed'`),
    ).toHaveLength(1);
    expect(
      await port.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tombstones'`),
    ).toHaveLength(1);
    expect(
      await port.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'star_events'`),
    ).toHaveLength(1);
    expect(
      await port.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reshare_events'`),
    ).toHaveLength(1);
  });

  test('legacy detection does not wipe a 002-era DB (old migrate ran 001+002)', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    for (const stmt of splitStatements(MIGRATION_001 + MIGRATION_002)) {
      await port.exec(stmt);
    }
    const store = new OpSqliteStore(port);
    const e = makeEvent({ seed: 102, content: 'era-002 post' });
    await legacyInsertEvent(port, e); // written by the old app version
    await port.exec(`INSERT INTO world_confirmed (event_id, confirmed_at) VALUES (?, ?)`, [
      e.id,
      NOW,
    ]);

    await expect(OpSqliteStore.migrate(port)).resolves.toBeUndefined();

    expect(await schemaVersion(port)).toEqual([3, 4, 5, 6]);
    const got = await store.getEvent(bytesToHex(e.id));
    expect(got!.content).toBe('era-002 post');
    expect(await store.isWorldConfirmed(bytesToHex(e.id))).toBe(true);
  });

  test('missing version row resumes gracefully: tables exist, migrate re-records', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    await OpSqliteStore.migrate(port); // v6, healthy
    // Simulate a kill after the 004 DDL committed but before its version
    // row landed: drop the 004, 005, and 006 rows so MAX(version) drops
    // to 3. Re-running migrate must succeed (IF NOT EXISTS) and re-record.
    await port.exec(`DELETE FROM schema_version WHERE version = 4`);
    await port.exec(`DELETE FROM schema_version WHERE version = 5`);
    await port.exec(`DELETE FROM schema_version WHERE version = 6`);
    await expect(OpSqliteStore.migrate(port)).resolves.toBeUndefined();
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
    const store = new OpSqliteStore(port);
    const e = makeEvent({ seed: 103 });
    await expect(store.getEvent(bytesToHex(e.id))).resolves.toBeNull();
  });

  test('kill between 002 DDL and version row resumes without losing data', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    // v1 install: 001 applied, version row 1 recorded, 002 DDL applied
    // but its version row never landed, with a confirmed id already stored.
    for (const stmt of splitStatements(MIGRATION_001)) {
      await port.exec(stmt);
    }
    await port.exec(
      `CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
    );
    await port.exec(`INSERT INTO schema_version (version, applied_at) VALUES (1, ?)`, [NOW]);
    for (const stmt of splitStatements(MIGRATION_002)) {
      await port.exec(stmt);
    }
    const e = makeEvent({ seed: 104 });
    await port.exec(`INSERT INTO world_confirmed (event_id, confirmed_at) VALUES (?, ?)`, [
      e.id,
      NOW,
    ]);
    await expect(OpSqliteStore.migrate(port)).resolves.toBeUndefined();
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
    const store = new OpSqliteStore(port);
    expect(await store.isWorldConfirmed(bytesToHex(e.id))).toBe(true);
  });

  test('MIGRATION_006 creates the feed index matching the real sort', async () => {
    const { port } = await migratedDb();
    const rows = await port.query<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_feed_v2'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sql).toContain('created_at DESC');
    expect(rows[0].sql).toContain('id DESC');
    // The old index is kept alongside it.
    const old = await port.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_feed'`,
    );
    expect(old).toHaveLength(1);
  });

  test('splitStatements respects semicolons inside strings and comments', async () => {
    const stmts = splitStatements(
      `CREATE TABLE t(a TEXT DEFAULT 'x;y'); -- a ; comment\n` +
        `CREATE TABLE u(b TEXT DEFAULT 'it''s; fine'); /* block ; comment */ ` +
        `CREATE TABLE v(c INT);`,
    );
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain(`'x;y'`);
    expect(stmts[1]).toContain(`'it''s; fine'`);
    expect(stmts[2]).toContain('CREATE TABLE v');
  });

  test('concurrent migrate calls on one port share a single run', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    await Promise.all([OpSqliteStore.migrate(port), OpSqliteStore.migrate(port)]);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
    // A later migrate after the shared run settles still works.
    await OpSqliteStore.migrate(port);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a database from a newer build fails fast with a clear error', async () => {
    const { port } = await migratedDb();
    await port.exec(`INSERT INTO schema_version (version, applied_at) VALUES (7, ?)`, [NOW]);
    await expect(OpSqliteStore.migrate(port)).rejects.toThrow(
      /database version 7 is newer than this app supports \(max 6\)/,
    );
  });

  test('MIGRATION_006 drops the unused indexes but keeps the reserved tables', async () => {
    const { port } = await migratedDb();
    for (const idx of ['idx_peers_seen', 'idx_seen_at', 'idx_logs_ts', 'idx_world_confirmed_at']) {
      const rows = await port.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`,
        [idx],
      );
      expect(rows).toHaveLength(0);
    }
    for (const t of ['peers', 'sync_state', 'seen', 'frag_buf', 'logs']) {
      const rows = await port.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [t],
      );
      expect(rows).toHaveLength(1);
    }
  });

  test('failed 003 migration rolls back and records no version row', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    await OpSqliteStore.migrate(port); // v6, healthy
    // Force a re-migration of 003 by deleting its version row (and the
    // later 004, 005, and 006 rows, so the runner re-enters the upgrade
    // path instead of returning early): the CREATE TABLE must fail and
    // roll back, since the tombstones table already exists.
    await port.exec(`DELETE FROM schema_version WHERE version = 3`);
    await port.exec(`DELETE FROM schema_version WHERE version = 4`);
    await port.exec(`DELETE FROM schema_version WHERE version = 5`);
    await port.exec(`DELETE FROM schema_version WHERE version = 6`);
    await expect(OpSqliteStore.migrate(port)).rejects.toThrow(/already exists/i);
    expect(await schemaVersion(port)).toEqual([1, 2]); // 003 not recorded
    // Earlier migrations' data still intact.
    const store = new OpSqliteStore(port);
    const e = makeEvent({ seed: 104 });
    await expect(store.getEvent(bytesToHex(e.id))).resolves.toBeNull();
  });
});

describe('saveEvent / getEvent', () => {
  test('misrouted kind 4/5 events fail with a routing error, not a CHECK error', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    await expect(store.saveEvent(makeEvent({ seed: 95, kind: 4 }))).rejects.toThrow(
      /saveStarEvent for kind 4/,
    );
    await expect(store.saveEvent(makeEvent({ seed: 96, kind: 5 }))).rejects.toThrow(
      /saveReshareEvent for kind 5/,
    );
  });

  test('round-trip and upsert idempotence (first write wins)', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const e = makeEvent({ seed: 1, content: 'first post' });
    await store.saveEvent(e);
    await store.saveEvent(e);
    await store.saveEvent({ ...e, content: 'mutated' });
    const got = await store.getEvent(bytesToHex(e.id));
    expect(got).not.toBeNull();
    expect(got!.content).toBe('first post');
    expect(got!.geohash).toBe('tdr1v');
    expect(bytesToHex(got!.id)).toBe(bytesToHex(e.id));
    expect(await store.getEvent('ab'.repeat(32))).toBeNull();
    // Uppercase id hex resolves.
    expect(await store.getEvent(bytesToHex(e.id).toUpperCase())).not.toBeNull();
  });

  test('driver-emulated and native transactions both work', async () => {
    for (const nativeTx of [false, true]) {
      const { port } = await migratedDb(nativeTx);
      const store = new OpSqliteStore(port);
      const e = makeEvent({ seed: 200 + (nativeTx ? 1 : 0) });
      await store.saveEvent(e);
      expect(await store.getEvent(bytesToHex(e.id))).not.toBeNull();
    }
  });

  test('concurrent saveEvent calls serialize: a relay burst loses nothing', async () => {
    // Emulated transactions only: this is the path that used to fail the
    // second BEGIN while the first transaction was still open.
    const { port } = await migratedDb(false);
    const store = new OpSqliteStore(port);
    const events = Array.from({ length: 20 }, (_, i) => makeEvent({ seed: 300 + i }));
    await Promise.all(events.map((e) => store.saveEvent(e)));
    for (const e of events) {
      expect(await store.getEvent(bytesToHex(e.id))).not.toBeNull();
    }
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 50, nowSec: NOW });
    expect(feed).toHaveLength(20);
  });
});

describe('tombstones', () => {
  test('tombstone-wins across restart: markDeleted before post arrives, new store over same file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-op-sqlite-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'airplane.db');
    const postId = bytesToHex(seedBytes(50));

    // "First boot": tombstone armed before the post exists.
    {
      const db = new DatabaseSync(file);
      const port = makePort(db, false);
      await OpSqliteStore.migrate(port);
      const store = new OpSqliteStore(port);
      await store.markDeleted(postId);
      db.close();
    }

    // "Restart": brand-new store over the same file; the post arrives late.
    {
      const db = new DatabaseSync(file);
      openDbs.push(db);
      const port = makePort(db, false);
      await OpSqliteStore.migrate(port);
      const store = new OpSqliteStore(port);
      const post = makeEvent({ seed: 50 });
      expect(bytesToHex(post.id)).toBe(postId);
      await store.saveEvent(post);
      // Hidden from the feed - the tombstone survived the restart.
      expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
      // The post row still exists, flagged deleted (no resurrection).
      expect(await store.getEvent(postId)).not.toBeNull();
    }
  });

  test('kind-3 tombstone from the post author deletes; forged one is stored but not honored', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const post = makeEvent({ seed: 3 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);

    // ACCEPT: author's own tombstone.
    const tomb = makeEvent({
      seed: 4,
      kind: 3,
      tags: [['e', postId]],
      content: '',
      pubkey: post.pubkey,
    });
    await store.saveEvent(tomb);
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
    expect(await store.getEvent(postId)).not.toBeNull();

    // REJECT: forged tombstone from a different key on a second post.
    const post2 = makeEvent({ seed: 30 });
    const post2Id = bytesToHex(post2.id);
    await store.saveEvent(post2);
    const forged = makeEvent({
      seed: 31,
      kind: 3,
      tags: [['e', post2Id]],
      content: '',
      pubkey: seedBytes(9999),
    });
    await store.saveEvent(forged);
    // Stored as an event (relay integrity) but the post stays visible.
    expect(await store.getEvent(bytesToHex(forged.id))).not.toBeNull();
    const tombRows = await port.query<{ target_id: Uint8Array; author: Uint8Array }>(
      `SELECT target_id, author FROM tombstones WHERE target_id = ?`,
      [hexToBytes(post2Id)],
    );
    expect(tombRows).toHaveLength(1); // stored...
    expect(bytesToHex(tombRows[0].author)).toBe(bytesToHex(seedBytes(9999)));
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1); // ...not honored
  });

  test('pending kind-3 tombstone honored only when the late post author matches', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    // ACCEPT: same author.
    const authorPubkey = seedBytes(5001);
    const postId = bytesToHex(seedBytes(50));
    await store.saveEvent(
      makeEvent({ seed: 51, kind: 3, tags: [['e', postId]], content: '', pubkey: authorPubkey }),
    );
    await store.saveEvent(makeEvent({ seed: 50, pubkey: authorPubkey }));
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
    // REJECT: different author on the late post.
    const postId2 = bytesToHex(seedBytes(60));
    await store.saveEvent(
      makeEvent({ seed: 61, kind: 3, tags: [['e', postId2]], content: '', pubkey: seedBytes(6001) }),
    );
    await store.saveEvent(makeEvent({ seed: 60, pubkey: seedBytes(6002) }));
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);
  });
});

describe('saveReceipt', () => {
  test('same receipt twice: second returns false, no throw; views counted once', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const post = makeEvent({ seed: 6 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);

    const day = NOW - (NOW % 86400);
    const r1 = makeReceipt(7, postId, day + 100);
    expect(await store.saveReceipt(r1)).toBe(true);
    expect(await store.saveReceipt(r1)).toBe(false); // exact duplicate, no throw
    const r1b = makeReceipt(8, postId, day + 200);
    r1b.pubkey = r1.pubkey.slice(); // same device, same day, new id
    expect(await store.saveReceipt(r1b)).toBe(false);
    expect(await store.countViews(postId)).toBe(1);

    const r2 = makeReceipt(9, postId, day + 86400 + 100); // next day
    expect(await store.saveReceipt(r2)).toBe(true);
    expect(await store.countViews(postId)).toBe(2);
  });

  test('concurrent receipts for one bucket: exactly one counts, rest report duplicate', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const post = makeEvent({ seed: 6 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);
    const day = NOW - (NOW % 86400);
    const base = makeReceipt(7, postId, day + 100);
    const attempts = Array.from({ length: 5 }, (_, i) => {
      const r = makeReceipt(20 + i, postId, day + 100);
      r.pubkey = base.pubkey.slice();
      return r;
    });
    const results = await Promise.all(attempts.map((r) => store.saveReceipt(r)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.countViews(postId)).toBe(1);
  });

  test('rejects non-receipt kinds and tagless receipts', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    await expect(store.saveReceipt(makeEvent({ seed: 11, kind: 1 }))).rejects.toThrow(/kind 2/);
    await expect(store.saveReceipt(makeEvent({ seed: 12, kind: 2, tags: [] }))).rejects.toThrow(
      /no \["e", postId\] tag/,
    );
  });
});

describe('listFeed', () => {
  test('identical created_at rows order deterministically by id DESC', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port, 24 * 3600);
    const ts = NOW - 100;
    // seedBytes(10) sorts byte-wise below seedBytes(20): id DESC => seed 20 first.
    await store.saveEvent(makeEvent({ seed: 10, createdAt: ts }));
    await store.saveEvent(makeEvent({ seed: 20, createdAt: ts }));
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 10, nowSec: NOW });
    expect(feed).toHaveLength(2);
    expect(bytesToHex(feed[0].event.id)).toBe(bytesToHex(seedBytes(20)));
    expect(bytesToHex(feed[1].event.id)).toBe(bytesToHex(seedBytes(10)));
    // Newest-first across timestamps still holds.
    await store.saveEvent(makeEvent({ seed: 30, createdAt: ts + 50 }));
    const feed2 = await store.listFeed({ cells: ['tdr1v'], limit: 10, nowSec: NOW });
    expect(feed2.map((p) => bytesToHex(p.event.id))).toEqual([
      bytesToHex(seedBytes(30)),
      bytesToHex(seedBytes(20)),
      bytesToHex(seedBytes(10)),
    ]);
  });

  test('before/beforeId pagination returns each row exactly once', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port, 24 * 3600);
    const ts = NOW - 100;
    for (const seed of [1, 2, 3, 4, 5]) {
      await store.saveEvent(makeEvent({ seed, createdAt: ts }));
    }
    const seen: string[] = [];
    let before: number | undefined;
    let beforeId: Hex64 | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await store.listFeed({ cells: ['tdr1v'], limit: 2, before, beforeId, nowSec: NOW });
      if (rows.length === 0) break;
      for (const r of rows) seen.push(bytesToHex(r.event.id));
      const last = rows[rows.length - 1].event;
      before = last.created_at;
      beforeId = bytesToHex(last.id);
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // each row exactly once
  });

  test('beforeId without before throws', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    await expect(
      store.listFeed({ cells: ['tdr1v'], limit: 10, beforeId: 'ab'.repeat(32) }),
    ).rejects.toThrow(/beforeId requires before/);
  });

  test('one corrupt tags blob does not fail the whole feed page', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const good = makeEvent({ seed: 71 });
    await store.saveEvent(good);
    const bad = makeEvent({ seed: 72 });
    await port.exec(
      `INSERT INTO events
         (id, pubkey, kind, created_at, geohash, tags, content, sig,
          received_at, expires_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        bad.id, bad.pubkey, bad.kind, bad.created_at, bad.geohash,
        new TextEncoder().encode('not-json{{'),
        bad.content, bad.sig, NOW, bad.created_at + 24 * 3600,
      ],
    );
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 10, nowSec: NOW });
    expect(feed).toHaveLength(1);
    expect(bytesToHex(feed[0].event.id)).toBe(bytesToHex(good.id));
    expect(await store.getEvent(bytesToHex(bad.id))).toBeNull();
    // Corrupt star rows are skipped the same way, not page-failing.
    await port.exec(
      `INSERT INTO star_events
         (event_id, pubkey, target_id, created_at, geohash, tags, content, sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seedBytes(73), seedBytes(1073), good.id, NOW, 'tdr1v',
        new TextEncoder().encode('not-json{{'), '', seedBytes(2073, 64),
      ],
    );
    expect(await store.listStarEvents()).toHaveLength(0);
  });

  test('expired posts are invisible to the feed even before pruning', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port, 60);
    await store.saveEvent(makeEvent({ seed: 18, createdAt: NOW - 3600 }));
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10, nowSec: NOW })).toHaveLength(0);
  });
});

describe('pruneExpired', () => {
  test('removes post + its receipts + view_counts', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port, 3600);
    const oldPost = makeEvent({ seed: 15, createdAt: NOW - 7200 });
    const oldId = bytesToHex(oldPost.id);
    const freshPost = makeEvent({ seed: 16, createdAt: NOW - 100 });
    const freshId = bytesToHex(freshPost.id);
    await store.saveEvent(oldPost);
    await store.saveEvent(freshPost);
    await store.saveReceipt(makeReceipt(17, oldId, NOW - 7100));
    await store.saveReceipt(makeReceipt(18, freshId, NOW - 50));
    expect(await store.countViews(oldId)).toBe(1);
    expect(await store.countViews(freshId)).toBe(1);

    const removed = await store.pruneExpired(NOW);
    expect(removed).toBe(2); // 1 expired post + 1 orphaned receipt event
    expect(await store.getEvent(oldId)).toBeNull();
    expect(await store.getEvent(freshId)).not.toBeNull();
    expect(await store.countViews(oldId)).toBe(0);
    expect(await store.countViews(freshId)).toBe(1);
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);
  });

  test('prunes star, reshare, confirmation, tombstone, and known-post rows for expired posts only', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port, 3600);
    const oldPost = makeEvent({ seed: 25, createdAt: NOW - 7200 });
    const oldId = bytesToHex(oldPost.id);
    const freshPost = makeEvent({ seed: 26, createdAt: NOW - 100 });
    const freshId = bytesToHex(freshPost.id);
    await store.saveEvent(oldPost);
    await store.saveEvent(freshPost);
    // Star/reshare events need a valid target tag; build them directly.
    const starFor = (seed: number, postId: string): SignedEvent => ({
      id: seedBytes(seed), pubkey: seedBytes(seed + 1000), created_at: NOW - 100,
      kind: 4, geohash: 'tdr1v', tags: [['e', postId]], content: 'star',
      sig: seedBytes(seed + 2000, 64),
    });
    const reshareFor = (seed: number, postId: string): SignedEvent => ({
      id: seedBytes(seed), pubkey: seedBytes(seed + 1000), created_at: NOW - 100,
      kind: 5, geohash: 'tdr1v', tags: [['e', postId]], content: '',
      sig: seedBytes(seed + 2000, 64),
    });
    await store.saveStarEvent(starFor(27, oldId));
    await store.saveStarEvent(starFor(28, freshId));
    await store.saveReshareEvent(reshareFor(29, oldId));
    await store.saveReshareEvent(reshareFor(30, freshId));
    await store.markWorldConfirmed(oldId);
    await store.markWorldConfirmed(freshId);
    await store.saveStarKnownPost(oldId);
    await store.saveStarKnownPost(freshId);
    await store.markDeleted(oldId);
    // A tombstone armed before its post arrives must survive prune.
    const pendingId = 'c'.repeat(64);
    await store.markDeleted(pendingId);

    await store.pruneExpired(NOW);
    expect(await store.getEvent(oldId)).toBeNull();
    expect(await store.listStarEvents()).toHaveLength(1);
    expect(await store.listReshareEvents()).toHaveLength(1);
    expect(await store.isWorldConfirmed(oldId)).toBe(false);
    expect(await store.isWorldConfirmed(freshId)).toBe(true);
    expect(await store.listStarKnownPosts()).toEqual([freshId]);
    const tombs = await port.query<{ target_id: Uint8Array }>(`SELECT target_id FROM tombstones`);
    expect(tombs.map((t) => bytesToHex(t.target_id)).sort()).toEqual([pendingId]);
  });
});

describe('world confirmation', () => {
  test('mark/is round-trip; idempotent; getUnconfirmed excludes expired posts', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port, 3600);
    const fresh = makeEvent({ seed: 41, createdAt: NOW - 100 });
    const freshId = bytesToHex(fresh.id);
    const expired = makeEvent({ seed: 42, createdAt: NOW - 7200 });
    const expiredId = bytesToHex(expired.id);
    await store.saveEvent(fresh);
    await store.saveEvent(expired);

    expect(await store.isWorldConfirmed(freshId)).toBe(false);
    await store.markWorldConfirmed(freshId);
    expect(await store.isWorldConfirmed(freshId)).toBe(true);
    await store.markWorldConfirmed(freshId.toUpperCase()); // idempotent
    expect(await store.isWorldConfirmed(freshId)).toBe(true);

    // Expired posts are never offered to the sync engine.
    const unconfirmed = await store.getUnconfirmed();
    expect(unconfirmed).not.toContain(expiredId);
  });

  test('getUnconfirmed returns kind-1 posts not yet confirmed', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const p1 = makeEvent({ seed: 51 });
    const p2 = makeEvent({ seed: 52 });
    await store.saveEvent(p1);
    await store.saveEvent(p2);
    await store.saveEvent(makeReceipt(53, bytesToHex(p1.id), NOW)); // receipts excluded

    let unconfirmed = await store.getUnconfirmed();
    expect(unconfirmed).toHaveLength(2);

    await store.markWorldConfirmed(bytesToHex(p1.id));
    unconfirmed = await store.getUnconfirmed();
    expect(unconfirmed).toEqual([bytesToHex(p2.id)]);
  });

  test('listWorldConfirmed returns the confirmed subset in one call', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const p1 = makeEvent({ seed: 61 });
    const p2 = makeEvent({ seed: 62 });
    await store.saveEvent(p1);
    await store.saveEvent(p2);
    await store.markWorldConfirmed(bytesToHex(p1.id));
    const confirmed = await store.listWorldConfirmed([
      bytesToHex(p1.id),
      bytesToHex(p2.id),
    ]);
    expect([...confirmed]).toEqual([bytesToHex(p1.id)]);
    expect(await store.listWorldConfirmed([])).toEqual(new Set());
  });
});

describe('upsertPeer', () => {
  test('absent lastSeen keeps previous; earliest first_seen wins; rssi takes the new value', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    await store.upsertPeer({ peerId: 'aa', rssi: -70, lastSeenSec: 1000 });
    await store.upsertPeer({ peerId: 'aa', rssi: -50 }); // absent: keep previous
    let rows = await port.query<{ first_seen: number; last_seen: number; rssi: number }>(
      `SELECT first_seen, last_seen, rssi FROM peers WHERE peer_id = 'aa'`,
    );
    expect(rows[0]).toEqual({ first_seen: 1000, last_seen: 1000, rssi: -50 });

    await store.upsertPeer({ peerId: 'aa', rssi: -60, lastSeenSec: 900 }); // earlier
    rows = await port.query<{ first_seen: number; last_seen: number; rssi: number }>(
      `SELECT first_seen, last_seen, rssi FROM peers WHERE peer_id = 'aa'`,
    );
    expect(rows[0]).toEqual({ first_seen: 900, last_seen: 900, rssi: -60 });

    // Fresh insert without lastSeenSec does not violate NOT NULL.
    await store.upsertPeer({ peerId: 'bb' });
    const bbRows = await port.query<{ first_seen: number; last_seen: number }>(
      `SELECT first_seen, last_seen FROM peers WHERE peer_id = 'bb'`,
    );
    expect(bbRows[0].first_seen).toBeGreaterThan(0);
    expect(bbRows[0].last_seen).toBeGreaterThan(0);
  });
});

describe('stars (MIGRATION_004)', () => {
  test('upgrade path: versioned v3 DB reaches version 6', async () => {
    const { port } = await migratedDb();
    await port.exec(`DROP TABLE star_events`);
    await port.exec(`DROP TABLE star_known_posts`);
    await port.exec(`DELETE FROM schema_version WHERE version = 4`);
    await port.exec(`DELETE FROM schema_version WHERE version = 5`);
    await port.exec(`DELETE FROM schema_version WHERE version = 6`);
    await OpSqliteStore.migrate(port);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const t of ['star_events', 'star_known_posts']) {
      const rows = await port.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [t],
      );
      expect(rows).toHaveLength(1);
    }
  });

  test('star events + known posts survive restart; counter replay matches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-op-sqlite-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'airplane.db');
    const postId = bytesToHex(seedBytes(60));
    const crypto = new NobleCrypto();
    const keyA = crypto.generateKeypair();
    const keyB = crypto.generateKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    const starA = createStarEvent({
      crypto, secretKey: keyA.secretKey, pubkey: keyA.publicKey,
      geohash5: 'tdr1v', postId: seedBytes(60), createdAt: nowSec,
    });
    const starB = createStarEvent({
      crypto, secretKey: keyB.secretKey, pubkey: keyB.publicKey,
      geohash5: 'tdr1v', postId: seedBytes(60), createdAt: nowSec,
    });
    const unstarA = createUnstarEvent({
      crypto, secretKey: keyA.secretKey, pubkey: keyA.publicKey,
      geohash5: 'tdr1v', postId: seedBytes(60), createdAt: nowSec + 1,
    });

    // "First boot": store the star stream + the known post.
    {
      const db = new DatabaseSync(file);
      const port = makePort(db, false);
      await OpSqliteStore.migrate(port);
      const store = new OpSqliteStore(port);
      await store.saveStarEvent(starA);
      await store.saveStarEvent(starB);
      await store.saveStarEvent(unstarA);
      await store.saveStarEvent(starA); // idempotent re-save
      await store.saveStarKnownPost(postId);
      await store.saveStarKnownPost(postId); // idempotent re-save
      db.close();
    }

    // "Restart": brand-new store over the same file replays the counter.
    {
      const db = new DatabaseSync(file);
      openDbs.push(db);
      const port = makePort(db, false);
      await OpSqliteStore.migrate(port);
      const store = new OpSqliteStore(port);
      const events = await store.listStarEvents();
      expect(events).toHaveLength(3); // re-save did not duplicate
      expect(await store.listStarKnownPosts()).toEqual([postId]);
      const counter = new StarCounter();
      for (const e of events) counter.apply(e, () => true);
      expect(counter.view(postId).count).toBe(0); // nothing known yet: pending
      for (const id of await store.listStarKnownPosts()) counter.markPostKnown(id);
      const view = counter.view(postId, bytesToHex(keyB.publicKey));
      expect(view.count).toBe(1); // B starred, A unstarred (latest-wins)
      expect(view.starredByMe).toBe(true);
      expect(counter.view(postId, bytesToHex(keyA.publicKey)).starredByMe).toBe(false);
    }
  });

  test('uppercase e tags normalize to lowercase instead of dropping or throwing', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const postId = 'B'.repeat(64);
    const star = makeEvent({ seed: 91, kind: 4, tags: [['e', postId]], content: 'star' });
    await store.saveStarEvent(star);
    expect(await store.listStarEvents()).toHaveLength(1);
    const reshare = makeEvent({ seed: 92, kind: 5, tags: [['e', postId]] });
    await expect(store.saveReshareEvent(reshare)).resolves.toBeUndefined();
    expect(await store.listReshareEvents()).toHaveLength(1);
    // The extracted target id (used for rehydration joins) is normalized.
    const rows = await port.query<{ target_id: Uint8Array }>(`SELECT target_id FROM reshare_events`);
    expect(bytesToHex(rows[0].target_id)).toBe(postId.toLowerCase());
  });

  test('saveStarEvent rejects non-kind-4 events and stars without an e tag', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    await expect(store.saveStarEvent(makeEvent({ seed: 81, kind: 1 }))).rejects.toThrow(/kind 4/);
    await expect(
      store.saveStarEvent(makeEvent({ seed: 82, kind: 4, tags: [] })),
    ).rejects.toThrow(/no \["e", postId\] tag/);
  });

  test('pending star for an unknown post stays pending until the post is known', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const crypto = new NobleCrypto();
    const key = crypto.generateKeypair();
    const postId = bytesToHex(seedBytes(61));
    const event = createStarEvent({
      crypto, secretKey: key.secretKey, pubkey: key.publicKey,
      geohash5: 'tdr1v', postId: seedBytes(61),
      createdAt: Math.floor(Date.now() / 1000),
    });
    await store.saveStarEvent(event);
    const counter = new StarCounter();
    for (const e of await store.listStarEvents()) counter.apply(e, () => true);
    expect(counter.view(postId).pendingEvents).toBe(1);
    expect(counter.view(postId).count).toBe(0);
    counter.markPostKnown(postId);
    expect(counter.view(postId).count).toBe(1);
  });
});

describe('reshare_events (kind 5, T19, MIGRATION_005)', () => {
  function makeReshare(seed: number, postId: string, createdAt: number): SignedEvent {
    return {
      id: seedBytes(seed),
      pubkey: seedBytes(seed + 1000),
      created_at: createdAt,
      kind: 5,
      geohash: 'tdr1v',
      tags: [
        ['e', postId],
        ['p', 'a'.repeat(64)],
      ],
      content: '',
      sig: seedBytes(seed + 2000, 64),
    };
  }

  test('upgrade path: versioned v4 DB reaches version 6', async () => {
    const { port } = await migratedDb();
    await port.exec(`DROP TABLE reshare_events`);
    await port.exec(`DELETE FROM schema_version WHERE version = 5`);
    await port.exec(`DELETE FROM schema_version WHERE version = 6`);
    await OpSqliteStore.migrate(port);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4, 5, 6]);
    const rows = await port.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reshare_events'`,
    );
    expect(rows).toHaveLength(1);
  });

  test('round-trip, oldest first, idempotent by id, invisible to the post table', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const post = 'b'.repeat(64);
    const newer = makeReshare(31, post, NOW);
    const older = makeReshare(32, post, NOW - 100);
    await store.saveReshareEvent(newer);
    await store.saveReshareEvent(older);
    await store.saveReshareEvent(newer);
    const listed = await store.listReshareEvents();
    expect(listed).toHaveLength(2);
    expect(listed[0].created_at).toBe(NOW - 100);
    expect(listed[1].created_at).toBe(NOW);
    expect(listed[1].kind).toBe(5);
    expect(listed[1].tags).toEqual(newer.tags);
    expect(await store.getEvent(bytesToHex(newer.id))).toBeNull();
    expect(await store.getUnconfirmed()).toEqual([]);
  });

  test('saveReshareEvent rejects non-kind-5 events and reshares without an e tag', async () => {
    const { port } = await migratedDb();
    const store = new OpSqliteStore(port);
    const post = makeEvent({ seed: 41 });
    await expect(store.saveReshareEvent(post)).rejects.toThrow(/kind 5/);
    const untagged = makeReshare(42, 'b'.repeat(64), NOW);
    untagged.tags = [];
    await expect(store.saveReshareEvent(untagged)).rejects.toThrow(/\["e"/);
  });
});
