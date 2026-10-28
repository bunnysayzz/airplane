// SPDX-License-Identifier: Apache-2.0
// Star service: optimistic own-star toggle + inbound star application.

import { NobleCrypto, createStarEvent, createUnstarEvent, fromHex } from '@airplane/protocol';
import {
  __flushStarPersistenceForTests,
  __resetStarsForTests,
  applyIncomingStar,
  ensureStarsHydrated,
  getStarCounter,
  markStarPostKnown,
  resolveOwnPubkeyHex,
  starViewFor,
  toggleStar,
} from './stars';
import { __resetDeviceKeypairForTests } from './identity';
import { __resetFeedListenersForTests } from './feed';
import { getStore, __resetStoreForTests } from './store';

const crypto = new NobleCrypto();
const POST = 'b'.repeat(64);

/** Seed the post the toggles act on: toggles require a stored kind-1 post. */
async function seedPost(): Promise<void> {
  await getStore().saveEvent({
    id: fromHex(POST),
    pubkey: fromHex('a'.repeat(64)),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    geohash: 'tdr1v',
    tags: [],
    content: 'seed post',
    sig: new Uint8Array(64),
  });
}

beforeEach(async () => {
  __resetStarsForTests();
  __resetDeviceKeypairForTests();
  __resetFeedListenersForTests();
  __resetStoreForTests();
  await seedPost();
});

afterEach(() => {
  __resetStarsForTests();
  __resetDeviceKeypairForTests();
  __resetFeedListenersForTests();
  __resetStoreForTests();
});

describe('toggleStar (optimistic own star)', () => {
  test('first toggle stars immediately and fans the kind-4 event out; second toggle unstars', async () => {
    const published: unknown[] = [];
    const publish = jest.fn(async (e: unknown) => {
      published.push(e);
    });
    const starred = await toggleStar(POST, 'tdr1v', { publish });
    expect(starred).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const ownHex = await resolveOwnPubkeyHex();
    expect(ownHex).not.toBeNull();
    // Optimistic: the filled star shows from local state alone.
    const view = starViewFor(POST, ownHex);
    expect(view.starredByMe).toBe(true);
    expect(view.count).toBe(1);
    expect(view.label).toBe('1+');

    const unstarred = await toggleStar(POST, 'tdr1v', { publish });
    expect(unstarred).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
    const after = starViewFor(POST, ownHex);
    expect(after.starredByMe).toBe(false);
    expect(after.count).toBe(0);
    expect(after.label).toBe('');
  });

  test('toggleStar returns only after the star row is durable (no flush seam)', async () => {
    const publish = jest.fn(async () => {});
    await toggleStar(POST, 'tdr1v', { publish });
    // No __flushStarPersistenceForTests call: the row must already be on
    // disk when the toggle promise resolves, or a kill here resurrects
    // the old star state on restart.
    expect(await getStore().listStarEvents()).toHaveLength(1);
    expect(await getStore().listStarKnownPosts()).toContain(POST);
  });

  test('toggle rejects an unknown or malformed post id without publishing', async () => {
    const publish = jest.fn();
    await expect(toggleStar('c'.repeat(64), 'tdr1v', { publish })).rejects.toThrow(
      /unknown post id/,
    );
    await expect(toggleStar('not-hex', 'tdr1v', { publish })).rejects.toThrow(
      /invalid post id/,
    );
    expect(publish).not.toHaveBeenCalled();
    const ownHex = await resolveOwnPubkeyHex();
    expect(starViewFor('c'.repeat(64), ownHex).starredByMe).toBe(false);
  });

  test('a publish failure still leaves the optimistic local star in place', async () => {
    const publish = jest.fn(async () => {
      throw new Error('radio down');
    });
    const starred = await toggleStar(POST, 'tdr1v', { publish });
    expect(starred).toBe(true);
    const ownHex = await resolveOwnPubkeyHex();
    expect(starViewFor(POST, ownHex).starredByMe).toBe(true);
  });
});

