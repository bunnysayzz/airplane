// SPDX-License-Identifier: Apache-2.0
// op-sqlite adapter tests (T2).
//
// The adapter is tested against node:sqlite (real SQL, no mocks of the
// store logic): the fake executor mimics the op-sqlite v18 `execute`
// shape ({ rows }) over a DatabaseSync handle. The migration gate,
// BLOB normalization, and restart persistence are all exercised here;
// the only thing this cannot prove is op-sqlite's own native binding,
// which is why the track's DONE criterion also needs a real device.

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SignedEvent } from '@airplane/protocol';
import { OpSqliteStore, bytesToHex } from '@airplane/storage';
import { OpSqliteDatabasePort, createSqliteDatabasePort, type OpSqliteExecutor } from './sqlite';

type BindParam = string | number | bigint | Uint8Array | null;

function seedBytes(seed: number, len = 32): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed + i * 7) & 0xff;
  return b;
}

function makePost(seed: number, geohash = 'tdr1v'): SignedEvent {
  return {
    id: seedBytes(seed),
    pubkey: seedBytes(seed + 1000),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    geohash,
    tags: [],
    content: 'hello from sqlite test',
    sig: seedBytes(seed + 2000, 64),
  };
}

/** OpSqliteExecutor over a node:sqlite handle (same shape as op-sqlite v18). */
function makeExecutor(db: DatabaseSync): OpSqliteExecutor {
  return {
    execute: async (sql: string, params: unknown[] = []) => {
      const head = sql.trim().toUpperCase().split(/\s+/)[0] ?? '';
      const stmt = db.prepare(sql);
      if (head === 'SELECT' || head === 'PRAGMA' || head === 'WITH' || head === 'EXPLAIN') {
        const rows = stmt.all(...(params as BindParam[])) as Array<Record<string, unknown>>;
        return { rows };
      }
      stmt.run(...(params as BindParam[]));
      return { rows: [] };
    },
  };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airplane-sqlite-'));
  tempDirs.push(dir);
  return path.join(dir, 'airplane.db');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('sqlite adapter over real SQL', () => {
  test('a post survives closing and reopening the database (restart)', async () => {
    const file = tempDbPath();
    const post = makePost(7);

    const db1 = new DatabaseSync(file);
    const store1 = new OpSqliteStore(createSqliteDatabasePort(makeExecutor(db1)));
    await store1.saveEvent(post);
    expect(await store1.getEvent(bytesToHex(post.id))).not.toBeNull();
    db1.close();

    // Second port + store over the same file: migration re-runs (no-op)
    // and the post is still there — this is the restart proof.
    const db2 = new DatabaseSync(file);
    const store2 = new OpSqliteStore(createSqliteDatabasePort(makeExecutor(db2)));
    const reopened = await store2.getEvent(bytesToHex(post.id));
    expect(reopened).toEqual(post);
    expect(await store2.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);
    expect(await store2.listFeed({ cells: ['zzzzz'], limit: 10 })).toHaveLength(0);
    db2.close();
  });

  test('World confirmation survives restart; unconfirmed list excludes it', async () => {
    const file = tempDbPath();
    const post = makePost(11);

    const db1 = new DatabaseSync(file);
    const store1 = new OpSqliteStore(createSqliteDatabasePort(makeExecutor(db1)));
    await store1.saveEvent(post);
    await store1.markWorldConfirmed(bytesToHex(post.id));
    expect(await store1.isWorldConfirmed(bytesToHex(post.id))).toBe(true);
    db1.close();

    const db2 = new DatabaseSync(file);
    const store2 = new OpSqliteStore(createSqliteDatabasePort(makeExecutor(db2)));
    expect(await store2.isWorldConfirmed(bytesToHex(post.id))).toBe(true);
    expect(await store2.getUnconfirmed()).toHaveLength(0);
    db2.close();
  });

  test('open applies WAL + busy-timeout pragmas, and close checkpoints without throwing', async () => {
    const file = tempDbPath();
    const post = makePost(7);

    const db1 = new DatabaseSync(file);
    const port1 = createSqliteDatabasePort(makeExecutor(db1));
    const store1 = new OpSqliteStore(port1);
    await store1.saveEvent(post);
    const mode = await port1.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(mode[0].journal_mode).toBe('wal');
    const timeout = await port1.query<Record<string, unknown>>('PRAGMA busy_timeout');
    expect(Object.values(timeout[0])).toContain(5000);
    await expect(port1.close?.()).resolves.toBeUndefined();
    db1.close();

    // Existing install re-opens: pragmas are applied again, data survives.
    const db2 = new DatabaseSync(file);
    const port2 = createSqliteDatabasePort(makeExecutor(db2));
    const store2 = new OpSqliteStore(port2);
    expect(await store2.getEvent(bytesToHex(post.id))).not.toBeNull();
    const mode2 = await port2.query<{ journal_mode: string }>('PRAGMA journal_mode');
    expect(mode2[0].journal_mode).toBe('wal');
    db2.close();
  });

  test('a failed migration fails later operations (no silent memory fallback)', async () => {
    const failing: OpSqliteExecutor = {
      execute: async () => {
        throw new Error('db gone');
      },
    };
    const port = createSqliteDatabasePort(failing);
    await expect(port.query('SELECT 1')).rejects.toThrow('db gone');
    await expect(port.exec('SELECT 1')).rejects.toThrow('db gone');
  });
});

describe('OpSqliteDatabasePort normalization', () => {
  test('ArrayBuffer and DataView BLOB values become Uint8Array', async () => {
    const buf = new Uint8Array([0, 9, 8, 7]).buffer;
    const executor: OpSqliteExecutor = {
      execute: async () => ({
        rows: [
          {
            blobBuf: buf,
            blobView: new DataView(buf, 1, 2),
            n: 3,
            s: 'x',
          },
        ],
      }),
    };
    const port = new OpSqliteDatabasePort(executor);
    const rows = await port.query<Record<string, unknown>>('SELECT 1');
    expect(rows[0].blobBuf).toBeInstanceOf(Uint8Array);
    expect(rows[0].blobBuf).toEqual(new Uint8Array([0, 9, 8, 7]));
    expect(rows[0].blobView).toEqual(new Uint8Array([9, 8]));
    expect(rows[0].n).toBe(3);
    expect(rows[0].s).toBe('x');
  });

  test('exec/query pass SQL and params through to the executor', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const executor: OpSqliteExecutor = {
      execute: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql, params });
        return { rows: [] };
      },
    };
    const port = new OpSqliteDatabasePort(executor);
    await port.exec('INSERT INTO t VALUES (?, ?)', ['a', 1]);
    await port.query('SELECT * FROM t WHERE x = ?', [42]);
    expect(seen).toEqual([
      { sql: 'INSERT INTO t VALUES (?, ?)', params: ['a', 1] },
      { sql: 'SELECT * FROM t WHERE x = ?', params: [42] },
    ]);
  });
});
