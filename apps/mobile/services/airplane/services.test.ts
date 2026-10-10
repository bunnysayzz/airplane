// SPDX-License-Identifier: Apache-2.0
// Unit tests for the data-layer pure logic: card mapping, uplink tag
// inclusion/exclusion, view-id extraction. Store-backed behavior is exercised
// through the real in-memory driver (no mocks of protocol/storage).

import {
  signEvent,
  toHex,
  EVENT_KIND_POST,
  type EventKind,
  type FeedPost,
  type SignedEvent,
} from '@airplane/protocol';
import { NobleCrypto } from '@airplane/protocol';
import {
  authorLabelFor,
  hasUplinkTag,
  toPostCardModel,
  listFeedPosts,
  subscribeFeed,
  notifyFeedListeners,
  __resetFeedListenersForTests,
} from './feed';
import { tagsForPublish, publishPost, getLocationCell } from './composer';
import {
  extractNewViewIds,
  emitViewReceipt,
  __resetViewTrackerForTests,
} from './viewTracker';
import { getStore, __resetStoreForTests } from './store';
import { __resetDeviceKeypairForTests } from './identity';

const crypto = new NobleCrypto();

function makePost(overrides: Partial<SignedEvent> = {}): SignedEvent {
  const kp = crypto.generateKeypair();
  return signEvent(crypto, kp.secretKey, {
    pubkey: kp.publicKey,
    created_at: 1_750_000_000,
    kind: EVENT_KIND_POST as EventKind,
    geohash: 'tdr1v',
    tags: [],
    content: 'mesh post',
    ...overrides,
  });
}

function feedPostOf(event: SignedEvent, views = 0, score = 0.5): FeedPost {
  return { event, views, score, ageHours: 1 };
}

beforeEach(() => {
  __resetStoreForTests();
  __resetDeviceKeypairForTests();
  __resetViewTrackerForTests();
  __resetFeedListenersForTests();
});

// --- mapping ---------------------------------------------------------------

describe('toPostCardModel', () => {
  it('maps every field the card needs', () => {
    const e = makePost();
    const card = toPostCardModel(feedPostOf(e, 7, 0.123));
    expect(card.eventId).toBe(toHex(e.id));
    expect(card.createdAtMs).toBe(e.created_at * 1000);
    expect(card.authorLabel).toBe('anon·' + toHex(e.pubkey).slice(0, 4));
    expect(card.body).toBe('mesh post');
    expect(card.geohash).toBe('tdr1v');
    expect(card.views).toBe(7);
    expect(card.score).toBe(0.123);
    expect(card.uplinked).toBe(false);
  });

  it('marks uplinked when the signed tag is present', () => {
    const e = makePost({ tags: [['uplink', '1']] });
    expect(toPostCardModel(feedPostOf(e)).uplinked).toBe(true);
  });
});

describe('authorLabelFor', () => {
  it('is anon + first 4 hex chars', () => {
    const kp = crypto.generateKeypair();
    expect(authorLabelFor(kp.publicKey)).toBe('anon·' + toHex(kp.publicKey).slice(0, 4));
    expect(authorLabelFor(kp.publicKey)).toMatch(/^anon·[0-9a-f]{4}$/);
  });
});

describe('hasUplinkTag', () => {
  it('accepts only the exact signed ["uplink","1"] tag', () => {
    expect(hasUplinkTag([['uplink', '1']])).toBe(true);
    expect(hasUplinkTag([])).toBe(false);
    expect(hasUplinkTag([['uplink', '0']])).toBe(false);
    expect(hasUplinkTag([['e', '1']])).toBe(false);
    expect(hasUplinkTag([['uplink']])).toBe(false);
  });
});

// --- composer ----------------------------------------------------------------

describe('tagsForPublish', () => {
  it('includes the uplink tag ONLY when opted in', () => {
    expect(tagsForPublish({ uplink: true })).toEqual([['uplink', '1']]);
    expect(tagsForPublish({ uplink: false })).toEqual([]);
  });
});

