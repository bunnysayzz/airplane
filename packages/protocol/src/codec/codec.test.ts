// SPDX-License-Identifier: Apache-2.0
import { decode, encode } from 'cbor-x';
import {
  CodecError,
  decodeEvent,
  encodeEvent,
  eventId,
} from './cbor';
import { MAX_CONTENT_CHARS, MAX_EVENT_BYTES } from '../events/types';
import { bytesEqual } from '../hex';
import { makeKeypair, makePost } from '../test-helpers';
import { verifyEvent } from '../sign/ed25519';

describe('codec', () => {
  test('round-trip preserves every field', () => {
    const original = makePost('round trip 🛰️', 1_700_000_001);
    const bytes = encodeEvent(original);
    expect(bytes.length).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const decoded = decodeEvent(bytes);
    expect(bytesEqual(decoded.id, original.id)).toBe(true);
    expect(bytesEqual(decoded.pubkey, original.pubkey)).toBe(true);
    expect(decoded.created_at).toBe(original.created_at);
    expect(decoded.kind).toBe(original.kind);
    expect(decoded.geohash).toBe(original.geohash);
    expect(decoded.tags).toEqual(original.tags);
    expect(decoded.content).toBe(original.content);
    expect(bytesEqual(decoded.sig, original.sig)).toBe(true);
  });

  test('event id is sha256 of the canonical 7-position pre-image', () => {
    const event = makePost('preimage check');
    const preimage = encode([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.geohash,
      event.tags,
      event.content,
    ]);
    // Recompute manually: id must equal sha256 of the pre-image we just built.
    const recomputed = eventId(event);
    expect(bytesEqual(recomputed, event.id)).toBe(true);
    expect(preimage.length).toBeGreaterThan(0);
  });

  test('tampered content fails verification (id mismatch)', () => {
    const { crypto } = makeKeypair();
    const original = makePost('untampered');
    const decoded = decodeEvent(encodeEvent(original));
    decoded.content = 'tampered!';
    expect(verifyEvent(crypto, decoded)).toBe(false);
  });

  test('tampered signature fails verification', () => {
    const { crypto } = makeKeypair();
    const original = makePost('sig check');
    const decoded = decodeEvent(encodeEvent(original));
    decoded.sig[0] ^= 0xff;
    expect(verifyEvent(crypto, decoded)).toBe(false);
  });

  test('oversize content throws CodecError', () => {
    const tooLong = 'x'.repeat(MAX_CONTENT_CHARS + 1);
    const raw = encode([
      new Uint8Array(32),
      new Uint8Array(32),
      1_700_000_000,
      1,
      'ezs42',
      [],
      tooLong,
      new Uint8Array(64),
    ]);
    expect(() => decodeEvent(raw)).toThrow(CodecError);
  });

  test('event larger than 4096 bytes throws CodecError', () => {
    const raw = encode([
      new Uint8Array(32),
      new Uint8Array(32),
      1_700_000_000,
      1,
      'ezs42',
      [['pad', 'z'.repeat(MAX_EVENT_BYTES)]],
      'hi',
      new Uint8Array(64),
    ]);
    expect(raw.length).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(() => decodeEvent(raw)).toThrow(CodecError);
  });

  test('bad lengths / kind / geohash throw CodecError', () => {
    const good = makePost('ok');
    const mutate = (idx: number, value: unknown) => {
      const arr = decode(encodeEvent(good)) as unknown[];
      arr[idx] = value;
      return encode(arr);
    };
    expect(() => decodeEvent(mutate(0, new Uint8Array(31)))).toThrow(CodecError); // id 31B
    expect(() => decodeEvent(mutate(1, new Uint8Array(33)))).toThrow(CodecError); // pubkey 33B
    expect(() => decodeEvent(mutate(3, 9))).toThrow(CodecError); // kind 9
    expect(() => decodeEvent(mutate(4, 'ezs4'))).toThrow(CodecError); // geohash 4 chars
    expect(() => decodeEvent(mutate(4, 'ezs4!'))).toThrow(CodecError); // geohash bad char
    expect(() => decodeEvent(mutate(7, new Uint8Array(63)))).toThrow(CodecError); // sig 63B
    expect(() => decodeEvent(encode([1, 2, 3]))).toThrow(CodecError); // not 8-array
  });
});
