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

import { MemoryEventStore, OpSqliteStore, type StorePort } from '@airplane/storage';
import { createSqliteDatabasePort } from './sqlite';

let store: StorePort | null = null;

/** The app-wide event store. Create once, import everywhere. */
export function getStore(): StorePort {
  if (!store) {
    store = new OpSqliteStore(createSqliteDatabasePort());
  }
  return store;
}

/** Test seam: replace the singleton with a fresh in-memory store. */
export function __resetStoreForTests(): void {
  store = new MemoryEventStore();
}
