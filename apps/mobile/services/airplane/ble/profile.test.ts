// SPDX-License-Identifier: Apache-2.0
// Unit tests for the BLE GATT profile helpers: tags, datagram framing,
// reassembly, chunking, base64. Pure logic - no radio, no native modules.

import {
  ADVERTISE_COMPANY_ID,
  DATAGRAM_FRAME,
  DATAGRAM_HELLO,
  PEER_TAG_LEN,
  DatagramReassembler,
  chunkBytes,
  compareTags,
  encodeDatagram,
  encodeHello,
  fromBase64,
  parseHello,
  peerTagOf,
  toBase64,
} from './profile';

const pubkey = new Uint8Array(32).map((_, i) => i);

describe('peerTagOf', () => {
  test('takes the first 8 bytes of the pubkey', () => {
    const tag = peerTagOf(pubkey);
    expect(tag).toHaveLength(PEER_TAG_LEN);
    expect([...tag]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test('rejects non-32-byte input', () => {
    expect(() => peerTagOf(new Uint8Array(8))).toThrow();
  });
});

describe('compareTags', () => {
  test('lexicographic ordering', () => {
    const a = new Uint8Array([0, 0, 1]);
    const b = new Uint8Array([0, 0, 2]);
    expect(compareTags(a, b)).toBe(-1);
    expect(compareTags(b, a)).toBe(1);
    expect(compareTags(a, a.slice())).toBe(0);
  });
});

describe('datagram framing', () => {
  test('encode/decode roundtrip through the reassembler', () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const dg = encodeDatagram(DATAGRAM_FRAME, payload);
    // length prefix = 1 (kind) + 4 (payload)
    expect(dg[0]).toBe(0);
    expect(dg[1]).toBe(5);
    expect(dg[2]).toBe(DATAGRAM_FRAME);

    const r = new DatagramReassembler();
    // Split mid-datagram: nothing complete until the tail arrives.
    expect(r.push(dg.slice(0, 3))).toEqual([]);
    const done = r.push(dg.slice(3));
    expect(done).toHaveLength(1);
    expect(done[0][0]).toBe(DATAGRAM_FRAME);
    expect([...done[0].slice(1)]).toEqual([...payload]);
  });

  test('multiple datagrams in one chunk', () => {
    const a = encodeDatagram(DATAGRAM_FRAME, new Uint8Array([9]));
    const b = encodeDatagram(DATAGRAM_HELLO, new Uint8Array([8]));
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    const out = new DatagramReassembler().push(merged);
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(DATAGRAM_FRAME);
    expect(out[1][0]).toBe(DATAGRAM_HELLO);
  });

  test('oversized buffer is dropped (DoS bound)', () => {
    const r = new DatagramReassembler();
    // Claim a huge datagram, then feed just under the cap: the buffer
    // grows past MAX_DATAGRAM_BUFFER and is discarded.
    const huge = new Uint8Array([0xff, 0xff, DATAGRAM_FRAME]);
    expect(r.push(huge)).toEqual([]);
    expect(r.push(new Uint8Array(66 * 1024))).toEqual([]);
    expect(r.buffered).toBe(0);
    // Recovers: a fresh datagram still parses.
    const dg = encodeDatagram(DATAGRAM_FRAME, new Uint8Array([1]));
    expect(new DatagramReassembler().push(dg)).toHaveLength(1);
  });

  test('empty chunk is ignored', () => {
    expect(new DatagramReassembler().push(new Uint8Array(0))).toEqual([]);
  });
});

describe('hello', () => {
  test('roundtrip', () => {
    const dg = encodeHello(pubkey, 512);
    const r = new DatagramReassembler();
    const [parsed] = r.push(dg);
    expect(parsed[0]).toBe(DATAGRAM_HELLO);
    const hello = parseHello(parsed.slice(1));
    expect(hello).not.toBeNull();
    expect([...hello!.publicKey]).toEqual([...pubkey]);
    expect(hello!.centralMtu).toBe(512);
  });

  test('malformed payloads return null', () => {
    expect(parseHello(new Uint8Array(33))).toBeNull();
    expect(parseHello(new Uint8Array(35))).toBeNull();
    // bad mtu
    const bad = new Uint8Array(34);
    bad[32] = 0x04;
    bad[33] = 0x00; // 1024 > 517
    expect(parseHello(bad)).toBeNull();
  });

  test('encodeHello validates inputs', () => {
    expect(() => encodeHello(new Uint8Array(8), 512)).toThrow();
    expect(() => encodeHello(pubkey, 10)).toThrow();
  });
});

describe('chunkBytes', () => {
  test('splits evenly and unevenly', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const chunks = chunkBytes(bytes, 2);
    expect(chunks.map((c) => [...c])).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('rejects bad sizes', () => {
    expect(() => chunkBytes(new Uint8Array([1]), 0)).toThrow();
  });
});

describe('base64', () => {
  test('roundtrip incl. padding cases', () => {
    for (const len of [0, 1, 2, 3, 8, 100]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 7) & 0xff);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  test('invalid input returns null', () => {
    expect(fromBase64('!!!')).toBeNull();
    expect(fromBase64('abc')).toBeNull(); // bad length
  });

  test('advertise company id is the testing-reserved value', () => {
    expect(ADVERTISE_COMPANY_ID).toBe(0xffff);
  });
});
