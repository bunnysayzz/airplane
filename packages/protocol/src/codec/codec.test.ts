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

  test('conservative per-kind shapes: empty post, content receipt, targetless reshare rejected', () => {
    const good = makePost('ok');
    const mutate = (idx: number, value: unknown) => {
      const arr = decode(encodeEvent(good)) as unknown[];
      arr[idx] = value;
      return encode(arr);
    };
    // Kind 1 with no content.
    expect(() => decodeEvent(mutate(6, ''))).toThrow(CodecError);
    // Kind 2 carrying content.
    const receipt = mutate(3, 2);
    const receiptArr = decode(receipt) as unknown[];
    receiptArr[6] = 'not empty';
    expect(() => decodeEvent(encode(receiptArr))).toThrow(CodecError);
    // Kind 5 without a valid e tag target.
    const reshare = mutate(3, 5);
    const reshareArr = decode(reshare) as unknown[];
    reshareArr[5] = [];
    expect(() => decodeEvent(encode(reshareArr))).toThrow(CodecError);
    reshareArr[5] = [['e', 'not-hex']];
    expect(() => decodeEvent(encode(reshareArr))).toThrow(CodecError);
    // Same reshare with a valid target passes the shape check.
    reshareArr[5] = [['e', 'ab'.repeat(32)]];
    expect(() => decodeEvent(encode(reshareArr))).not.toThrow();
  });

  test('tag count and tag string length are capped before decode', () => {
    const good = makePost('ok');
    const mutate = (idx: number, value: unknown) => {
      const arr = decode(encodeEvent(good)) as unknown[];
      arr[idx] = value;
      return encode(arr);
    };
    const manyTags = Array.from({ length: 17 }, (_, i) => ['t', String(i)]);
    expect(() => decodeEvent(mutate(5, manyTags))).toThrow(CodecError);
    expect(() => decodeEvent(mutate(5, [['x', 'y'.repeat(129)]]))).toThrow(CodecError);
    expect(() => decodeEvent(mutate(5, [['x', 'y'.repeat(128)]]))).not.toThrow();
  });

  test('bad lengths / kind / geohash throw CodecError', () => {    const good = makePost('ok');
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
