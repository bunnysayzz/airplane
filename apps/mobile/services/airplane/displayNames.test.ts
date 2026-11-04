// SPDX-License-Identifier: Apache-2.0
// Display names (Track 5): normalization, signed tag extraction, the
// peer registry and its collision rule, username matching over known
// peers only, deterministic avatar gradients, own-name KV storage, and
// the signed tag a post carries. Wordlists are never touched here: the
// memorable-name assertions pin the mapping that must stay stable.

import { MemoryKv } from '@airplane/storage';
import { fromHex, toHex, type SignedEvent } from '@airplane/protocol';
import {
  __resetDisplayNamesForTests,
  avatarGradientFor,
  displayNameFromTags,
  formatPeerName,
  getOwnDisplayName,
  matchKnownPeers,
  normalizeDisplayName,
  recordPeerDisplayName,
  resolvePeerNames,
  setOwnDisplayName,
} from './displayNames';
import { authorLabelFor, memorableNameFor, nameWithoutSuffix } from './names';
import { __resetKvForTests, __setKvForTests } from './kv';
import { __resetStoreForTests, getStore } from './store';
import { __resetDeviceKeypairForTests } from './identity';
import { __resetFeedListenersForTests } from './feed';
import { __resetLocationProviderForTests } from './location';
import { publishPost, tagsForPublish } from './composer';
import { toPostCardModel } from './feed';

function pubkeyHexOf(bytes: number[]): string {
  return toHex(new Uint8Array(bytes));
}

function memorableForHex(hex: string): string {
  return memorableNameFor(fromHex(hex)!);
}

/**
 * A post-shaped event for mapping tests. The signature is not checked by
 * toPostCardModel, so the id and sig here are placeholders; only pubkey,
 * tags, and content drive the mapping assertions.
 */
function postWithTags(pubkey: Uint8Array, tags: string[][]): SignedEvent {
  return {
    id: new Uint8Array(32).fill(7),
    pubkey,
    created_at: 1700000000,
    kind: 1,
    geohash: 'tdr1v',
    tags,
    content: 'mesh post',
    sig: new Uint8Array(64),
  };
}

beforeEach(() => {
  __resetDisplayNamesForTests();
  __resetKvForTests();
  __resetStoreForTests();
  __resetDeviceKeypairForTests();
  __resetFeedListenersForTests();
  __resetLocationProviderForTests();
});

afterEach(() => {
  __resetDisplayNamesForTests();
  __resetKvForTests();
  __resetDeviceKeypairForTests();
  __resetFeedListenersForTests();
  __resetLocationProviderForTests();
});

describe('normalizeDisplayName', () => {
  test('trims and collapses whitespace, keeps the name', () => {
    expect(normalizeDisplayName('  tuba   khan  ')).toBe('tuba khan');
  });

  test('empty, overlong, and control-character names are invalid', () => {
    expect(normalizeDisplayName('')).toBeNull();
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(normalizeDisplayName('a'.repeat(33))).toBeNull();
    expect(normalizeDisplayName('a'.repeat(32))).toBe('a'.repeat(32));
    expect(normalizeDisplayName('tu\u0007ba')).toBeNull();
    expect(normalizeDisplayName(null)).toBeNull();
    expect(normalizeDisplayName(undefined)).toBeNull();
  });
});

describe('displayNameFromTags', () => {
  test('first valid display_name tag wins, other tags ignored', () => {
    expect(
      displayNameFromTags([
        ['e', 'ab'.repeat(32)],
        ['display_name', 'tuba'],
      ]),
    ).toBe('tuba');
    expect(displayNameFromTags([['e', 'ab'.repeat(32)]])).toBeNull();
    expect(displayNameFromTags([['display_name', '   ']])).toBeNull();
    expect(displayNameFromTags(null)).toBeNull();
  });
});

describe('memorable mapping stays stable', () => {
  test('memorable name plus suffix equals the full label, wordlists unchanged', () => {
    const pubkey = fromHex(pubkeyHexOf([0x11, 0x22, 5, 7, ...new Array(28).fill(0)]))!;
    expect(`${memorableNameFor(pubkey)}·${toHex(pubkey).slice(0, 4)}`).toBe(
      authorLabelFor(pubkey),
    );
    expect(nameWithoutSuffix(authorLabelFor(pubkey))).toBe(
      memorableNameFor(pubkey),
    );
  });
});

describe('peer registry and collision rule', () => {
  test('a recorded name is the base name, and a post without a tag never erases it', () => {
    const hex = 'ab'.repeat(32);
    recordPeerDisplayName(hex, 'tuba');
    expect(formatPeerName(hex)).toBe('tuba');
    recordPeerDisplayName(hex, null);
    expect(formatPeerName(hex)).toBe('tuba');
    recordPeerDisplayName(hex, '   ');
    expect(formatPeerName(hex)).toBe('tuba');
  });

  test('same base name on two peers shows the suffix on both, unique names stay clean', () => {
    const first = pubkeyHexOf([0x11, 0x22, 5, 7, ...new Array(28).fill(0)]);
    const second = pubkeyHexOf([0x33, 0x44, 5, 7, ...new Array(28).fill(0)]);
    recordPeerDisplayName(first, 'tuba');
    recordPeerDisplayName(second, 'tuba');
    expect(formatPeerName(first)).toBe('tuba·1122');
    expect(formatPeerName(second)).toBe('tuba·3344');
    const names = resolvePeerNames([first, second]);
    expect(names.get(first)).toBe('tuba·1122');
    expect(names.get(second)).toBe('tuba·3344');
  });

  test('memorable-name collision also disambiguates, with different suffixes', () => {
    const first = pubkeyHexOf([0x11, 0x22, 5, 7, ...new Array(28).fill(0)]);
    const second = pubkeyHexOf([0x33, 0x44, 5, 7, ...new Array(28).fill(0)]);
    expect(formatPeerName(first, [second])).toBe(`${memorableForHex(first)}·1122`);
    expect(formatPeerName(second, [first])).toBe(`${memorableForHex(second)}·3344`);
  });
});

