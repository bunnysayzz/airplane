// SPDX-License-Identifier: Apache-2.0
// BLE fragmentation: split an encoded event into ≤469-byte wire frames and
// reassemble them. 11-byte header layout (big-endian):
//   offset 0:     magic   u8  = 0xA1
//   offset 1..4:  msgTag  u32 = first 4 bytes of the event id (reassembly key)
//   offset 5..6:  total   u16 = fragment count
//   offset 7..8:  index   u16 = this fragment's index (0-based)
//   offset 9:     ttl     u8  = remaining flood TTL for this message
//   offset 10:    flags   u8  = reserved, must be 0
// Payload per fragment: mtu - 11 bytes (458 at the default mtu of 469).
// See docs/spec/wire-format.md - the spec is the source of truth.

import { decodeEvent } from '../codec/cbor';import {
  FRAG_HEADER_LEN,
  FRAG_MAGIC,
  FRAG_WIRE_MAX,
  REASSEMBLY_TIMEOUT_MS,
} from '../events/types';

/** Thrown on malformed frames or impossible fragmentation parameters. */
export class FragmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentError';
  }
}

export interface FragmentHeader {
  msgTag: number;
  total: number;
  index: number;
  ttl: number;
  flags: number;
}

function writeHeader(out: Uint8Array, header: FragmentHeader): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, FRAG_MAGIC);
  view.setUint32(1, header.msgTag);
  view.setUint16(5, header.total);
  view.setUint16(7, header.index);
  view.setUint8(9, header.ttl);
  view.setUint8(10, header.flags);
}

/** Encode a fragment header to its 11-byte wire form (handy for tests). */
export function encodeHeader(header: FragmentHeader): Uint8Array {
  const out = new Uint8Array(FRAG_HEADER_LEN);
  writeHeader(out, header);
  return out;
}

/** Parse and validate the 11-byte header of a wire frame. */
export function parseHeader(frame: Uint8Array): FragmentHeader {
  if (frame.length < FRAG_HEADER_LEN) {
    throw new FragmentError(`frame too short for header: ${frame.length} bytes`);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint8(0) !== FRAG_MAGIC) {
    throw new FragmentError(`bad magic: 0x${view.getUint8(0).toString(16)}`);
  }
  const total = view.getUint16(5);
  const index = view.getUint16(7);
  if (total === 0) throw new FragmentError('total fragment count is 0');
  if (index >= total) throw new FragmentError(`index ${index} >= total ${total}`);
  return {
    msgTag: view.getUint32(1),
    total,
    index,
    ttl: view.getUint8(9),
    flags: view.getUint8(10),
  };
}

/** First 4 bytes of the event id, big-endian u32, used as the reassembly key. */
export function msgTagOf(eventBytes: Uint8Array): number {
  const { id } = decodeEvent(eventBytes);
  return (
    ((id[0] << 24) | (id[1] << 16) | (id[2] << 8) | id[3]) >>> 0
  );
}

/**
 * Split encoded event bytes into wire frames of at most `mtu` bytes.
 * The caller passes the flood TTL to stamp into every fragment header.
 */
export function fragment(eventBytes: Uint8Array, ttl: number, mtu: number = FRAG_WIRE_MAX): Uint8Array[] {
  if (mtu < FRAG_HEADER_LEN + 1) {
    throw new FragmentError(`mtu ${mtu} too small for ${FRAG_HEADER_LEN}-byte header`);
  }
  if (ttl < 0 || ttl > 255 || !Number.isInteger(ttl)) {
    throw new FragmentError(`ttl must be a u8, got ${ttl}`);
  }
  const msgTag = msgTagOf(eventBytes);
  const payloadMax = mtu - FRAG_HEADER_LEN;
  const total = Math.max(1, Math.ceil(eventBytes.length / payloadMax));
  if (total > 0xffff) throw new FragmentError('event needs more than 65535 fragments');
  const frames: Uint8Array[] = [];
  for (let index = 0; index < total; index++) {
    const start = index * payloadMax;
    const payload = eventBytes.subarray(start, Math.min(start + payloadMax, eventBytes.length));
    const frame = new Uint8Array(FRAG_HEADER_LEN + payload.length);
    writeHeader(frame, { msgTag, total, index, ttl, flags: 0 });
    frame.set(payload, FRAG_HEADER_LEN);
    frames.push(frame);
  }
  return frames;
}

interface Reassembly {
  total: number;
  frames: Map<number, Uint8Array>;
  firstSeenMs: number;
}

/**
 * Reassemble frames into complete event bytes. Handles out-of-order and
 * duplicate frames. Returns the full bytes once all fragments arrived,
 * otherwise null. Incomplete buffers are dropped by purge(nowMs) after
 * REASSEMBLY_TIMEOUT_MS.
 */
export class Reassembler {
  private readonly pending = new Map<number, Reassembly>();

  push(frame: Uint8Array, nowMs: number = Date.now()): Uint8Array | null {
    const header = parseHeader(frame);
    const payload = frame.subarray(FRAG_HEADER_LEN);
    let entry = this.pending.get(header.msgTag);
    if (!entry) {
      entry = { total: header.total, frames: new Map(), firstSeenMs: nowMs };
      this.pending.set(header.msgTag, entry);
    }
    // A conflicting total for the same msgTag means a tag collision; keep the
    // first one seen and ignore mismatched frames.
    if (entry.total !== header.total) return null;
    if (!entry.frames.has(header.index)) {
      entry.frames.set(header.index, payload);
    }
    if (entry.frames.size === entry.total) {
      const out = new Uint8Array(
        [...entry.frames.values()].reduce((n, p) => n + p.length, 0),
      );
      let offset = 0;
      for (let i = 0; i < entry.total; i++) {
        const part = entry.frames.get(i) as Uint8Array;
        out.set(part, offset);
        offset += part.length;
      }
      this.pending.delete(header.msgTag);
      return out;
    }
    return null;
  }

  /** Drop reassembly buffers older than REASSEMBLY_TIMEOUT_MS. */
  purge(nowMs: number = Date.now()): number {
    let dropped = 0;
    for (const [tag, entry] of this.pending) {
      if (nowMs - entry.firstSeenMs > REASSEMBLY_TIMEOUT_MS) {
        this.pending.delete(tag);
        dropped++;
      }
    }
    return dropped;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
