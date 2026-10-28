// SPDX-License-Identifier: Apache-2.0
import { NobleCrypto, verifyEvent } from '../sign/ed25519';
import { EVENT_KIND_POST, EVENT_KIND_RECEIPT, EVENT_KIND_TOMBSTONE } from '../events/types';
import { MAX_CONTENT_CHARS } from '../events/types';
import {
  createPost,
  createViewReceipt,
  createTombstone,
  normalizeContent,
  PayloadError,
} from './posts';

const crypto = new NobleCrypto();
const { publicKey, secretKey } = crypto.generateKeypair();
const GEOHASH = 'ezs42';

function postId(): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = i;
  return b;
}

describe('normalizeContent', () => {
  test('accepts normal content', () => {
    expect(normalizeContent('hello world')).toBe('hello world');
  });

  test('NFC-normalizes combining characters', () => {
    // 'e' + combining acute accent -> 'é' (single code point)
    const decomposed = 'é';
    expect(normalizeContent(decomposed)).toBe('é');
  });

  test('rejects empty content', () => {
    expect(() => normalizeContent('')).toThrow(PayloadError);
    expect(() => normalizeContent('   ')).toThrow(PayloadError); // whitespace-only is blank (D11)
  });

  test('rejects content over the char limit', () => {
    const tooLong = 'x'.repeat(MAX_CONTENT_CHARS + 1);
    expect(() => normalizeContent(tooLong)).toThrow(/too long/);
  });

  test('accepts exactly the char limit', () => {
    expect(normalizeContent('x'.repeat(MAX_CONTENT_CHARS))).toHaveLength(MAX_CONTENT_CHARS);
  });

  test('counts emoji as single chars, not UTF-16 units', () => {
    // 280 emoji should pass even though UTF-16 length is 560
    expect(() => normalizeContent('🌐'.repeat(MAX_CONTENT_CHARS))).not.toThrow();
  });
});

describe('createPost', () => {
  test('creates a valid signed kind-1 event', () => {
    const event = createPost({
      crypto,
      secretKey,
      pubkey: publicKey,
      geohash5: GEOHASH,
      content: 'hello mesh',
    });
    expect(event.kind).toBe(EVENT_KIND_POST);
    expect(event.content).toBe('hello mesh');
    expect(event.tags).toEqual([]);
    expect(verifyEvent(crypto, event)).toBe(true);
  });

  test('rejects bad geohash length', () => {
    expect(() =>
      createPost({ crypto, secretKey, pubkey: publicKey, geohash5: 'ezs4', content: 'x' }),
    ).toThrow(PayloadError);
    expect(() =>
      createPost({ crypto, secretKey, pubkey: publicKey, geohash5: 'ezs421', content: 'x' }),
    ).toThrow(PayloadError);
  });

  test('rejects empty or oversized content', () => {
    expect(() =>
      createPost({ crypto, secretKey, pubkey: publicKey, geohash5: GEOHASH, content: '' }),
    ).toThrow(PayloadError);
    expect(() =>
      createPost({
        crypto,
        secretKey,
        pubkey: publicKey,
        geohash5: GEOHASH,
        content: 'x'.repeat(MAX_CONTENT_CHARS + 1),
      }),
    ).toThrow(PayloadError);
  });

  test('honors explicit createdAt', () => {
    const event = createPost({
      crypto,
      secretKey,
      pubkey: publicKey,
      geohash5: GEOHASH,
      content: 'timed',
      createdAt: 1_700_000_000,
    });
    expect(event.created_at).toBe(1_700_000_000);
  });
});

describe('createViewReceipt', () => {
  test('creates a valid signed kind-2 event with the post id tag', () => {
    const id = postId();
    const event = createViewReceipt({
      crypto,
      secretKey,
      pubkey: publicKey,
      geohash5: GEOHASH,
      postId: id,
    });
    expect(event.kind).toBe(EVENT_KIND_RECEIPT);
    expect(event.content).toBe('');
    expect(event.tags).toEqual([['e', '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f']]);
    expect(verifyEvent(crypto, event)).toBe(true);
  });

  test('rejects non-32-byte post ids', () => {
    const bad = new Uint8Array(16);
    expect(() =>
      createViewReceipt({ crypto, secretKey, pubkey: publicKey, geohash5: GEOHASH, postId: bad }),
    ).toThrow(PayloadError);
  });

  test('rejects bad geohash', () => {
    expect(() =>
      createViewReceipt({
        crypto,
        secretKey,
        pubkey: publicKey,
        geohash5: 'bad',
        postId: postId(),
      }),
    ).toThrow(PayloadError);
  });
});

describe('createTombstone', () => {
  test('creates a valid signed kind-3 event with the post id tag', () => {
    const event = createTombstone({
      crypto,
      secretKey,
      pubkey: publicKey,
      geohash5: GEOHASH,
      postId: postId(),
    });
    expect(event.kind).toBe(EVENT_KIND_TOMBSTONE);
    expect(event.content).toBe('');
    expect(event.tags[0][0]).toBe('e');
    expect(verifyEvent(crypto, event)).toBe(true);
  });

  test('rejects non-32-byte post ids', () => {
    expect(() =>
      createTombstone({
        crypto,
        secretKey,
        pubkey: publicKey,
        geohash5: GEOHASH,
        postId: new Uint8Array(31),
      }),
    ).toThrow(PayloadError);
  });
});
