// SPDX-License-Identifier: Apache-2.0
import {
  FragmentError,
  Reassembler,
  encodeHeader,
  fragment,
  msgTagOf,
  parseHeader,
} from './fragment';
import { decodeEvent, encodeEvent } from '../codec/cbor';
import { verifyEvent } from '../sign/ed25519';
import {
  FRAG_HEADER_LEN,
  FRAG_PAYLOAD_MAX,
  FRAG_WIRE_MAX,
  REASSEMBLY_TIMEOUT_MS,
} from '../events/types';
import { makeKeypair, makePost, makeSizedEvent } from '../test-helpers';

describe('fragmentation', () => {
  test('header layout is 11 bytes: A1 | msgTag u32 | total u16 | index u16 | ttl u8 | flags u8', () => {
    const header = encodeHeader({ msgTag: 0xdeadbeef, total: 3, index: 1, ttl: 7, flags: 0 });
    expect(header).toHaveLength(FRAG_HEADER_LEN);
    expect(header[0]).toBe(0xa1);
    // msgTag big-endian at offset 1
    expect(header[1]).toBe(0xde);
    expect(header[2]).toBe(0xad);
    expect(header[3]).toBe(0xbe);
    expect(header[4]).toBe(0xef);
    // total=3 at offset 5, index=1 at offset 7
    expect(header[5]).toBe(0);
    expect(header[6]).toBe(3);
    expect(header[7]).toBe(0);
    expect(header[8]).toBe(1);
    // ttl=7 at offset 9, flags=0 at offset 10
    expect(header[9]).toBe(7);
    expect(header[10]).toBe(0);
    expect(parseHeader(header)).toEqual({
      msgTag: 0xdeadbeef,
      total: 3,
      index: 1,
      ttl: 7,
      flags: 0,
    });
  });

  test('msgTag is the first 4 bytes of the event id', () => {
    const bytes = encodeEvent(makePost('tag me'));
    const tag = msgTagOf(bytes);
    const event = decodeEvent(bytes);
    const expected =
      ((event.id[0] << 24) | (event.id[1] << 16) | (event.id[2] << 8) | event.id[3]) >>> 0;
    expect(tag).toBe(expected);
  });

  test('small event → single frame; split/reassemble round-trips', () => {
    const { crypto } = makeKeypair();
    const bytes = encodeEvent(makePost('tiny'));
    const frames = fragment(bytes, 7);
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBeLessThanOrEqual(FRAG_WIRE_MAX);

    const rx = new Reassembler();
    const out = rx.push(frames[0]);
    expect(out).not.toBeNull();
    expect(verifyEvent(crypto, decodeEvent(out as Uint8Array))).toBe(true);
  });

  test('multi-fragment: out-of-order and duplicate frames reassemble', () => {
    const { crypto } = makeKeypair();
    const bytes = makeSizedEvent(1000); // forces 3 fragments at 458B payload
    const frames = fragment(bytes, 5);
    expect(frames.length).toBe(3);
    for (const f of frames) {
      expect(f.length).toBeLessThanOrEqual(FRAG_WIRE_MAX);
      expect(parseHeader(f).ttl).toBe(5);
    }

    const rx = new Reassembler();
    // Out of order: 2, 0, 1 - nothing complete until the last push.
    expect(rx.push(frames[2])).toBeNull();
    expect(rx.push(frames[0])).toBeNull();
    // Duplicate of frame 0 must not corrupt or double-count.
    expect(rx.push(frames[0])).toBeNull();
    const out = rx.push(frames[1]);
    expect(out).not.toBeNull();
    expect(Buffer.from(out as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    expect(verifyEvent(crypto, decodeEvent(out as Uint8Array))).toBe(true);
  });

  test('1-byte payload reassembles', () => {
    const frame = new Uint8Array(FRAG_HEADER_LEN + 1);
    frame.set(encodeHeader({ msgTag: 0x01020304, total: 1, index: 0, ttl: 7, flags: 0 }));
    frame[FRAG_HEADER_LEN] = 0x42;
    const rx = new Reassembler();
    const out = rx.push(frame);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect((out as Uint8Array)[0]).toBe(0x42);
  });

  test('exact 458-byte payload boundary → 1 fragment; 459 → 2 fragments', () => {
    const at458 = makeSizedEvent(FRAG_PAYLOAD_MAX);
    const at459 = makeSizedEvent(FRAG_PAYLOAD_MAX + 1);
    const f458 = fragment(at458, 7);
    const f459 = fragment(at459, 7);
    expect(f458).toHaveLength(1);
    expect(f458[0].length).toBe(FRAG_WIRE_MAX);
    expect(f459).toHaveLength(2);
    expect(f459[0].length).toBe(FRAG_WIRE_MAX);
    expect(f459[1].length).toBe(FRAG_HEADER_LEN + 1);

    const rx = new Reassembler();
    const out = rx.push(f459[1], 1000) ?? rx.push(f459[0], 1000);
    expect(out).not.toBeNull();
    expect(Buffer.from(out as Uint8Array).equals(Buffer.from(at459))).toBe(true);
  });

  test('purge drops incomplete reassembly after 30000ms', () => {
    const bytes = makeSizedEvent(1000);
    const frames = fragment(bytes, 7);
    const rx = new Reassembler();
    expect(rx.push(frames[0], 0)).toBeNull();
    expect(rx.pendingCount).toBe(1);
    // Before the timeout: still pending.
    expect(rx.purge(REASSEMBLY_TIMEOUT_MS - 1)).toBe(0);
    expect(rx.pendingCount).toBe(1);
    // After the timeout: dropped.
    expect(rx.purge(REASSEMBLY_TIMEOUT_MS + 1)).toBe(1);
    expect(rx.pendingCount).toBe(0);
  });

  test('malformed frames throw FragmentError', () => {
    const rx = new Reassembler();
    expect(() => rx.push(new Uint8Array(5))).toThrow(FragmentError); // short
    const badMagic = encodeHeader({ msgTag: 1, total: 1, index: 0, ttl: 7, flags: 0 });
    badMagic[0] = 0x00;
    expect(() => rx.push(badMagic)).toThrow(FragmentError);
    const badIndex = encodeHeader({ msgTag: 1, total: 2, index: 2, ttl: 7, flags: 0 });
    expect(() => rx.push(badIndex)).toThrow(FragmentError);
    expect(() => fragment(encodeEvent(makePost('x')), 7, 10)).toThrow(FragmentError); // mtu too small
  });
});

describe('fragment bounds (audit area6 F12)', () => {
  test('parseHeader rejects total over the cap and nonzero flags', () => {
    expect(() => parseHeader(encodeHeader({ msgTag: 1, total: 257, index: 0, ttl: 7, flags: 0 }))).toThrow(
      FragmentError,
    );
    expect(() => parseHeader(encodeHeader({ msgTag: 1, total: 1, index: 0, ttl: 7, flags: 1 }))).toThrow(
      FragmentError,
    );
    // 38 fragments (the MTU-aware broadcast case) stays accepted.
    expect(parseHeader(encodeHeader({ msgTag: 1, total: 38, index: 0, ttl: 7, flags: 0 })).total).toBe(38);
    expect(parseHeader(encodeHeader({ msgTag: 1, total: 256, index: 0, ttl: 7, flags: 0 })).total).toBe(256);
  });

  test('Reassembler caps pending tags at 64, dropping the oldest', () => {
    const rx = new Reassembler();
    for (let tag = 0; tag < 65; tag++) {
      const frame = new Uint8Array(FRAG_HEADER_LEN + 1);
      frame.set(encodeHeader({ msgTag: tag, total: 2, index: 0, ttl: 7, flags: 0 }));
      expect(rx.push(frame, 1000)).toBeNull();
    }
    expect(rx.pendingCount).toBe(64);
    // Tag 0 was evicted: its second fragment starts a fresh incomplete set.
    const second = new Uint8Array(FRAG_HEADER_LEN + 1);
    second.set(encodeHeader({ msgTag: 0, total: 2, index: 1, ttl: 7, flags: 0 }));
    expect(rx.push(second, 1000)).toBeNull();
    expect(rx.pendingCount).toBe(64);
  });
});