describe('applyIncomingStar', () => {
  test('a verified remote star counts; an unverified one never does', () => {
    const other = crypto.generateKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    // Inbound stars for a post with no local row sit in the pending queue;
    // this test's post is "known" (as a feed row would make it).
    getStarCounter().markPostKnown(POST);
    const event = createStarEvent({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      postId: fromHex(POST),
      createdAt: nowSec,
    });
    expect(applyIncomingStar(event)).toBe(true);
    expect(getStarCounter().view(POST).count).toBe(1);

    // Fresh timestamp so the only reason to reject is verification
    // (not dedup against the counted event above).
    const forgedFresh = createStarEvent({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      postId: fromHex(POST),
      createdAt: nowSec + 1,
    });
    const forgedEvent = { ...forgedFresh, sig: new Uint8Array(64) };
    expect(applyIncomingStar(forgedEvent)).toBe(false);
    expect(getStarCounter().view(POST).count).toBe(1);
  });
});

describe('star persistence across restart (T17)', () => {
  // Simulated restart: wipe the in-memory counter only; the store
  // singleton (fresh MemoryEventStore per test) keeps its rows, exactly
  // as SQLite keeps its tables across a real restart.
  async function restart(): Promise<void> {
    await __flushStarPersistenceForTests();
    __resetStarsForTests();
    await ensureStarsHydrated();
  }

  test('own star + count survive restart; zero-count display stays empty', async () => {
    const publish = jest.fn(async () => {});
    await toggleStar(POST, 'tdr1v', { publish });
    const ownHex = await resolveOwnPubkeyHex();
    expect(starViewFor(POST, ownHex).starredByMe).toBe(true);
    expect(starViewFor(POST, ownHex).count).toBe(1);

    await restart();
    const after = starViewFor(POST, ownHex);
    expect(after.starredByMe).toBe(true);
    expect(after.count).toBe(1);
    expect(after.label).toBe('1+');

    // A post with no stars shows no numeral and an outline star.
    const empty = starViewFor('c'.repeat(64), ownHex);
    expect(empty.count).toBe(0);
    expect(empty.label).toBe('');
    expect(empty.starredByMe).toBe(false);
  });

  test('remote star then unstar: latest-wins survives restart', async () => {
    const other = crypto.generateKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    // Use the service mark (not the raw counter) so the known post is
    // persisted too; otherwise the replayed events would stay pending.
    markStarPostKnown(POST);
    await __flushStarPersistenceForTests();
    const star = createStarEvent({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      postId: fromHex(POST),
      createdAt: nowSec,
    });
    expect(applyIncomingStar(star)).toBe(true);
    const unstar = createUnstarEvent({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      postId: fromHex(POST),
      createdAt: nowSec + 1,
    });
    expect(applyIncomingStar(unstar)).toBe(true);
    expect(getStarCounter().view(POST).count).toBe(0);

    await restart();
    expect(getStarCounter().view(POST).count).toBe(0);
    // A late replay of the old star must not resurrect the cancelled star.
    expect(applyIncomingStar(star)).toBe(false);
    expect(getStarCounter().view(POST).count).toBe(0);
  });

  test('pending star survives restart and flushes when the post arrives', async () => {
    const other = crypto.generateKeypair();
    const nowSec = Math.floor(Date.now() / 1000);
    const event = createStarEvent({
      crypto,
      secretKey: other.secretKey,
      pubkey: other.publicKey,
      geohash5: 'tdr1v',
      postId: fromHex(POST),
      createdAt: nowSec,
    });
    // Post unknown: held pending, not counted.
    expect(applyIncomingStar(event)).toBe(false);
    expect(getStarCounter().view(POST).count).toBe(0);

    await restart();
    expect(getStarCounter().view(POST).count).toBe(0);
    markStarPostKnown(POST);
    expect(getStarCounter().view(POST).count).toBe(1);
  });
});
