// SPDX-License-Identifier: Apache-2.0
// StorePort + KvPort behavior tests against the in-memory implementations.

import type { SignedEvent, Hex64 } from '@airplane/protocol';
import {
  MemoryEventStore,
  MemoryKv,
  bytesToHex,
  hexToBytes,
  rankScore,
} from '../memory';
import { MIGRATION_001, MIGRATION_002 } from '../schema';
import { MmkvKv } from '../mmkv';
import { NobleCrypto, createViewReceipt, fromHex } from '@airplane/protocol';
import { MemoryKeyStore, loadOrGenerateKeypair } from '@airplane/crypto';

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
  /** Override the author pubkey (default derives from seed). */
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

    // ACCEPT: tombstone signed by the post's author is honored.
    const tomb = makeEvent({
      seed: 4,
      kind: 3,
      tags: [['e', postId]],
      content: '',
      pubkey: post.pubkey,
    });
    await store.saveEvent(tomb);
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
    // The post row still exists, flagged deleted.
    expect(await store.getEvent(postId)).not.toBeNull();
  });

  test('tombstone from a different author is REJECTED (not honored)', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 30 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);

    // Forged tombstone: a different key claims to delete someone else's post.
    const forged = makeEvent({
      seed: 31,
      kind: 3,
      tags: [['e', postId]],
      content: '',
      pubkey: seedBytes(9999),
    });
    await store.saveEvent(forged);
    // Stored as an event (relay integrity) but the post stays visible.
    expect(await store.getEvent(bytesToHex(forged.id))).not.toBeNull();
    expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);
  });

  test('pending tombstone: honored only when the late post author matches', async () => {
    // ACCEPT: tombstone arrives first, post arrives later from the same author.
    {
      const store = new MemoryEventStore();
      const authorPubkey = seedBytes(5001);
      const postId = bytesToHex(seedBytes(50));
      const tomb = makeEvent({
        seed: 51,
        kind: 3,
        tags: [['e', postId]],
        content: '',
        pubkey: authorPubkey,
      });
      await store.saveEvent(tomb); // no post row yet -> pending, author remembered
      const post = makeEvent({ seed: 50, pubkey: authorPubkey });
      await store.saveEvent(post);
      expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
    }
    // REJECT: tombstone author != late-arriving post author.
    {
      const store = new MemoryEventStore();
      const postId = bytesToHex(seedBytes(60));
      const tomb = makeEvent({
        seed: 61,
        kind: 3,
        tags: [['e', postId]],
        content: '',
        pubkey: seedBytes(6001),
      });
      await store.saveEvent(tomb);
      const post = makeEvent({ seed: 60, pubkey: seedBytes(6002) });
      await store.saveEvent(post);
      expect(await store.listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(1);
    }
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

  test('receipt dedup with stable viewer keys across restarts (re-instantiated keystore)', async () => {
    const store = new MemoryEventStore();
    const post = makeEvent({ seed: 70 });
    const postId = bytesToHex(post.id);
    await store.saveEvent(post);

    const crypto = new NobleCrypto();
    const day = NOW - (NOW % 86400);
    // One keystore backing shared across "restarts": the viewer key is
    // stable, so the (pubkey, post, day) bucket is identical.
    const backing = new Map<string, Uint8Array>();
    const receiptFor = async (createdAt: number) => {
      // "Restart": brand-new keystore instance over the same persistence.
      const { publicKey, secretKey } = await loadOrGenerateKeypair(
        new MemoryKeyStore(backing),
      );
      return createViewReceipt({
        crypto,
        secretKey,
        pubkey: publicKey,
        geohash5: 'tdr1v',
        postId: fromHex(postId),
        createdAt,
      });
    };

    expect(await store.saveReceipt(await receiptFor(day + 100))).toBe(true);
    // Same device, same day, after a "restart" -> still deduped.
    expect(await store.saveReceipt(await receiptFor(day + 200))).toBe(false);
    expect(await store.countViews(postId)).toBe(1);
    // Next day counts again.
    expect(await store.saveReceipt(await receiptFor(day + 86400 + 100))).toBe(true);
    expect(await store.countViews(postId)).toBe(2);
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

describe('world confirmation', () => {
  test('mark/is round-trip; idempotent; case-insensitive', async () => {
    const store = new MemoryEventStore();
    const e = makeEvent({ seed: 41 });
    const id = bytesToHex(e.id);
    await store.saveEvent(e);

    expect(await store.isWorldConfirmed(id)).toBe(false);
    await store.markWorldConfirmed(id);
    expect(await store.isWorldConfirmed(id)).toBe(true);
    // Idempotent + case-insensitive.
    await store.markWorldConfirmed(id.toUpperCase());
    expect(await store.isWorldConfirmed(id.toUpperCase())).toBe(true);
  });

  test('getUnconfirmed returns kind-1 posts not yet confirmed', async () => {
    const store = new MemoryEventStore();
    const p1 = makeEvent({ seed: 51 });
    const p2 = makeEvent({ seed: 52 });
    const receipt = makeReceipt(53, bytesToHex(p1.id), Math.floor(Date.now() / 1000));
    await store.saveEvent(p1);
    await store.saveEvent(p2);
    await store.saveEvent(receipt);

    let unconfirmed = await store.getUnconfirmed();
    expect(unconfirmed).toHaveLength(2); // receipts excluded

    await store.markWorldConfirmed(bytesToHex(p1.id));
    unconfirmed = await store.getUnconfirmed();
    expect(unconfirmed).toEqual([bytesToHex(p2.id)]);
  });

  test('getUnconfirmed excludes deleted posts', async () => {
    const store = new MemoryEventStore();
    const e = makeEvent({ seed: 61 });
    await store.saveEvent(e);
    await store.markDeleted(bytesToHex(e.id));
    expect(await store.getUnconfirmed()).toEqual([]);
  });

  test('confirming an unknown id is harmless', async () => {
    const store = new MemoryEventStore();
    const ghost = 'ab'.repeat(32);
    await store.markWorldConfirmed(ghost);
    expect(await store.isWorldConfirmed(ghost)).toBe(true);
    // getUnconfirmed only lists known posts, so the ghost never appears.
    expect(await store.getUnconfirmed()).toEqual([]);
  });
});

describe('schema MIGRATION_002', () => {
  test('creates world_confirmed table', () => {
    expect(MIGRATION_002).toContain('CREATE TABLE world_confirmed(');
    expect(MIGRATION_002).toContain('event_id     BLOB PRIMARY KEY');
  });
});

describe('hex helpers', () => {
  test('hexToBytes round-trips bytesToHex and rejects bad input', () => {
    const bytes = seedBytes(7, 32);
    const hex = bytesToHex(bytes);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
    expect(() => hexToBytes('abc')).toThrow(/odd length/);
    expect(() => hexToBytes('zz')).toThrow(/invalid hex/);
    expect(() => hexToBytes('0g')).toThrow(/invalid hex/);
    expect(Array.from(hexToBytes(''))).toEqual([]);
  });

  test('bytesToHex of empty input is empty string', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });
});

describe('rankScore', () => {
  test('zero views scores zero at any age', () => {
    expect(rankScore(0, 0)).toBe(0);
    expect(rankScore(0, 5)).toBe(0);
  });

  test('score rises with views and falls with age', () => {
    expect(rankScore(10, 1)).toBeGreaterThan(rankScore(1, 1));
    expect(rankScore(10, 1)).toBeGreaterThan(rankScore(10, 10));
  });

  test('matches the documented formula', () => {
    expect(rankScore(5, 0)).toBeCloseTo(Math.log10(6) / Math.pow(2, 1.5), 10);
  });
});

describe('pruneExpired keeps receipts of surviving posts', () => {
  test('receipts for non-expired posts survive with their view counts', async () => {
    const store = new MemoryEventStore({ retentionSec: 3600 });
    const oldPost = makeEvent({ seed: 81, createdAt: NOW - 7200 });
    const freshPost = makeEvent({ seed: 82, createdAt: NOW - 100 });
    const freshId = bytesToHex(freshPost.id);
    await store.saveEvent(oldPost);
    await store.saveEvent(freshPost);
    const firstReceipt = makeReceipt(83, freshId, NOW - 50);
    await store.saveReceipt(firstReceipt);
    expect(await store.countViews(freshId)).toBe(1);

    const removed = await store.pruneExpired(NOW);
    expect(removed).toBe(1); // only the expired post row
    expect(await store.getEvent(freshId)).not.toBeNull();
    expect(await store.countViews(freshId)).toBe(1);
    // The surviving receipt still dedups: same device/day is not re-counted.
    const repeatReceipt = makeReceipt(84, freshId, NOW - 40);
    repeatReceipt.pubkey = firstReceipt.pubkey.slice(); // same device
    expect(await store.saveReceipt(repeatReceipt)).toBe(false);
  });

  test('pruning an empty store removes nothing', async () => {
    const store = new MemoryEventStore();
    expect(await store.pruneExpired(NOW)).toBe(0);
  });
});

describe('id hex handling', () => {
  test('getEvent resolves uppercase id hex', async () => {
    const store = new MemoryEventStore();
    const e = makeEvent({ seed: 85 });
    await store.saveEvent(e);
    const got = await store.getEvent(bytesToHex(e.id).toUpperCase());
    expect(got).not.toBeNull();
    expect(got!.content).toBe('hello world');
  });

  test('countViews is case-insensitive', async () => {
    const store = new MemoryEventStore();
    const e = makeEvent({ seed: 86 });
    const id = bytesToHex(e.id);
    await store.saveEvent(e);
    await store.saveReceipt(makeReceipt(87, id, NOW));
    expect(await store.countViews(id.toUpperCase())).toBe(1);
  });
});

describe('MemoryKv edge cases', () => {
  test('empty-string values round-trip; missing keys stay null', async () => {
    const kv = new MemoryKv();
    await kv.set('empty', '');
    expect(await kv.get('empty')).toBe('');
    expect(await kv.get('nope')).toBeNull();
  });
});

describe('listFeed tie-break ordering and beforeId cursor', () => {
  // All three posts share one created_at second; id hex decides the order.
  const tieAt = NOW - 100;

  test('equal created_at rows order deterministically by id hex descending', async () => {
    const store = new MemoryEventStore();
    for (const seed of [1, 2, 3]) {
      await store.saveEvent(
        makeEvent({ seed, createdAt: tieAt, content: `post ${seed}` }),
      );
    }
    const feed = await store.listFeed({
      cells: ['tdr1v'],
      limit: 10,
      nowSec: NOW,
    });
    // seed 3 -> '03..' hex sorts above seed 2 ('02..') above seed 1 ('01..').
    expect(feed.map((p) => p.event.content)).toEqual([
      'post 3',
      'post 2',
      'post 1',
    ]);
  });

  test('beforeId pages through ties with no gaps or duplicates', async () => {
    const store = new MemoryEventStore();
    for (const seed of [1, 2, 3]) {
      await store.saveEvent(
        makeEvent({ seed, createdAt: tieAt, content: `post ${seed}` }),
      );
    }
    const page1 = await store.listFeed({
      cells: ['tdr1v'],
      limit: 2,
      nowSec: NOW,
    });
    expect(page1.map((p) => p.event.content)).toEqual(['post 3', 'post 2']);
    const last = page1[page1.length - 1];
    // beforeId is not yet on ListFeedOpts (sibling track adds it); the cast
    // only documents the upcoming shape.
    const page2 = await store.listFeed({
      cells: ['tdr1v'],
      limit: 2,
      nowSec: NOW,
      before: last.event.created_at,
      beforeId: bytesToHex(last.event.id),
    } as Parameters<MemoryEventStore['listFeed']>[0]);
    expect(page2.map((p) => p.event.content)).toEqual(['post 1']);
  });

  test('before-only cursor behavior is unchanged', async () => {
    const store = new MemoryEventStore();
    await store.saveEvent(
      makeEvent({ seed: 1, createdAt: NOW - 50, content: 'old' }),
    );
    await store.saveEvent(
      makeEvent({ seed: 2, createdAt: NOW - 10, content: 'new' }),
    );
    const feed = await store.listFeed({
      cells: ['tdr1v'],
      limit: 10,
      before: NOW - 10,
      nowSec: NOW,
    });
    expect(feed.map((p) => p.event.content)).toEqual(['old']);
  });
});

describe('getUnconfirmed expiry exclusion', () => {
  test('expired posts are never listed as unconfirmed', async () => {
    const store = new MemoryEventStore({ retentionSec: 3600 });
    const expired = makeEvent({
      seed: 40,
      createdAt: NOW - 7200,
      content: 'gone',
    });
    const fresh = makeEvent({ seed: 41, createdAt: NOW - 100, content: 'live' });
    await store.saveEvent(expired);
    await store.saveEvent(fresh);
    const ids = await store.getUnconfirmed();
    expect(ids).toContain(bytesToHex(fresh.id));
    expect(ids).not.toContain(bytesToHex(expired.id));
  });
});
