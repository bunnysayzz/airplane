// SPDX-License-Identifier: Apache-2.0
// BLE GATT profile for the Airplane mesh (v1, Android only).
//
// One GATT service per phone, acting as peripheral. Every phone is BOTH a
// central (scans, connects, writes frames) and a peripheral (advertises,
// serves frames) - the tie-break rule in gatt.ts keeps one connection per
// pair.
//
//   Service MESH_SERVICE_UUID (primary)
//   - MESH_RX_CHAR_UUID    write, write-without-response : central -> peripheral datagrams
//   - MESH_TX_CHAR_UUID    notify                       : peripheral -> central datagrams
//   - MESH_IDENT_CHAR_UUID read (+write for the hello)  : 64-char hex peerId
//
// Discovery: the peripheral advertises manufacturer data only (company id
// 0xFFFF + 8-byte peer tag = first 8 bytes of the Ed25519 pubkey) - 12 bytes
// total, well inside the 31-byte legacy advertise budget. The 128-bit
// service UUID is deliberately NOT in the advertise packet: it would cost
// another 18 bytes and this peripheral library always attaches service data
// alongside a service UUID (another 26), blowing the budget. Consequence:
// the central scans unfiltered and filters by manufacturer id in JS (no
// hardware scan filter in v1 - a battery trade-off, documented).
// R3 audit result, verified against the packet math above: the packet is
// 2 (AD header) + 2 (company id) + 8 (tag) = 12 bytes, so size is NOT the
// advertise failure; any scan filter on the service UUID would never
// match this packet, so the scan must stay unfiltered with the JS
// manufacturer-data filter (see gatt.ts central scan). Do not "fix"
// discovery by adding a UUID filter.
// The full peerId is resolved after connect via the IDENT characteristic
// (central reads it) or the hello datagram (peripheral side learns the
// central's identity when it writes its hello).
//
// Port-layer datagram framing (below the protocol fragment layer):
//   u16be(totalLen) || kind(u8) || payload
//   kind 0x01 (hello): 32-byte pubkey || u16be(central ATT MTU)
//   kind 0x02 (frame): one protocol fragment (11-byte header + payload)
// Datagrams are chunked to (link MTU - 3) ATT PDUs on send and reassembled
// per remote on receive. The receiver dispatches on kind.
//
// RADIO-UNVERIFIED: no two physical devices exist in this environment; the
// profile below is implemented against library sources and unit tests, never
// against a live radio. Multi-phone interop is an open item.

/** GATT service: the Airplane mesh service (fixed, v1). */
export const MESH_SERVICE_UUID = '7dd7bba6-fe73-4dde-b09e-db3ef75ec2ba';
/** RX characteristic: central -> peripheral datagrams (write). */
export const MESH_RX_CHAR_UUID = 'b44060bc-7918-4e95-aabd-fe08327ad228';
/** TX characteristic: peripheral -> central datagrams (notify). */
export const MESH_TX_CHAR_UUID = '09773929-00a4-49d7-9b1e-cfba4fb8c509';
/** IDENT characteristic: read returns the 64-char hex peerId. */
export const MESH_IDENT_CHAR_UUID = '9e849f21-2e3b-42d4-b3b7-4e9a0ead3116';

/**
 * Bluetooth SIG company id used in the advertise packet. 0xFFFF is the
 * spec-reserved testing value - replace with a SIG-assigned id before any
 * production release.
 */
export const ADVERTISE_COMPANY_ID = 0xffff;

/** 8-byte peer tag length (first 8 bytes of the Ed25519 pubkey). */
export const PEER_TAG_LEN = 8;

/** Default ATT MTU before negotiation (23 - 3 bytes ATT overhead = 20). */
export const ATT_DEFAULT_MTU = 23;
/** ATT PDU overhead for a write/notification. */
export const ATT_OVERHEAD = 3;
/** MTU we request on connect (Android max is 517). */
export const ATT_REQUEST_MTU = 512;

/** Max simultaneous BLE peers (bounded peer set; BLE radios degrade past this). */
export const MAX_BLE_PEERS = 8;

/** Port-layer datagram kinds. */
export const DATAGRAM_HELLO = 0x01;
export const DATAGRAM_FRAME = 0x02;

/** Length-prefix size for port-layer datagrams. */
export const DATAGRAM_LEN_PREFIX = 2;

/** Max buffered bytes per remote while reassembling datagrams (DoS bound). */
export const MAX_DATAGRAM_BUFFER = 66 * 1024;

/**
 * Derive the 8-byte advertise tag from a 32-byte Ed25519 pubkey.
 * The tag is a discovery hint only; identity is always the full pubkey.
 */
export function peerTagOf(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error(`peerTagOf: expected 32-byte pubkey, got ${publicKey.length}`);
  }
  return publicKey.slice(0, PEER_TAG_LEN);
}

