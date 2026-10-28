// SPDX-License-Identifier: Apache-2.0
// op-sqlite DatabasePort adapter (T2: persistent storage).
//
// Wires the already-tested OpSqliteStore (packages/storage) to a real
// on-device SQLite database, replacing the in-memory MemoryEventStore the
// app shipped with. Posts now survive app restarts: the database file
// lives in the app's database directory (op-sqlite default location) and
// OpSqliteStore.migrate() runs once, before any other operation, the
// first time the port is created.
//
// Native-module loading is deliberately lazy: the '@op-engineering/op-sqlite'
// require lives inside loadRealExecutor(), never at module top level, so
// importing this file in the Jest/Node harness (where the native module
// cannot load) is safe. Only the first real database operation touches it.
//
// API shape verified against the installed package's own types
// (@op-engineering/op-sqlite 18.2.5, lib/typescript/src/types.d.ts):
//   open({ name }) -> DB; DB.execute(query, params?) -> Promise<QueryResult>
//   QueryResult.rows: Array<Record<string, Scalar>> (BLOB columns arrive
//   as Uint8Array/ArrayBuffer). The v18 `execute` IS the async method;
//   there is no executeAsync on the DB type anymore.
//
// No native transaction is exposed here on purpose: OpSqliteStore's
// BEGIN IMMEDIATE / COMMIT / ROLLBACK emulation (via exec) is the path
// its own test suite exercises, and op-sqlite executes statements on one
// connection in call order, so the emulation is atomic. If a future
// device test ever shows a torn transaction, switch this port to
// DB.transaction() behind a serializing queue — do not silently keep
// the emulation.

import { OpSqliteStore, type DatabasePort } from '@airplane/storage';

/** Minimal structural subset of the op-sqlite v18 DB surface used here. */
export interface OpSqliteDbLike {
  execute(query: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  /** Close the connection, when the driver exposes it (op-sqlite v18 does). */
  close?: () => Promise<void> | void;
}

/** Executor interface the adapter runs against; fakes implement this in tests. */
export type OpSqliteExecutor = OpSqliteDbLike;

/**
 * Lazily open the real on-device database. Never call this in tests —
 * pass a fake executor to createSqliteDatabasePort() instead.
 */
function loadRealExecutor(): OpSqliteExecutor {
  // Lazy require: see the module header. The cast documents the verified
  // v18 API shape; the package's own .d.ts is the source of truth.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy native load
  const { open } = require('@op-engineering/op-sqlite') as {
    open: (opts: { name: string }) => OpSqliteDbLike;
  };
  return open({ name: 'airplane.db' });
}

/**
 * Normalize one result row for OpSqliteStore: BLOB columns must be
 * Uint8Array (the store's rowToEvent/bytesToHex assume it), but op-sqlite
 * may hand back a bare ArrayBuffer or another ArrayBufferView.
 */
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof ArrayBuffer) {
      out[key] = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
      out[key] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** DatabasePort over an op-sqlite executor (raw: no migration gate). */
export class OpSqliteDatabasePort implements DatabasePort {
  constructor(private readonly executor: OpSqliteExecutor) {}

  async exec(sql: string, params?: unknown[]): Promise<void> {
    await this.executor.execute(sql, params ?? []);
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const { rows } = await this.executor.execute(sql, params ?? []);
    return rows.map((row) => normalizeRow(row) as T);
  }

  /** Checkpoint the WAL back into the database file, then close. Never throws. */
  async close(): Promise<void> {
    try {
      await this.executor.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Checkpoint is housekeeping; a failed one must not block teardown.
    }
    try {
      await this.executor.close?.();
    } catch {
      // Closing twice or on a dead connection is not a teardown failure.
    }
  }
}

/**
 * Build the app's database port: raw adapter + a one-time migration gate.
 *
 * OpSqliteStore.migrate() runs once at creation (against the raw port,
 * so it cannot deadlock on the gate) and every exec/query awaits it.
 * A failed migration fails every later operation with the same error —
 * never a silent fall back to in-memory storage, which would lose posts.
 *
 * Connection housekeeping runs on every open, not only on fresh
 * installs: WAL mode, a busy timeout, and journal size limits are
 * applied after migration succeeds, so a legacy database that skipped
 * MIGRATION_001's WAL pragma gets them too. close() checkpoints and
 * closes for teardown paths (see store.closeStore).
 */
export function createSqliteDatabasePort(executor?: OpSqliteExecutor): DatabasePort {
  const raw = new OpSqliteDatabasePort(executor ?? loadRealExecutor());
  const ready = OpSqliteStore.migrate(raw).then(async () => {
    await raw.exec('PRAGMA journal_mode = WAL');
    await raw.exec('PRAGMA busy_timeout = 5000');
    await raw.exec('PRAGMA synchronous = NORMAL');
    await raw.exec('PRAGMA journal_size_limit = 1048576');
  });
  // Mark the rejection handled so an unused port never surfaces an
  // unhandled rejection; awaiters of `ready` below still see the error.
  ready.catch(() => {
    /* surfaced to callers via exec/query */
  });
  return {
    exec: async (sql: string, params?: unknown[]): Promise<void> => {
      await ready;
      return raw.exec(sql, params);
    },
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      await ready;
      return raw.query<T>(sql, params);
    },
    close: async (): Promise<void> => {
      try {
        await ready;
      } catch {
        // A failed open still gets a teardown attempt below.
      }
      await raw.close();
    },
  };
}
