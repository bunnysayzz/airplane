// SPDX-License-Identifier: Apache-2.0
// Store singleton for the mobile app.
//
// Persistent by default (T2): the app-wide store is an OpSqliteStore over
// the on-device SQLite database (see ./sqlite.ts), so posts, receipts,
// peers and World-confirmation state survive app restarts. The database
// migration runs once, gated inside the port, before any operation —
// callers do not need an init step and no call sites change, because
// every consumer talks to the StorePort interface.
//
// The in-memory driver survives only as the test seam below: every test
// resets to a fresh MemoryEventStore in beforeEach, so the native module
// is never loaded in the Jest harness.

import { MemoryEventStore, OpSqliteStore, type DatabasePort, type StorePort } from '@airplane/storage';
import { createSqliteDatabasePort } from './sqlite';

let store: StorePort | null = null;
let storePort: DatabasePort | null = null;

/** The app-wide event store. Create once, import everywhere. */
export function getStore(): StorePort {
  if (!store) {
    storePort = createSqliteDatabasePort();
    store = new OpSqliteStore(storePort);
  }
  return store;
}

/**
 * Teardown path: checkpoint and close the SQLite connection, then drop
 * the singleton so a later getStore() re-opens it. No-op for the
 * in-memory test store (which has no port). Call on app teardown paths
 * that exist; mobile apps rarely tear down, so this is a path, not a
 * lifecycle the app currently drives on every backgrounding.
 */
export async function closeStore(): Promise<void> {
  if (storePort?.close) await storePort.close();
  store = null;
  storePort = null;
}

/** Test seam: replace the singleton with a fresh in-memory store. */
export function __resetStoreForTests(): void {
  store = new MemoryEventStore();
  storePort = null;
}
