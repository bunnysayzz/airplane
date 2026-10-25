// SPDX-License-Identifier: Apache-2.0
// Star service: optimistic own-star toggle + inbound star application.

import { NobleCrypto, createStarEvent, fromHex } from '@airplane/protocol';
import {
  __resetStarsForTests,
  applyIncomingStar,
  getStarCounter,
  resolveOwnPubkeyHex,
  starViewFor,
  toggleStar,
} from './stars';
import { __resetDeviceKeypairForTests } from './identity';
import { __resetFeedListenersForTests } from './feed';

const crypto = new NobleCrypto();
const POST = 'b'.repeat(64);

beforeEach(() => {
  __resetStarsForTests();
  __resetDeviceKeypairForTests();
  __resetFeedListenersForTests();
});

afterEach(() => {
  __resetStarsForTests();
  __resetDeviceKeypairForTests();
  __resetFeedListenersForTests();
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
