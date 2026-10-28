// SPDX-License-Identifier: Apache-2.0
// Unit tests for the data-layer pure logic: card mapping, uplink tag
// inclusion/exclusion, view-id extraction. Store-backed behavior is exercised
// through the real in-memory driver (no mocks of protocol/storage).

import {
  signEvent,
  toHex,
  encodeGeohash,
  EVENT_KIND_POST,
  type EventKind,
  type FeedPost,
  type SignedEvent,
} from '@airplane/protocol';
import { NobleCrypto } from '@airplane/protocol';
import {
  authorLabelFor,
  toPostCardModel,
  listFeedPosts,
  listFeedPage,
  subscribeFeed,
  notifyFeedListeners,
  __resetFeedListenersForTests,
} from './feed';
import { tagsForPublish, publishPost, getLocationCell } from './composer';
import {
  locationError,
  setLocationProviderForTests,
  __resetLocationProviderForTests,
  type LocationProvider,
} from './location';
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
  __resetLocationProviderForTests();
});

// --- mapping ---------------------------------------------------------------

describe('toPostCardModel', () => {
  it('maps every field the card needs', () => {
    const e = makePost();
    const card = toPostCardModel(feedPostOf(e, 7, 0.123));
    expect(card.eventId).toBe(toHex(e.id));
    expect(card.createdAtMs).toBe(e.created_at * 1000);
    expect(card.authorLabel).toBe(authorLabelFor(e.pubkey));
    expect(card.authorLabel).toMatch(/^[a-z]+ [a-z]+·[0-9a-f]{4}$/);
    expect(card.body).toBe('mesh post');
    expect(card.geohash).toBe('tdr1v');
    expect(card.views).toBe(7);
    expect(card.score).toBe(0.123);
    expect(card.worldConfirmed).toBe(false);
  });

  it('marks worldConfirmed when passed true', () => {
    const e = makePost({});
    expect(toPostCardModel(feedPostOf(e), true).worldConfirmed).toBe(true);
    expect(toPostCardModel(feedPostOf(e), false).worldConfirmed).toBe(false);
  });
});

describe('authorLabelFor', () => {
  it('is "<adjective> <noun>·<first 4 hex of pubkey>"', () => {
    const kp = crypto.generateKeypair();
    const label = authorLabelFor(kp.publicKey);
    expect(label).toMatch(/^[a-z]+ [a-z]+·[0-9a-f]{4}$/);
    expect(label.endsWith('·' + toHex(kp.publicKey).slice(0, 4))).toBe(true);
  });

  it('is stable: the same identity always maps to the same name', () => {
    const kp = crypto.generateKeypair();
    expect(authorLabelFor(kp.publicKey)).toBe(authorLabelFor(kp.publicKey));
    // Re-deriving from the same bytes (e.g. after reload) gives the same label.
    expect(authorLabelFor(new Uint8Array(kp.publicKey))).toBe(
      authorLabelFor(kp.publicKey),
    );
  });

  it('is distinctive: random identities map to distinct names', () => {
    const labels = new Set<string>();
    for (let i = 0; i < 200; i++) {
      labels.add(authorLabelFor(crypto.generateKeypair().publicKey));
    }
    expect(labels.size).toBe(200);
  });

  it('keeps the suffix recognizable across the old scheme', () => {
    // The old "anon·xxxx" suffix was the pubkey prefix; the new scheme keeps
    // exactly that suffix, so an author known as anon·a3f9 is still ·a3f9.
    const kp = crypto.generateKeypair();
    const oldSuffix = toHex(kp.publicKey).slice(0, 4);
    expect(authorLabelFor(kp.publicKey)).toContain('·' + oldSuffix);
  });
});



// --- composer ----------------------------------------------------------------

describe('tagsForPublish', () => {
  it('returns no tags (single-feed model, no opt-in)', () => {
    expect(tagsForPublish({})).toEqual([]);
  });
});