/** Lexicographic byte comparison: -1 | 0 | 1. Tie-break for who connects. */
export function compareTags(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** Encode a port-layer datagram: u16be(len) || kind || payload. */
export function encodeDatagram(kind: number, payload: Uint8Array): Uint8Array {
  if (kind < 0 || kind > 255 || !Number.isInteger(kind)) {
    throw new Error(`encodeDatagram: bad kind ${kind}`);
  }
  const total = 1 + payload.length;
  if (total > 0xffff) throw new Error('encodeDatagram: payload too large');
  const out = new Uint8Array(DATAGRAM_LEN_PREFIX + total);
  out[0] = (total >> 8) & 0xff;
  out[1] = total & 0xff;
  out[2] = kind;
  out.set(payload, 3);
  return out;
}

/** Encode the identity hello payload: 32-byte pubkey || u16be(centralMtu). */
export function encodeHello(publicKey: Uint8Array, centralMtu: number): Uint8Array {
  if (publicKey.length !== 32) throw new Error('encodeHello: pubkey must be 32 bytes');
  if (!Number.isInteger(centralMtu) || centralMtu < ATT_DEFAULT_MTU || centralMtu > 517) {
    throw new Error(`encodeHello: bad mtu ${centralMtu}`);
  }
  const payload = new Uint8Array(34);
  payload.set(publicKey, 0);
  payload[32] = (centralMtu >> 8) & 0xff;
  payload[33] = centralMtu & 0xff;
  return encodeDatagram(DATAGRAM_HELLO, payload);
}

/** Parse a hello payload. Returns null on malformed input. */
export function parseHello(payload: Uint8Array): { publicKey: Uint8Array; centralMtu: number } | null {
  if (payload.length !== 34) return null;
  const mtu = (payload[32] << 8) | payload[33];
  if (mtu < ATT_DEFAULT_MTU || mtu > 517) return null;
  return { publicKey: payload.slice(0, 32), centralMtu: mtu };
}

/**
 * Reassemble length-prefixed datagrams from ATT chunks, per remote.
 * Returns complete datagrams (kind || payload, without the length prefix).
 * Oversized buffers are dropped to bound memory.
 */
/**
 * Window within which a datagram must complete. A partial buffer older
 * than this is dropped by expireIfStale (called from feedChunk) so one
 * corrupt first chunk cannot poison the stream until the 66 KB cap drops
 * everything. The 66 KB cap stays as a second bound.
 */
export const DATAGRAM_STALE_MS = 10_000;

export class DatagramReassembler {
  private buf = new Uint8Array(0);
  private lastActivityMs = 0;

  /**
   * Drop the buffer when no datagram completed within the stale window.
   * Returns true when a partial buffer was dropped.
   */
  expireIfStale(nowMs: number = Date.now(), windowMs: number = DATAGRAM_STALE_MS): boolean {
    if (this.buf.length === 0) return false;
    if (nowMs - this.lastActivityMs > windowMs) {
      this.buf = new Uint8Array(0);
      return true;
    }
    return false;
  }

  /** Feed one ATT chunk; returns any complete datagrams in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (chunk.length === 0) return out;
    this.lastActivityMs = Date.now();
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    if (this.buf.length > MAX_DATAGRAM_BUFFER) {
      // Corrupt or hostile stream: drop everything, start over.
      this.buf = new Uint8Array(0);
      return out;
    }
    while (this.buf.length >= DATAGRAM_LEN_PREFIX) {
      const total = (this.buf[0] << 8) | this.buf[1];
      if (this.buf.length < DATAGRAM_LEN_PREFIX + total) break;
      out.push(this.buf.slice(DATAGRAM_LEN_PREFIX, DATAGRAM_LEN_PREFIX + total));
      this.buf = this.buf.slice(DATAGRAM_LEN_PREFIX + total);
    }
    return out;
  }

  /** Buffered byte count (for tests). */
  get buffered(): number {
    return this.buf.length;
  }
}

/** Split bytes into chunks of at most size bytes. */
export function chunkBytes(bytes: Uint8Array, size: number): Uint8Array[] {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`chunkBytes: bad size ${size}`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.slice(i, Math.min(i + size, bytes.length)));
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encode bytes (no Buffer dependency; RN-safe). */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

/** Base64-decode to bytes. Returns null on invalid input. */
export function fromBase64(s: string): Uint8Array | null {
  const clean = s.replace(/\s/g, '');
  if (clean.length % 4 !== 0) return null;
  const vals = new Uint8Array(clean.length);
  let pad = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '=') {
      vals[i] = 0;
      pad++;
      continue;
    }
    const v = B64.indexOf(c);
    if (v < 0) return null;
    vals[i] = v;
  }
  if (pad > 2) return null;
  const outLen = (clean.length / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}
