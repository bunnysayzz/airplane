// SPDX-License-Identifier: Apache-2.0
// Reshare service: optimistic own-reshare toggle + inbound application +
// cross-restart rehydration from stored kind-5 events.

import { NobleCrypto, createReshare, fromHex, toHex } from '@airplane/protocol';
import {
  __resetResharesForTests,
  getMyPubkeyHex,
  markResharePostKnown,
  recordReshareEvent,
  rehydrateReshares,
  reshareViewFor,
  toggleReshare,
} from './reshares';
import { __resetDeviceKeypairForTests } from './identity';
import { __resetStoreForTests, getStore } from './store';
import type { PostCardModel } from './types';

const crypto = new NobleCrypto();
const POST = 'b'.repeat(64);
const AUTHOR = 'a'.repeat(64);

function makeCard(postId: string): PostCardModel {
  return {
    eventId: postId,
    createdAtMs: Date.now(),
    authorLabel: 'author',
    body: 'test post',
    geohash: 'tdr1v',
    views: 0,
    score: 0,
    worldConfirmed: false,
    authorPubkeyHex: AUTHOR,
    reshares: 0,
    resharedByMe: false,
    stars: 0,
    starLabel: '',
    starredByMe: false,
  };
}

beforeEach(async () => {
  __resetResharesForTests();
  __resetDeviceKeypairForTests();
  __resetStoreForTests();
  await getStore().saveEvent({
    id: fromHex(POST),
    pubkey: fromHex(AUTHOR),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    geohash: 'tdr1v',
    tags: [],
    content: 'seed post',
    sig: new Uint8Array(64),
  });
});

afterEach(() => {
  __resetResharesForTests();
  __resetDeviceKeypairForTests();
  __resetStoreForTests();
});

describe('toggleReshare (optimistic own reshare)', () => {
  test('first toggle reshares immediately and fans the kind-5 event out; second toggle unreshares', async () => {
    const published: unknown[] = [];
    const publish = jest.fn(async (e: unknown) => {
      published.push(e);
    });
    const card = makeCard(POST);
    const id1 = await toggleReshare(card, { publish });
    expect(typeof id1).toBe('string');
    expect(id1).toHaveLength(64);
    expect(publish).toHaveBeenCalledTimes(1);
    const ownHex = await getMyPubkeyHex();
    expect(ownHex).toBeDefined();
    const view = reshareViewFor(POST, ownHex);
    expect(view.resharedByMe).toBe(true);
    expect(view.reshares).toBe(1);

    const id2 = await toggleReshare(card, { publish });
    expect(id2).not.toBe(id1);
    expect(publish).toHaveBeenCalledTimes(2);
    const after = reshareViewFor(POST, ownHex);
    expect(after.resharedByMe).toBe(false);
    expect(after.reshares).toBe(0);
  });

  test('a publish failure still leaves the optimistic local reshare in place', async () => {
    const publish = jest.fn(async () => {
      throw new Error('radio down');
    });
    await toggleReshare(makeCard(POST), { publish });
    const ownHex = await getMyPubkeyHex();
    const view = reshareViewFor(POST, ownHex);
    expect(view.resharedByMe).toBe(true);
    expect(view.reshares).toBe(1);
  });

  test('toggle refuses a card with no author pubkey instead of emitting a malformed event', async () => {
    const card = makeCard(POST);
    delete card.authorPubkeyHex;
    await expect(toggleReshare(card, { publish: jest.fn() })).rejects.toThrow(
      /authorPubkeyHex/,
    );
  });

  test('toggle rejects an unknown or malformed post id without publishing', async () => {
    const publish = jest.fn();
    await expect(toggleReshare(makeCard('c'.repeat(64)), { publish })).rejects.toThrow(
      /unknown post id/,
    );
    await expect(toggleReshare(makeCard('not-hex'), { publish })).rejects.toThrow(
      /invalid post id/,
    );
    const badAuthor = makeCard(POST);
    badAuthor.authorPubkeyHex = 'zz';
    await expect(toggleReshare(badAuthor, { publish })).rejects.toThrow(
      /invalid author pubkey/,
    );
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('recordReshareEvent (inbound)', () => {
  test('a verified remote reshare counts; an unverified one never does', () => {
    const other = crypto.generateKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    markResharePostKnown(POST);
    const event = createReshare({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      originalPostId: fromHex(POST),
      originalAuthorPubkey: fromHex(AUTHOR),
      createdAt: nowSec,
    });
    expect(recordReshareEvent(event)).toBe('counted');
    expect(reshareViewFor(POST).reshares).toBe(1);

    const forgedFresh = createReshare({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      originalPostId: fromHex(POST),
      originalAuthorPubkey: fromHex(AUTHOR),
      createdAt: nowSec + 1,
    });
    const forgedEvent = { ...forgedFresh, sig: new Uint8Array(64) };
    expect(recordReshareEvent(forgedEvent)).toBe('ignored');
    expect(reshareViewFor(POST).reshares).toBe(1);
  });

  test('a reshare for an unknown post stays pending until the post is known', () => {
    const other = crypto.generateKeypair();
    const event = createReshare({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      originalPostId: fromHex(POST),
      originalAuthorPubkey: fromHex(AUTHOR),
    });
    expect(recordReshareEvent(event)).toBe('pending');
    expect(reshareViewFor(POST).reshares).toBe(0);
    markResharePostKnown(POST);
    const view = reshareViewFor(POST);
    expect(view.reshares).toBe(1);
    expect(view.latestResharerLabel).toBeDefined();
  });
});

describe('rehydrateReshares (cross-restart)', () => {
  test('a stored own reshare restores count and self state after a counter reset', async () => {
    const publish = jest.fn(async () => {});
    await toggleReshare(makeCard(POST), { publish });
    const stored = await getStore().listReshareEvents();
    expect(stored).toHaveLength(1);
    expect(toHex(stored[0].id)).toHaveLength(64);

    // Simulate an app restart: fresh counter, same store.
    __resetResharesForTests();
    expect(reshareViewFor(POST).reshares).toBe(0);
    const applied = await rehydrateReshares();
    expect(applied).toBe(1);
    // The post is not known in the fresh counter yet, so the replayed
    // reshare sits pending until the feed marks the post known.
    expect(reshareViewFor(POST).reshares).toBe(0);
    markResharePostKnown(POST);
    const ownHex = await getMyPubkeyHex();
    const view = reshareViewFor(POST, ownHex);
    expect(view.reshares).toBe(1);
    expect(view.resharedByMe).toBe(true);

    // Replaying again is a duplicate no-op, never a double count.
    expect(await rehydrateReshares()).toBe(0);
    expect(reshareViewFor(POST, ownHex).reshares).toBe(1);
  });
});