describe('publishPost', () => {
  it('stores the post and returns its event id (hex)', async () => {
    const id = await publishPost('hello mesh', { geohash5: 'tdr1v' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const saved = await getStore().getEvent(id);
    expect(saved).not.toBeNull();
    expect(saved!.content).toBe('hello mesh');
    expect(saved!.tags).toEqual([]);
    expect(saved!.kind).toBe(1);
  });

  

  it('rejects empty / overlong bodies via protocol validation', async () => {
    await expect(publishPost('', { geohash5: 'tdr1v' })).rejects.toThrow();
    await expect(publishPost('x'.repeat(281), { geohash5: 'tdr1v' })).rejects.toThrow();
  });

  it('fails loudly without a cell: permission-denied is typed, nothing is faked', async () => {
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('permission-denied');
      },
    });
    await expect(publishPost('no cell', {})).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(publishPost('no cell', {})).rejects.toThrow(
      /location\/permission-denied/,
    );
    // No fake coords are ever written: nothing landed in the store.
    expect(await getStore().listFeed({ cells: ['tdr1v'], limit: 10 })).toHaveLength(0);
  });

  it('fails loudly on a GPS timeout', async () => {
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('timeout');
      },
    });
    await expect(publishPost('slow gps', {})).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('resolves the cell through the provider and encodes with the real geohash encoder', async () => {
    // Bengaluru coords: the encoder (not a hardcoded string) decides the cell.
    const expected = encodeGeohash(12.9716, 77.5946, 5);
    const provider: LocationProvider = {
      getCurrentCell: async () => expected,
    };
    setLocationProviderForTests(provider);
    await expect(getLocationCell()).resolves.toBe(expected);
  });

  it('publish end-to-end: the post event carries the provider cell', async () => {
    const expected = encodeGeohash(12.9716, 77.5946, 5);
    setLocationProviderForTests({ getCurrentCell: async () => expected });
    const id = await publishPost('via provider', {});
    const saved = await getStore().getEvent(id);
    expect(saved).not.toBeNull();
    expect(saved!.geohash).toBe(expected);
  });

  it('explicit geohash5 still wins over the provider (tests/dev override)', async () => {
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('unavailable');
      },
    });
    const id = await publishPost('explicit cell', { geohash5: 'tdr1v' });
    const saved = await getStore().getEvent(id);
    expect(saved!.geohash).toBe('tdr1v');
  });

  it('notifies feed subscribers after publish', async () => {
    const seen: number[] = [];
    const unsub = subscribeFeed(() => seen.push(1));
    await publishPost('ping', { geohash5: 'tdr1v' });
    expect(seen).toHaveLength(1);
    unsub();
    await publishPost('pong', { geohash5: 'tdr1v' });
    expect(seen).toHaveLength(1);
  });
});

// --- feed --------------------------------------------------------------------

describe('listFeedPosts', () => {
  it('maps stored posts to card models, ranked by score desc', async () => {
    const a = await publishPost('older popular', { geohash5: 'tdr1v' });
    const b = await publishPost('newer quiet', { geohash5: 'tdr1v' });
    // inflate views on the older post so it must rank above the newer one
    for (let i = 0; i < 5; i++) {
      await emitViewReceipt(a);
      __resetViewTrackerForTests(); // allow another receipt: new viewer keypair
      __resetDeviceKeypairForTests();
    }
    const cards = await listFeedPosts({ cells: ['tdr1v'] });
    expect(cards.map((c) => c.eventId)).toEqual([a, b]);
    expect(cards[0].views).toBeGreaterThanOrEqual(1);
    expect(cards[1].worldConfirmed).toBe(false);
    expect(cards[0].authorLabel).toMatch(/^[a-z]+ [a-z]+·[0-9a-f]{4}$/);
  });

  it('pages same-second posts exactly once via the tuple cursor', async () => {
    const nowSec = Math.floor(Date.now() / 1000) - 60;
    const store = getStore();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const post = makePost({ created_at: nowSec });
      await store.saveEvent(post);
      ids.push(toHex(post.id));
    }
    const page1 = await listFeedPage({ cells: ['tdr1v'], limit: 2 });
    expect(page1.cards).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listFeedPage({
      cells: ['tdr1v'],
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.cards).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.cards, ...page2.cards].map((c) => c.eventId);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(ids.sort());
  });

  it('ranks over the full set: an older high-view post surfaces on page 1', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const store = getStore();
    const oldPopular = makePost({ created_at: nowSec - 3600 });
    const newerQuiet1 = makePost({ created_at: nowSec - 60 });
    const newerQuiet2 = makePost({ created_at: nowSec - 30 });
    await store.saveEvent(oldPopular);
    await store.saveEvent(newerQuiet1);
    await store.saveEvent(newerQuiet2);
    // Five distinct viewers receipt the older post, so it must outrank
    // both newer posts even though it is third by recency.
    for (let i = 0; i < 5; i++) {
      const receipt = makePost({
        kind: 2 as EventKind,
        tags: [['e', toHex(oldPopular.id)]],
        content: '',
        created_at: nowSec,
      });
      await store.saveReceipt(receipt);
    }
    const page1 = await listFeedPage({ cells: ['tdr1v'], limit: 2 });
    expect(page1.cards.map((c) => c.eventId)).toContain(toHex(oldPopular.id));
    expect(page1.cards[0].eventId).toBe(toHex(oldPopular.id));
    const page2 = await listFeedPage({ cells: ['tdr1v'], limit: 2, cursor: page1.nextCursor });
    const seen = [...page1.cards, ...page2.cards].map((c) => c.eventId);
    expect(new Set(seen).size).toBe(3);
    expect(page2.nextCursor).toBeNull();
  });

  it('scopes by cell and applies the before cursor', async () => {
    await publishPost('here', { geohash5: 'tdr1v' });
    await publishPost('there', { geohash5: 'abcde' });
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
    const id = await publishPost('view me', { geohash5: 'tdr1v' });
    expect(await emitViewReceipt(id)).toBe(true);
    // same device + same UTC day -> deduped by the store
    expect(await emitViewReceipt(id)).toBe(false);
    expect(await getStore().countViews(id)).toBe(1);
  });

  it('returns false for unknown posts', async () => {
    expect(await emitViewReceipt('e'.repeat(64))).toBe(false);
  });
});