describe('matchKnownPeers', () => {
  test('exact, prefix, and substring matches rank in order, and unseen peers never match', () => {
    const tuba = pubkeyHexOf([0x11, 0x22, 5, 7, ...new Array(28).fill(0)]);
    const other = pubkeyHexOf([0x55, 0x66, 9, 11, ...new Array(28).fill(0)]);
    recordPeerDisplayName(tuba, 'tuba khan');
    const exact = matchKnownPeers('tuba khan', [tuba, other]);
    expect(exact.map((m) => m.pubkeyHex)).toEqual([tuba]);
    const prefix = matchKnownPeers('tuba', [tuba, other]);
    expect(prefix[0].pubkeyHex).toBe(tuba);
    expect(matchKnownPeers('tuba', [other])).toEqual([]);
    expect(matchKnownPeers('', [tuba])).toEqual([]);
    expect(matchKnownPeers('TUBA', [tuba]).map((m) => m.name)).toEqual(['tuba khan']);
  });

  test('a peer is findable by memorable name even after setting a display name', () => {
    const hex = pubkeyHexOf([0x11, 0x22, 5, 7, ...new Array(28).fill(0)]);
    recordPeerDisplayName(hex, 'tuba');
    expect(matchKnownPeers(memorableForHex(hex), [hex]).map((m) => m.pubkeyHex)).toEqual([hex]);
  });
});

describe('avatarGradientFor', () => {
  test('deterministic per pubkey, distinct across keys, null for bad hex', () => {
    const first = 'ab'.repeat(32);
    const second = 'cd'.repeat(32);
    expect(avatarGradientFor(first)).toEqual(avatarGradientFor(first));
    expect(avatarGradientFor(first)).not.toEqual(avatarGradientFor(second));
    expect(avatarGradientFor('garbage')).toBeNull();
    const gradient = avatarGradientFor(first)!;
    expect(gradient).toHaveLength(2);
    expect(gradient[0]).toMatch(/^hsl\(\d+, 72%, 52%\)$/);
  });
});

describe('own display name in KV', () => {
  test('set, get, and clear round trip through the fake KV', async () => {
    __setKvForTests(new MemoryKv());
    await expect(getOwnDisplayName()).resolves.toBeNull();
    await expect(setOwnDisplayName('  tuba  ')).resolves.toBe('tuba');
    await expect(getOwnDisplayName()).resolves.toBe('tuba');
    await expect(setOwnDisplayName('')).resolves.toBeNull();
    await expect(getOwnDisplayName()).resolves.toBeNull();
    await expect(setOwnDisplayName('a'.repeat(33))).rejects.toThrow('invalid display name');
  });
});

describe('signed display name tag on posts', () => {
  test('tagsForPublish carries a normalized tag, or nothing', () => {
    expect(tagsForPublish({ displayName: '  tuba  ' })).toEqual([['display_name', 'tuba']]);
    expect(tagsForPublish({})).toEqual([]);
    expect(tagsForPublish({ displayName: null })).toEqual([]);
    expect(tagsForPublish({ displayName: 'a'.repeat(33) })).toEqual([]);
  });

  test('publishPost with an explicit name stores the tag on the signed event', async () => {
    const id = await publishPost('hello', { geohash5: 'tdr1v', displayName: 'tuba' });
    const event = await getStore().getEvent(id);
    expect(event).not.toBeNull();
    // Plus the signed seq tag: the counter starts at 1 for a fresh KV.
    expect(event!.tags).toEqual([['display_name', 'tuba'], ['seq', '1']]);
  });

  test('publishPost picks up the saved own name, and posts without one carry no name tag', async () => {
    __setKvForTests(new MemoryKv());
    await setOwnDisplayName('tuba');
    const withName = await publishPost('hello', { geohash5: 'tdr1v' });
    expect((await getStore().getEvent(withName))!.tags).toEqual([['display_name', 'tuba'], ['seq', '1']]);
    await setOwnDisplayName('');
    const withoutName = await publishPost('hello again', { geohash5: 'tdr1v' });
    expect((await getStore().getEvent(withoutName))!.tags).toEqual([['seq', '2']]);
  });

  test('toPostCardModel shows the signed name clean, and the full label unchanged', () => {
    const pubkey = new Uint8Array(32).fill(3);
    const event = postWithTags(pubkey, [['display_name', 'tuba']]);
    const card = toPostCardModel({ event, views: 0, score: 0, ageHours: 0 });
    expect(card.authorName).toBe('tuba');
    expect(card.authorLabel).toBe(authorLabelFor(pubkey));
    const plain = postWithTags(pubkey, []);
    expect(toPostCardModel({ event: plain, views: 0, score: 0, ageHours: 0 }).authorName).toBe(
      memorableNameFor(pubkey),
    );
  });
});
