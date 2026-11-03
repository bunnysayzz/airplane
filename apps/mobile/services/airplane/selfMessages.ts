// SPDX-License-Identifier: Apache-2.0
// Saved messages: a private conversation with yourself, stored on this
// device only.
//
// Durability choice: a small dedicated store over the app KV port
// (MMKV on device, via getKv), NOT the DM store. The DM store on main is
// MemoryDmStore, so DM conversations and the DM outbox are session only
// and would lose saved notes on restart. A dedicated store is also the
// smallest change that keeps the privacy rule provable: this module has
// no import of DmService, no relay port, no BLE port and no outbox, so
// there is no code path from a saved note to a publish or send call.
// A future SQLite DM store would not change this: saved notes are not
// DMs, they have no peer, no sealed envelope and no delivery state, so
// they do not belong in dm_* tables.
//
// Privacy at rest: notes are plaintext in the app private KV file. That
// file lives in app private storage, is never uploaded, and is not read
// by any sync, backup or share path in this codebase. It is not sealed
// like a DM because there is no peer to seal to and no local encryption
// layer for notes exists; the protection is location (this device only)
// plus never transmitting, not encryption. Do not add a share, export
// or reshare call site for these notes without revisiting that.
//
// Identity burn and rotate: rotateDeviceKey wipes only the keypair and
// resets identity derived caches (the DM singleton among them). It does
// not wipe KV, and it does not wipe old posts, stars or receipts either.
// Saved notes therefore SURVIVE a burn or rotate: they are not tied to
// any pubkey, so the new identity keeps the same notes on the same
// device. Uninstalling the app, or clearing app data, deletes them with
// everything else in app private storage.

import type { KvPort } from '@airplane/storage';
import { getKv } from './kv';

/** KV key for the whole saved notes list (one JSON array, see below). */
export const SELF_MESSAGES_KEY = 'self-messages-v1';
/** Same text cap as a DM (4096 UTF-8 bytes): a note is not a document. */
export const SELF_MESSAGE_MAX_BYTES = 4096;
/** Same per conversation cap as DM history: oldest notes fall away past it. */
export const SELF_MESSAGES_MAX_COUNT = 1000;

export interface SelfMessage {
  id: string;
  text: string;
  createdAtMs: number;
}

/** UTF-8 byte length without assuming a global TextEncoder exists. */
export function selfMessageByteLength(text: string): number {
  const encoder = (
    globalThis as { TextEncoder?: new () => { encode(input: string): Uint8Array } }
  ).TextEncoder;
  if (encoder !== undefined) return new encoder().encode(text).length;
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length;
}

function isSelfMessage(value: unknown): value is SelfMessage {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.text === 'string' &&
    typeof row.createdAtMs === 'number'
  );
}

/**
 * Dedicated local only store for saved notes. The only dependency is a
 * KvPort: in the app that is MMKV (durable across restart), in tests a
 * MemoryKv. Nothing here can publish, send, queue or reshare.
 */
export class SelfMessageStore {
  private readonly kv: KvPort;
  private readonly now: () => number;

  constructor(kv: KvPort, now?: () => number) {
    this.kv = kv;
    this.now = now ?? (() => Date.now());
  }

  /** All saved notes, oldest first. A corrupt row reads as empty, never throws. */
  async list(): Promise<SelfMessage[]> {
    const raw = await this.kv.get(SELF_MESSAGES_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSelfMessage).map(m => ({ ...m }));
    } catch {
      return [];
    }
  }

  /** Save one note. Returns the stored note. Empty and oversize notes throw. */
  async save(text: string): Promise<SelfMessage> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new Error('self message is empty');
    if (selfMessageByteLength(trimmed) > SELF_MESSAGE_MAX_BYTES) {
      throw new Error(`self message longer than ${SELF_MESSAGE_MAX_BYTES} bytes`);
    }
    const list = await this.list();
    const createdAtMs = this.now();
    const note: SelfMessage = {
      id: `${createdAtMs}-${Math.random().toString(36).slice(2, 12)}`,
      text: trimmed,
      createdAtMs,
    };
    list.push(note);
    while (list.length > SELF_MESSAGES_MAX_COUNT) list.shift();
    await this.kv.set(SELF_MESSAGES_KEY, JSON.stringify(list));
    return { ...note };
  }

  /** Delete one note by id. Deleting a missing id is a no-op. */
  async delete(id: string): Promise<void> {
    const kept = (await this.list()).filter(m => m.id !== id);
    await this.kv.set(SELF_MESSAGES_KEY, JSON.stringify(kept));
  }

  /** Delete every saved note from this device. */
  async deleteAll(): Promise<void> {
    await this.kv.del(SELF_MESSAGES_KEY);
  }
}

let store: SelfMessageStore | null = null;

/** The app-wide saved notes store, backed by the durable MMKV KV port. */
export function getSelfMessageStore(): SelfMessageStore {
  if (!store) store = new SelfMessageStore(getKv());
  return store;
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function __resetSelfMessageStoreForTests(): void {
  store = null;
}

/** Test seam: install a store over a fake KV port. */
export function __setSelfMessageStoreForTests(fake: SelfMessageStore): void {
  store = fake;
}
