// SPDX-License-Identifier: Apache-2.0
// Feed Unsent state: an own post whose outbox row says it reached no
// transport shows 'Unsent' instead of a silent missing globe. Other
// authors' posts never show it, World confirmation always wins, and
// a fresh pending row is still trying, not unsent.

import { NobleCrypto, signEvent, toHex, EVENT_KIND_POST, type EventKind, type SignedEvent } from '@airplane/protocol';
import { getPostCardById, listFeedPosts, resolvePostUnsent } from './feed';
import { getStore, __resetStoreForTests } from './store';
import { signDeviceEvent, __resetDeviceKeypairForTests } from './identity';
import { __resetStarsForTests } from './stars';
import { __resetResharesForTests } from './reshares';

const crypto = new NobleCrypto();
const NOW_SEC = Math.floor(Date.now() / 1000);

async function makeOwnPost(createdAt: number): Promise<SignedEvent> {
  return signDeviceEvent({
    created_at: createdAt,
    kind: EVENT_KIND_POST as EventKind,
    geohash: 'tdr1v',
    tags: [],
    content: 'own unsent post',
  });
}

function makeOtherPost(createdAt: number): SignedEvent {
  const kp = crypto.generateKeypair();
  return signEvent(crypto, kp.secretKey, {
    pubkey: kp.publicKey,
    created_at: createdAt,
    kind: EVENT_KIND_POST as EventKind,
    geohash: 'tdr1v',
    tags: [],
    content: 'other post',
  });
}

beforeEach(() => {
  __resetStoreForTests();
  __resetDeviceKeypairForTests();
  __resetStarsForTests();
  __resetResharesForTests();
});

describe('resolvePostUnsent', () => {
  test('unsent status is unsent, ble-sent is not, world wins, non-own never', () => {
    const base = { createdAtMs: NOW_SEC * 1000 - 60_000, isOwn: true, worldConfirmed: false };
    expect(resolvePostUnsent({ ...base, outboxStatus: 'unsent' })).toBe(true);
    expect(resolvePostUnsent({ ...base, outboxStatus: 'ble-sent' })).toBe(false);
    expect(resolvePostUnsent({ ...base, outboxStatus: 'unsent', worldConfirmed: true })).toBe(false);
    expect(resolvePostUnsent({ ...base, outboxStatus: 'unsent', isOwn: false })).toBe(false);
    expect(resolvePostUnsent({ ...base })).toBe(false);
  });

  test('pending older than the window is unsent, fresh pending is still trying', () => {
    expect(
      resolvePostUnsent({
        outboxStatus: 'pending',
        createdAtMs: NOW_SEC * 1000 - 60_000,
        isOwn: true,
        worldConfirmed: false,
      }),
    ).toBe(true);
    expect(
      resolvePostUnsent({
        outboxStatus: 'pending',
        createdAtMs: NOW_SEC * 1000,
        isOwn: true,
        worldConfirmed: false,
        nowMs: NOW_SEC * 1000 + 1000,
      }),
    ).toBe(false);
  });
});

describe('feed cards with an outbox row', () => {
  test('own unsent post shows unsent, other author post does not', async () => {
    const own = await makeOwnPost(NOW_SEC - 60);
    const other = makeOtherPost(NOW_SEC - 60);
    const store = getStore();
    await store.saveEvent(own);
    await store.saveEvent(other);
    await store.enqueuePostOutbox(toHex(own.id), own.created_at);
    await store.markPostOutboxAttempt(toHex(own.id), 'unsent');
    await store.enqueuePostOutbox(toHex(other.id), other.created_at);
    await store.markPostOutboxAttempt(toHex(other.id), 'unsent');
    const cards = await listFeedPosts({ cells: ['tdr1v'] });
    const ownCard = cards.find((c) => c.eventId === toHex(own.id));
    const otherCard = cards.find((c) => c.eventId === toHex(other.id));
    expect(ownCard).toBeDefined();
    expect(ownCard!.unsent).toBe(true);
    expect(ownCard!.worldConfirmed).toBe(false);
    expect(otherCard).toBeDefined();
    expect(otherCard!.unsent).toBe(false);
  });

  test('World confirmation clears unsent on the detail card', async () => {
    const own = await makeOwnPost(NOW_SEC - 60);
    const store = getStore();
    await store.saveEvent(own);
    await store.enqueuePostOutbox(toHex(own.id), own.created_at);
    await store.markPostOutboxAttempt(toHex(own.id), 'unsent');
    const before = await getPostCardById(toHex(own.id));
    expect(before!.unsent).toBe(true);
    await store.markWorldConfirmed(toHex(own.id));
    const after = await getPostCardById(toHex(own.id));
    expect(after!.worldConfirmed).toBe(true);
    expect(after!.unsent).toBe(false);
  });
});
