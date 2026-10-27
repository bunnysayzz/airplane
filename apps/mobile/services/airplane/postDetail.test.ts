// SPDX-License-Identifier: Apache-2.0
// Regression tests for the post-detail lookup (v0.1.4 bug: tapping a feed
// post opened "This post could not be found").
//
// Root cause: the post-detail route ran the cell-scoped feed query with
// `cells: []`, and both stores match `cells` as a set, so an empty list
// matched NOTHING — even though the tapped post was in the store. The fix
// looks the post up directly by id (getPostCardById), with no cell scope.
// These tests pin that contract: a saved post resolves by id no matter
// which cell it is in, and the old empty-cells query provably returns [].

import {
  signEvent,
  toHex,
  EVENT_KIND_POST,
  type EventKind,
  type SignedEvent,
} from '@airplane/protocol';
import { NobleCrypto } from '@airplane/protocol';
import { getPostCardById, listFeedPosts } from './feed';
import { getStore, __resetStoreForTests } from './store';

const crypto = new NobleCrypto();

function makePost(overrides: Partial<SignedEvent> = {}): SignedEvent {
  const kp = crypto.generateKeypair();
  return signEvent(crypto, kp.secretKey, {
    pubkey: kp.publicKey,
    created_at: Math.floor(Date.now() / 1000) - 60,
    kind: EVENT_KIND_POST as EventKind,
    geohash: 'tdr1v',
    tags: [],
    content: 'mesh post',
    ...overrides,
  });
}

beforeEach(() => {
  __resetStoreForTests();
});

test('resolves a saved post by id with its content', async () => {
  const post = makePost();
  await getStore().saveEvent(post);
  const card = await getPostCardById(toHex(post.id));
  expect(card).not.toBeNull();
  expect(card!.eventId).toBe(toHex(post.id));
  expect(card!.body).toBe('mesh post');
  expect(card!.views).toBe(0);
  expect(card!.worldConfirmed).toBe(false);
});

test('resolves a post in a far-away cell (lookup is cell-independent)', async () => {
  const post = makePost({ geohash: 'u4pru' });
  await getStore().saveEvent(post);
  const card = await getPostCardById(toHex(post.id));
  expect(card).not.toBeNull();
  expect(card!.body).toBe('mesh post');
});

test('returns null for an unknown id', async () => {
  const unsaved = makePost();
  await expect(getPostCardById(toHex(unsaved.id))).resolves.toBeNull();
});

test('returns null (never throws) for malformed ids', async () => {
  await expect(getPostCardById('xyz')).resolves.toBeNull();
  await expect(getPostCardById('')).resolves.toBeNull();
  await expect(getPostCardById('a'.repeat(63))).resolves.toBeNull();
});

test('returns null for an expired post', async () => {
  const post = makePost({ created_at: Math.floor(Date.now() / 1000) - 2 * 86400 });
  await getStore().saveEvent(post);
  await expect(getPostCardById(toHex(post.id))).resolves.toBeNull();
});

test('documents the old bug: an empty-cells feed query matches nothing', async () => {
  const post = makePost();
  await getStore().saveEvent(post);
  await expect(listFeedPosts({ cells: [], limit: 200 })).resolves.toEqual([]);
});
