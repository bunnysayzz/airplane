// SPDX-License-Identifier: Apache-2.0
// Store singleton for the mobile app.
//
// Uses the in-memory driver for now. In P2/P3 this swaps 1:1 for the native
// drivers (OpSqliteStore backed by op-sqlite, MmkvKv) — every consumer talks
// to the StorePort interface, so no call sites change.

import { MemoryEventStore, type StorePort } from '@airplane/storage';

let store: StorePort | null = null;

/** The app-wide event store. Create once, import everywhere. */
export function getStore(): StorePort {
  if (!store) {
    store = new MemoryEventStore();
  }
  return store;
}

/** Test seam: drop the singleton so the next getStore() starts fresh. */
export function __resetStoreForTests(): void {
  store = null;
}
