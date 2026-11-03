// SPDX-License-Identifier: Apache-2.0
// Compose draft persistence (transport-matrix rank 12).
//
// The compose draft used to live only in modal state, so killing the app
// during the location race lost the post text: nothing had been saved yet
// and there was nothing to restore. This store persists the draft in the
// app-private KV on every keystroke and again at submit start, restores
// it when the compose sheet next opens, and clears it only on two paths:
// a successful publish, or the user explicitly choosing Discard. Every
// other exit (plain close, failed publish, kill) keeps the draft, so the
// discard guard in composeModal (which refuses to close while a publish
// is in flight) and this store tell one story: the draft survives until
// it is published or deliberately discarded, never because the app died.
//
// One key, one restore path, one clear method: there is no second draft
// store anywhere in the app. Do not add another key or a second restore
// path; extend this module instead.
//
// Privacy at rest: the draft is user text stored as plaintext in the app
// private KV file, exactly like Saved notes (see selfMessages.ts). That
// file lives in app private storage, is never uploaded, and is not read
// by any sync, backup, share, or publish path except this restore. The
// draft is never logged: callers log outcome names only, never the text.
// Uninstalling the app, or clearing app data, deletes it with everything
// else in app private storage.

import type { KvPort } from '@airplane/storage';
import { getKv } from './kv';

/** The single KV key for the compose draft. */
export const COMPOSE_DRAFT_KEY = 'compose-draft-v1';
/** Same cap as the compose TextInput (MAX_POST_LENGTH + 50): a draft is not a document. */
export const COMPOSE_DRAFT_MAX_LENGTH = 330;

/**
 * Durable compose draft over a KvPort: MMKV on device via getKv(), a
 * MemoryKv in tests. Nothing here can publish, send, or log the text.
 */
export class ComposeDraftStore {
  private readonly kv: KvPort;

  constructor(kv: KvPort) {
    this.kv = kv;
  }

  /** The saved draft, or '' when none exists or the stored value is unusable. */
  async load(): Promise<string> {
    const raw = await this.kv.get(COMPOSE_DRAFT_KEY);
    if (raw === null) return '';
    return raw.slice(0, COMPOSE_DRAFT_MAX_LENGTH);
  }

  /**
   * Persist the draft. An empty draft deletes the key, so an empty sheet
   * never leaves a stale value behind for the next open.
   */
  async save(text: string): Promise<void> {
    if (text.length === 0) {
      await this.kv.del(COMPOSE_DRAFT_KEY);
      return;
    }
    await this.kv.set(COMPOSE_DRAFT_KEY, text.slice(0, COMPOSE_DRAFT_MAX_LENGTH));
  }

  /** Clear the draft. Called only on successful publish or explicit Discard. */
  async clear(): Promise<void> {
    await this.kv.del(COMPOSE_DRAFT_KEY);
  }
}

let store: ComposeDraftStore | null = null;

/** The app-wide compose draft store, backed by the durable MMKV KV port. */
export function getComposeDraftStore(): ComposeDraftStore {
  if (!store) store = new ComposeDraftStore(getKv());
  return store;
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function __resetComposeDraftStoreForTests(): void {
  store = null;
}

/** Test seam: install a store over a fake KV port. */
export function __setComposeDraftStoreForTests(fake: ComposeDraftStore): void {
  store = fake;
}
