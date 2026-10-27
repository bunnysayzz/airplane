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
  kind?: 1 | 2 | 3;
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
  test('idempotent: running twice is a no-op, MAX(version) = 4', async () => {
    const { port } = await migratedDb();
    await OpSqliteStore.migrate(port);
    await OpSqliteStore.migrate(port);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4]);
    const max = await port.query<{ v: number }>(`SELECT MAX(version) AS v FROM schema_version`);
    expect(max[0].v).toBe(4);
    // Tables from all four migrations exist.
    for (const t of ['events', 'world_confirmed', 'tombstones', 'star_events', 'star_known_posts', 'schema_version']) {
      const rows = await port.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [t],
      );
      expect(rows).toHaveLength(1);
    }
  });

  test('upgrade path: legacy 001-only DB keeps its data, reaches version 4', async () => {
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

    expect(await schemaVersion(port)).toEqual([2, 3, 4]); // 001 was legacy, not re-recorded
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

    expect(await schemaVersion(port)).toEqual([3, 4]);
    const got = await store.getEvent(bytesToHex(e.id));
    expect(got!.content).toBe('era-002 post');
    expect(await store.isWorldConfirmed(bytesToHex(e.id))).toBe(true);
  });

  test('failed migration rolls back and records no version row', async () => {
    const db = new DatabaseSync(':memory:');
    openDbs.push(db);
    const port = makePort(db, false);
    await OpSqliteStore.migrate(port); // v4, healthy
    // Force a re-migration of 004 by deleting its version row: the
    // CREATE TABLE must fail and roll back.
    await port.exec(`DELETE FROM schema_version WHERE version = 4`);
    await expect(OpSqliteStore.migrate(port)).rejects.toThrow(/already exists/i);
    expect(await schemaVersion(port)).toEqual([1, 2, 3]); // 004 not recorded
    // Earlier migrations' data still intact.
    const store = new OpSqliteStore(port);
    const e = makeEvent({ seed: 103 });
    await expect(store.getEvent(bytesToHex(e.id))).resolves.toBeNull();
  });
});

describe('saveEvent / getEvent', () => {
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
  test('upgrade path: versioned v3 DB reaches version 4', async () => {
    const { port } = await migratedDb();
    await port.exec(`DROP TABLE star_events`);
    await port.exec(`DROP TABLE star_known_posts`);
    await port.exec(`DELETE FROM schema_version WHERE version = 4`);
    await OpSqliteStore.migrate(port);
    expect(await schemaVersion(port)).toEqual([1, 2, 3, 4]);
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
