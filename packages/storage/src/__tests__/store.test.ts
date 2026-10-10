// SPDX-License-Identifier: Apache-2.0
// StorePort + KvPort behavior tests against the in-memory implementations.

import type { SignedEvent, Hex64 } from '@airplane/protocol';
import {
  MemoryEventStore,
  MemoryKv,
  bytesToHex,
  rankScore,
} from '../memory';
import { MIGRATION_001 } from '../schema';
import { MmkvKv } from '../mmkv';

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
}

function makeEvent(o: FixtureOpts): SignedEvent {
  return {
    id: seedBytes(o.seed),
    pubkey: seedBytes(o.seed + 1000),
    created_at: o.createdAt ?? Math.floor(Date.now() / 1000),
    kind: o.kind ?? 1,
    geohash: o.geohash ?? 'tdr1v',
    tags: o.tags ?? [],
    content: o.content ?? 'hello world',
    sig: seedBytes(o.seed + 2000, 64),
  };
}

function makeReceipt(seed: number, postId: Hex64, createdAt: number): SignedEvent {
  return makeEvent({
    seed,
    kind: 2,
    tags: [['e', postId]],
    content: '',
    createdAt,
  });
}

const NOW = Math.floor(Date.now() / 1000);

describe('MemoryEventStore', () => {
  test('save/get round-trip', async () => {
    const store = new MemoryEventStore();
    const e = makeEvent({ seed: 1, content: 'first post' });
    await store.saveEvent(e);
    const got = await store.getEvent(bytesToHex(e.id));
    expect(got).not.toBeNull();
    expect(got!.content).toBe('first post');
    expect(got!.geohash).toBe('tdr1v');
    expect(bytesToHex(got!.id)).toBe(bytesToHex(e.id));
  });

  test('getEvent returns null for unknown id', async () => {
    const store = new MemoryEventStore();
    expect(await store.getEvent('ab'.repeat(32))).toBeNull();
  });

  test('upsert is idempotent', async () => {
    const store = new MemoryEventStore();
    const e = makeEvent({ seed: 2 });
    await store.saveEvent(e);
    await store.saveEvent(e);
    await store.saveEvent({ ...e, content: 'mutated' });
    const got = await store.getEvent(bytesToHex(e.id));
    expect(got!.content).toBe('hello world'); // first write wins
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 10 });
    expect(feed).toHaveLength(1);
  });

  test('tombstone hides post from feed', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 3 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);

    const tomb = makeEvent({ seed: 4, kind: 3, tags: [['e', postId]], content: '' });
    await store.saveEvent(tomb);
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
    // The post row still exists, flagged deleted.
    expect(await store.getEvent(postId)).not.toBeNull();
  });

  test('tombstone arriving before the post still deletes it (tombstone-wins)', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 5 });
    const postId = bytesToHex(post.id);
    await store.markDeleted(postId); // no row yet
    await store.saveEvent(post); // arrives late
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
  });

  test('receipt dedup: same device/day counted once, next day counted again', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 6 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);

    const day = NOW - (NOW % 86400);
    const r1 = makeReceipt(7, postId, day + 100);
    expect(await store.saveReceipt(r1)).toBe(true);
    expect(await store.saveReceipt(r1)).toBe(false); // exact duplicate
    const r1b = makeReceipt(8, postId, day + 200); // same device, same day, new id
    r1b.pubkey = r1.pubkey.slice();
    expect(await store.saveReceipt(r1b)).toBe(false);
    expect(await store.countViews(postId)).toBe(1);

    const r2 = makeReceipt(9, postId, day + 86400 + 100); // next day
    expect(await store.saveReceipt(r2)).toBe(true);
    expect(await store.countViews(postId)).toBe(2);

    // A different device's receipt on the same day counts separately.
    const r3 = makeReceipt(10, postId, day + 300);
    r3.pubkey = seedBytes(4242);
    expect(await store.saveReceipt(r3)).toBe(true);
    expect(await store.countViews(postId)).toBe(3);
  });

  test('saveReceipt rejects non-receipt kinds and tagless receipts', async () => {
    const store = new MemoryEventStore();
    await expect(store.saveReceipt(makeEvent({ seed: 11, kind: 1 }))).rejects.toThrow(
      /kind 2/,
    );
    await expect(
      store.saveReceipt(makeEvent({ seed: 12, kind: 2, tags: [] })),
    ).rejects.toThrow(/no \["e", postId\] tag/);
  });

  test('feed shows views and score', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 13, createdAt: NOW - 3600 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);
    await store.saveReceipt(makeReceipt(14, postId, NOW - 1800));
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 10, nowSec: NOW });
    expect(feed).toHaveLength(1);
    expect(feed[0].views).toBe(1);
    expect(feed[0].ageHours).toBeCloseTo(1, 5);
    expect(feed[0].score).toBeCloseTo(rankScore(1, 1), 10);
  });

  test('expiry pruning removes old posts and their receipts', async () => {
    const store = new MemoryEventStore({ retentionSec: 3600 });
    const oldPost = makeEvent({ seed: 15, createdAt: NOW - 7200 });
    const oldId = bytesToHex(oldPost.id);
    const freshPost = makeEvent({ seed: 16, createdAt: NOW - 100 });
    const freshId = bytesToHex(freshPost.id);
    await store.saveEvent(oldPost);
    await store.saveEvent(freshPost);
    await store.saveReceipt(makeReceipt(17, oldId, NOW - 7100));
    expect(await store.countViews(oldId)).toBe(1);

    const removed = await store.pruneExpired(NOW);
    // 1 expired post + 1 orphaned receipt.
    expect(removed).toBe(2);
    expect(await store.getEvent(oldId)).toBeNull();
    expect(await store.getEvent(freshId)).not.toBeNull();
    expect(await store.countViews(oldId)).toBe(0);
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);
  });

  test('expired posts are invisible to the feed even before pruning', async () => {
    const store = new MemoryEventStore({ retentionSec: 60 });
    await store.saveEvent(makeEvent({ seed: 18, createdAt: NOW - 3600 }));
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10, nowSec: NOW })).toHaveLength(0);
  });

  test('feed filters by geohash cells', async () => {
    const store = new MemoryEventStore();
    await store.saveEvent(makeEvent({ seed: 19, geohash: 'tdr1v' }));
    await store.saveEvent(makeEvent({ seed: 20, geohash: 'u4pru' }));
    await store.saveEvent(makeEvent({ seed: 21, geohash: 'tdr1v' }));
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 10 });
    expect(feed).toHaveLength(2);
    expect(feed.every((p) => p.event.geohash === 'tdr1v')).toBe(true);
  });

  test('feed is newest-first and honors limit + before cursor', async () => {
    const store = new MemoryEventStore();
    await store.saveEvent(makeEvent({ seed: 22, createdAt: NOW - 300 }));
    await store.saveEvent(makeEvent({ seed: 23, createdAt: NOW - 100 }));
    await store.saveEvent(makeEvent({ seed: 24, createdAt: NOW - 200 }));

    const all = await store.listFeed({ cells: ['tdr1v'], limit: 10 });
    expect(all.map((p) => p.event.created_at)).toEqual([NOW - 100, NOW - 200, NOW - 300]);

    const limited = await store.listFeed({ cells: ['tdr1v'], limit: 2 });
    expect(limited).toHaveLength(2);

    const paged = await store.listFeed({ cells: ['tdr1v'], limit: 10, before: NOW - 200 });
    expect(paged.map((p) => p.event.created_at)).toEqual([NOW - 300]);
  });

  test('receipts and tombstones never appear in the feed', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 25 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);
    await store.saveReceipt(makeReceipt(26, postId, NOW));
    await store.saveEvent(makeEvent({ seed: 27, kind: 3, tags: [['e', 'ff'.repeat(32)]], content: '' }));
    const feed = await store.listFeed({ cells: ['tdr1v'], limit: 10 });
    expect(feed).toHaveLength(1);
    expect(feed[0].event.kind).toBe(1);
  });

  test('upsertPeer does not throw and refreshes the record', async () => {
    const store = new MemoryEventStore();
    await store.upsertPeer({ peerId: 'a1b2c3d4e5f60718', rssi: -70, lastSeenSec: NOW - 60 });
    await store.upsertPeer({ peerId: 'a1b2c3d4e5f60718', rssi: -50, lastSeenSec: NOW });
    await store.upsertPeer({ peerId: '0011223344556677' });
  });
});