describe('publishPost', () => {
  it('stores the post and returns its event id (hex)', async () => {
    const id = await publishPost('hello mesh', { uplink: false, geohash5: 'tdr1v' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const saved = await getStore().getEvent(id);
    expect(saved).not.toBeNull();
    expect(saved!.content).toBe('hello mesh');
    expect(saved!.tags).toEqual([]);
    expect(saved!.kind).toBe(1);
  });

  it('embeds the signed uplink tag when opted in', async () => {
    const id = await publishPost('world post', { uplink: true, geohash5: 'tdr1v' });
    const saved = await getStore().getEvent(id);
    expect(saved!.tags).toEqual([['uplink', '1']]);
  });

  it('rejects empty / overlong bodies via protocol validation', async () => {
    await expect(publishPost('', { uplink: false, geohash5: 'tdr1v' })).rejects.toThrow();
    await expect(publishPost('x'.repeat(281), { uplink: false, geohash5: 'tdr1v' })).rejects.toThrow();
  });

  it('fails loudly without a cell: getLocationCell is an honest stub (TODO(LOC-1))', async () => {
    expect(() => getLocationCell()).toThrow(/location unavailable/);
    await expect(publishPost('no cell', { uplink: false })).rejects.toThrow(
      /location unavailable/,
    );
    // No fake coords are ever written: nothing landed in the store.
    expect(await getStore().listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
  });

  it('notifies feed subscribers after publish', async () => {
    const seen: number[] = [];
    const unsub = subscribeFeed(() => seen.push(1));
    await publishPost('ping', { uplink: false, geohash5: 'tdr1v' });
    expect(seen).toHaveLength(1);
    unsub();
    await publishPost('pong', { uplink: false, geohash5: 'tdr1v' });
    expect(seen).toHaveLength(1);
  });
});

// --- feed --------------------------------------------------------------------

describe('listFeedPosts', () => {
  it('maps stored posts to card models, ranked by score desc', async () => {
    const a = await publishPost('older popular', { uplink: false, geohash5: 'tdr1v' });
    const b = await publishPost('newer quiet', { uplink: true, geohash5: 'tdr1v' });
    // inflate views on the older post so it must rank above the newer one
    for (let i = 0; i < 5; i++) {
      await emitViewReceipt(a);
      __resetViewTrackerForTests(); // allow another receipt: new viewer keypair
      __resetDeviceKeypairForTests();
    }
    const cards = await listFeedPosts({ cells: ['tdr1v'] });
    expect(cards.map((c) => c.eventId)).toEqual([a, b]);
    expect(cards[0].views).toBeGreaterThanOrEqual(1);
    expect(cards[1].uplinked).toBe(true);
    expect(cards[0].authorLabel).toMatch(/^anon·[0-9a-f]{4}$/);
  });

  it('scopes by cell and applies the before cursor', async () => {
    await publishPost('here', { uplink: false, geohash5: 'tdr1v' });
    await publishPost('there', { uplink: false, geohash5: 'abcde' });
    expect(await listFeedPosts({ cells: ['tdr1v'] })).toHaveLength(1);
    const all = await listFeedPosts({ cells: ['tdr1v', 'abcde'] });
    expect(all).toHaveLength(2);
    const paged = await listFeedPosts({
      cells: ['tdr1v', 'abcde'],
      before: all[0].createdAtMs / 1000,
    });
    expect(paged.map((c) => c.eventId)).not.toContain(all[0].eventId);
  });
});

describe('subscribeFeed / notifyFeedListeners', () => {
  it('notifies and unsubscribes cleanly', () => {
    const calls: number[] = [];
    const unsub = subscribeFeed(() => calls.push(1));
    notifyFeedListeners();
    unsub();
    notifyFeedListeners();
    expect(calls).toEqual([1]);
  });
});

// --- view tracker ------------------------------------------------------------

describe('extractNewViewIds', () => {
  it('returns only valid unseen ids and records them in prev', () => {
    const prev = new Set<string>();
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    expect(extractNewViewIds(prev, [a, b, 'not-hex', '', a, 'A'.repeat(64)])).toEqual([
      a,
      b,
    ]);
    expect(prev.has(a)).toBe(true);
    expect(prev.has(b)).toBe(true);
  });

  it('returns [] on a repeat pass (already seen)', () => {
    const prev = new Set<string>();
    const a = 'c'.repeat(64);
    extractNewViewIds(prev, [a]);
    expect(extractNewViewIds(prev, [a])).toEqual([]);
  });

  it('is case-insensitive and tolerates non-string junk', () => {
    const prev = new Set<string>();
    const out = extractNewViewIds(prev, ['D'.repeat(64), undefined as never, null as never]);
    expect(out).toEqual(['d'.repeat(64)]);
  });
});

describe('emitViewReceipt', () => {
  it('creates a countable receipt and respects store dedup', async () => {
    const id = await publishPost('view me', { uplink: false, geohash5: 'tdr1v' });
    expect(await emitViewReceipt(id)).toBe(true);
    // same device + same UTC day -> deduped by the store
    expect(await emitViewReceipt(id)).toBe(false);
    expect(await getStore().countViews(id)).toBe(1);
  });

  it('returns false for unknown posts', async () => {
    expect(await emitViewReceipt('e'.repeat(64))).toBe(false);
  });
});
