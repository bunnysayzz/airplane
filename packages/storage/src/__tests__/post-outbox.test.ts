// SPDX-License-Identifier: Apache-2.0
// Durable post outbox (MIGRATION_007 mirror in MemoryEventStore):
// enqueue is idempotent, drain order is oldest first, attempts move
// the status, World confirmation deletes the row, and prune deletes
// it with its post.

import type { SignedEvent, Hex64 } from '@airplane/protocol';
import { MemoryEventStore, bytesToHex } from '../memory';

function seedBytes(seed: number, len = 32): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (seed + i * 7) & 0xff;
  return b;
}

function makePost(seed: number, createdAt: number): SignedEvent {
  return {
    id: seedBytes(seed),
    pubkey: seedBytes(seed + 1000),
    created_at: createdAt,
    kind: 1,
    geohash: 'tdr1v',
    tags: [],
    content: 'outbox post',
    sig: seedBytes(seed + 2000, 64),
  };
}

const NOW = Math.floor(Date.now() / 1000);

describe('post outbox (memory store)', () => {
  test('enqueue is idempotent and starts pending with zero attempts', async () => {
    const store = new MemoryEventStore();
    const post = makePost(11, NOW);
    await store.saveEvent(post);
    const id = bytesToHex(post.id) as Hex64;
    await store.enqueuePostOutbox(id, post.created_at);
    await store.enqueuePostOutbox(id, post.created_at);
    const rows = await store.listPostOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventId: id, attempts: 0, lastAttemptAt: null, status: 'pending' });
  });

  test('drain order is oldest first, not insertion order', async () => {
    const store = new MemoryEventStore();
    const newer = makePost(21, NOW);
    const older = makePost(22, NOW - 600);
    const oldest = makePost(23, NOW - 1200);
    for (const p of [newer, older, oldest]) await store.saveEvent(p);
    for (const p of [newer, older, oldest]) {
      await store.enqueuePostOutbox(bytesToHex(p.id) as Hex64, p.created_at);
    }
    const ids = (await store.listPostOutbox()).map((r) => r.eventId);
    expect(ids).toEqual([
      bytesToHex(oldest.id),
      bytesToHex(older.id),
      bytesToHex(newer.id),
    ]);
  });

  test('attempts bump the count and move the status; a missing row is left alone', async () => {
    const store = new MemoryEventStore();
    const post = makePost(31, NOW);
    await store.saveEvent(post);
    const id = bytesToHex(post.id) as Hex64;
    await store.enqueuePostOutbox(id, post.created_at);
    await store.markPostOutboxAttempt(id, 'unsent');
    await store.markPostOutboxAttempt(id, 'ble-sent');
    const rows = await store.listPostOutbox();
    expect(rows[0]).toMatchObject({ attempts: 2, status: 'ble-sent' });
    expect(rows[0].lastAttemptAt).not.toBeNull();
    await expect(store.markPostOutboxAttempt('f'.repeat(64), 'unsent')).resolves.toBeUndefined();
    expect(await store.listPostOutbox()).toHaveLength(1);
  });

  test('World confirmation deletes the row, and getUnconfirmed is age-ordered', async () => {
    const store = new MemoryEventStore();
    const newer = makePost(41, NOW);
    const older = makePost(42, NOW - 600);
    for (const p of [newer, older]) {
      await store.saveEvent(p);
      await store.enqueuePostOutbox(bytesToHex(p.id) as Hex64, p.created_at);
    }
    expect(await store.getUnconfirmed()).toEqual([
      bytesToHex(older.id),
      bytesToHex(newer.id),
    ]);
    await store.markWorldConfirmed(bytesToHex(older.id));
    expect(await store.listPostOutbox()).toHaveLength(1);
    expect(await store.getUnconfirmed()).toEqual([bytesToHex(newer.id)]);
  });

  test('batch statuses cover a feed page, and remove deletes one row', async () => {
    const store = new MemoryEventStore();
    const post = makePost(51, NOW);
    await store.saveEvent(post);
    const id = bytesToHex(post.id) as Hex64;
    await store.enqueuePostOutbox(id, post.created_at);
    await store.markPostOutboxAttempt(id, 'unsent');
    const statuses = await store.listPostOutboxStatuses([id, 'e'.repeat(64)]);
    expect(statuses.get(id)).toBe('unsent');
    expect(statuses.has('e'.repeat(64))).toBe(false);
    await store.removePostOutbox(id);
    expect(await store.listPostOutbox()).toHaveLength(0);
  });

  test('prune deletes the outbox row with its expired post', async () => {
    const store = new MemoryEventStore();
    const expired = makePost(61, NOW - 2 * 86400);
    await store.saveEvent(expired);
    const id = bytesToHex(expired.id) as Hex64;
    await store.enqueuePostOutbox(id, expired.created_at);
    await store.pruneExpired(NOW);
    // Re-saving the same post after prune must not resurrect the
    // outbox row: prune deleted it, and saveEvent does not re-create
    // outbox rows (only the composer enqueues).
    await store.saveEvent({ ...expired, created_at: NOW });
    expect(await store.listPostOutbox()).toHaveLength(0);
  });
});