describe('MemoryKv', () => {
  test('get/set/del', async () => {
    const kv = new MemoryKv();
    expect(await kv.get('missing')).toBeNull();
    await kv.set('cursor', '12345');
    expect(await kv.get('cursor')).toBe('12345');
    await kv.set('cursor', '67890');
    expect(await kv.get('cursor')).toBe('67890');
    await kv.del('cursor');
    expect(await kv.get('cursor')).toBeNull();
    await kv.del('cursor'); // deleting a missing key is fine
  });
});

describe('schema', () => {
  test('MIGRATION_001 contains the frozen tables', () => {
    for (const table of [
      'CREATE TABLE events(',
      'CREATE TABLE receipts(',
      'CREATE TABLE view_counts(',
      'CREATE TABLE peers(',
      'CREATE TABLE sync_state(',
      'CREATE TABLE seen(',
      'CREATE TABLE frag_buf(',
      'CREATE TABLE logs(',
    ]) {
      expect(MIGRATION_001).toContain(table);
    }
    expect(MIGRATION_001).toContain('PRAGMA journal_mode = WAL;');
  });
});

describe('MmkvKv stub', () => {
  test('throws until react-native-mmkv is linked (P2)', async () => {
    const kv = new MmkvKv();
    await expect(kv.get('k')).rejects.toThrow(/not linked \(P2\)/);
    await expect(kv.set('k', 'v')).rejects.toThrow(/not linked \(P2\)/);
    await expect(kv.del('k')).rejects.toThrow(/not linked \(P2\)/);
  });
});
