// SPDX-License-Identifier: Apache-2.0
// DM P1 — sealed relay direct messages (plan: dm-plan.md §4–§8).
//
// DESIGN — read before touching the crypto:
// * Airplane identities are Ed25519 mesh keys; there is NO published secp256k1
//   DM address per author (the Nostr envelope key is ephemeral per transport
//   instance, and post events carry only the mesh pubkey). So a post author's
//   DM address IS their mesh pubkey hex, and ECDH runs over X25519 with keys
//   converted from the Ed25519 device key (libsodium-style conversion:
//   secret = SHA-512(edSecret)[:32], public u = (1+y)/(1-y) mod p). The
//   envelope shape follows NIP-17 (ephemeral-key gift wrap, kind-1059-style
//   wrapper, kind-14 rumor) and the payload follows NIP-44 v2 (version 0x02,
//   32-byte nonce, HKDF-SHA256, ChaCha20, HMAC-SHA256 over nonce||ciphertext,
//   base64 [version|nonce|ciphertext|mac], NIP-44 padding shape) — but the
//   ECDH curve is X25519, NOT secp256k1, so payloads are NOT byte-compatible
//   with standard Nostr clients. A future protocol change that publishes a
//   secp256k1 DM address per author would make this fully NIP-17/NIP-44.
// * The rumor's sender pubkey is a CLAIM, not a proof (same property as
//   NIP-17: anyone can seal a rumor to a recipient). Abuse is handled by the
//   requests folder + block (§7), not by authentication here.
// * Sealed bytes at rest: the store holds only sealed payloads; plaintext is
//   produced by decrypt-on-read and never written to disk. DM keys come from
//   the existing device key material (orders: proceed without T8 keystore
//   hardening; sealed-at-rest is the safe default, device-unlock threat is
//   out of scope per plan §8).
// * NO read receipts (orders + plan §9 decision 1): nothing here sends or
//   requests a receipt. TEXT-ONLY v1, 4 KiB cap (plan §9 decision 6: "some
//   KB" — decided here as 4096 bytes).
// * Delivery states are exactly Sending / Sent / Failed (orders). Sent means
//   a relay accepted the sealed envelope, nothing more — never "Delivered".

import { x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha512.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';

/** Max DM plaintext, bytes (UTF-8). Plan §7 size cap, decided here: 4 KiB. */
export const DM_TEXT_MAX_BYTES = 4096;

/** Outbox retry cap: after this many failed attempts the message is Failed. */
export const DM_MAX_ATTEMPTS = 5;

/** Backoff before attempts 2..5 (ms): fast first, then slower. Attempt 1 is immediate. */
export const DM_BACKOFF_MS = [0, 1000, 5000, 30000, 120000];

/** Placeholder shown when a stored message cannot be decrypted. Never crashes. */
export const DM_UNDECRYPTABLE_PLACEHOLDER = 'Encrypted message';

// ---------------------------------------------------------------------------
// Small byte helpers (no node Buffer: this package also ships to React Native)
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

export function dmToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0x0f];
  return out;
}

export function dmFromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

export function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function dmToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2] + B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 0x3f] : '=';
  }
  return out;
}

export function dmFromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const rev = new Map<string, number>();
  for (let i = 0; i < 64; i++) rev.set(B64[i], i);
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const v0 = rev.get(s[i]);
    const v1 = rev.get(s[i + 1]);
    const v2 = s[i + 2] === '=' ? 0 : rev.get(s[i + 2]);
    const v3 = s[i + 3] === '=' ? 0 : rev.get(s[i + 3]);
    if (v0 === undefined || v1 === undefined || v2 === undefined || v3 === undefined) return null;
    out.push((v0 << 2) | (v1 >> 4));
    if (s[i + 2] !== '=') out.push(((v1 & 0x0f) << 4) | (v2 >> 2));
    if (s[i + 3] !== '=') out.push(((v2 & 0x03) << 6) | v3);
  }
  return new Uint8Array(out);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// ChaCha20 (RFC 8439) — @noble/ciphers is not a dependency, so this is local.
// Counter starts at 0; the 12-byte nonce occupies the last three state words.
// ---------------------------------------------------------------------------

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) | 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

function chacha20Block(key: Uint8Array, nonce12: Uint8Array, counter: number): Uint8Array {
  const st = new Uint32Array(16);
  st[0] = 0x61707865;
  st[1] = 0x3320646e;
  st[2] = 0x79622d32;
  st[3] = 0x6b206574;
  const le = (b: Uint8Array, off: number): number =>
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) | 0;
  for (let i = 0; i < 8; i++) st[4 + i] = le(key, i * 4);
  st[12] = counter | 0;
  for (let i = 0; i < 3; i++) st[13 + i] = le(nonce12, i * 4);
  const work = new Uint32Array(st);
  for (let r = 0; r < 10; r++) {
    quarterRound(work, 0, 4, 8, 12);
    quarterRound(work, 1, 5, 9, 13);
    quarterRound(work, 2, 6, 10, 14);
    quarterRound(work, 3, 7, 11, 15);
    quarterRound(work, 0, 5, 10, 15);
    quarterRound(work, 1, 6, 11, 12);
    quarterRound(work, 2, 7, 8, 13);
    quarterRound(work, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (work[i] + st[i]) | 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >> 8) & 0xff;
    out[i * 4 + 2] = (v >> 16) & 0xff;
    out[i * 4 + 3] = (v >> 24) & 0xff;
  }
  return out;
}

export function chacha20(key: Uint8Array, nonce12: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce12.length !== 12) throw new Error('chacha20: bad key/nonce length');
  const out = new Uint8Array(data.length);
  let counter = 0;
  for (let off = 0; off < data.length; off += 64) {
    const block = chacha20Block(key, nonce12, counter);
    counter = (counter + 1) | 0;
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ block[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ed25519 -> X25519 conversion (libsodium-style) + NIP-44-style payload
// ---------------------------------------------------------------------------

const P25519 = (1n << 255n) - 19n;

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bigIntToBytesLE(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = v;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Ed25519 public key (32 B, Edwards y + sign bit) -> X25519 u-coordinate. */
export function meshPubkeyToX25519(meshPubkey: Uint8Array): Uint8Array {
  if (meshPubkey.length !== 32) throw new Error('meshPubkeyToX25519: pubkey must be 32 bytes');
  const masked = meshPubkey.slice();
  masked[31] &= 0x7f; // drop the Edwards x-sign bit; y is what the map needs
  const y = bytesToBigIntLE(masked);
  const u = (((1n + y) % P25519) * modPow((1n - y) % P25519, P25519 - 2n, P25519)) % P25519;
  return bigIntToBytesLE(u, 32);
}

export interface DmKeypair {
  /** X25519 secret, SHA-512(device Ed25519 secret)[:32] (noble clamps on use). */
  secretKey: Uint8Array;
  /** X25519 public key (u-coordinate, 32 B). */
  publicKey: Uint8Array;
}

/** Derive this device's DM keypair from its Ed25519 device secret (32 B). */
export function dmKeypairFromDeviceSecret(deviceSecret: Uint8Array): DmKeypair {
  if (deviceSecret.length !== 32) throw new Error('dmKeypairFromDeviceSecret: secret must be 32 bytes');
  const secretKey = sha512(deviceSecret).slice(0, 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** NIP-44 v2 conversation key: HKDF-extract(salt 'nip44-v2', IKM = X25519 shared secret). */
export function dmConversationKey(ownSecret: Uint8Array, peerMeshPubkey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(ownSecret, meshPubkeyToX25519(peerMeshPubkey));
  return hkdf(sha256, shared, new TextEncoder().encode('nip44-v2'), undefined, 32);
}

/** Conversation key between two X25519 parties (gift-wrap ephemeral path). */
export function dmConversationKeyX(ownSecret: Uint8Array, peerX25519Pubkey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(ownSecret, peerX25519Pubkey);
  return hkdf(sha256, shared, new TextEncoder().encode('nip44-v2'), undefined, 32);
}

/** NIP-44-style padding: 2-byte BE length prefix + plaintext + zero pad. */
function nip44Pad(plaintext: Uint8Array): Uint8Array {
  const total = plaintext.length + 2;
  let paddedLen: number;
  if (total <= 32) paddedLen = 32;
  else {
    const nextPow2 = 2 ** Math.ceil(Math.log2(total));
    const chunk = nextPow2 > 256 ? nextPow2 / 8 : 32;
    paddedLen = Math.ceil(total / chunk) * chunk;
  }
  const out = new Uint8Array(paddedLen);
  out[0] = (plaintext.length >> 8) & 0xff;
  out[1] = plaintext.length & 0xff;
  out.set(plaintext, 2);
  return out;
}

function nip44Unpad(padded: Uint8Array): Uint8Array | null {
  if (padded.length < 2) return null;
  let len: number;
  let header: number;
  if (padded[0] === 0 && padded[1] === 0) {
    if (padded.length < 6) return null;
    len = (padded[2] << 24) | (padded[3] << 16) | (padded[4] << 8) | padded[5];
    header = 6;
  } else {
    len = (padded[0] << 8) | padded[1];
    header = 2;
  }
  if (header + len > padded.length) return null;
  for (let i = header + len; i < padded.length; i++) if (padded[i] !== 0) return null;
  return padded.slice(header, header + len);
}

/**
 * NIP-44 v2 payload: base64([0x02 | nonce32 | ciphertext | mac32]).
 * Message keys = HKDF-expand(conversationKey, info=nonce, L=76) split into
 * ChaCha20 key (32) | ChaCha20 nonce (12) | HMAC key (32); MAC = HMAC-SHA256
 * over nonce || ciphertext. Throws on bad input; never returns partial text.
 */
export function nip44Encrypt(plaintext: string, conversationKey: Uint8Array, nonce?: Uint8Array): string {
  if (conversationKey.length !== 32) throw new Error('nip44Encrypt: conversation key must be 32 bytes');
  const nonce32 = nonce ?? x25519.utils.randomSecretKey();
  if (nonce32.length !== 32) throw new Error('nip44Encrypt: nonce must be 32 bytes');
  const keys = hkdf(sha256, conversationKey, undefined, nonce32, 76);
  const cipherKey = keys.slice(0, 32);
  const cipherNonce = keys.slice(32, 44);
  const macKey = keys.slice(44, 76);
  const padded = nip44Pad(new TextEncoder().encode(plaintext));
  const ciphertext = chacha20(cipherKey, cipherNonce, padded);
  const mac = hmac(sha256, macKey, concat(nonce32, ciphertext));
  const payload = concat(new Uint8Array([0x02]), nonce32, ciphertext, mac);
  return dmToBase64(payload);
}

/** Returns the plaintext, or null when the payload is undecryptable (bad MAC, version, shape). */
export function nip44Decrypt(payloadB64: string, conversationKey: Uint8Array): string | null {
  try {
    if (conversationKey.length !== 32) return null;
    const payload = dmFromBase64(payloadB64);
    if (!payload || payload.length < 1 + 32 + 32 + 32 || payload[0] !== 0x02) return null;
    const nonce32 = payload.slice(1, 33);
    const ciphertext = payload.slice(33, payload.length - 32);
    const mac = payload.slice(payload.length - 32);
    const keys = hkdf(sha256, conversationKey, undefined, nonce32, 76);
    const cipherKey = keys.slice(0, 32);
    const cipherNonce = keys.slice(32, 44);
    const macKey = keys.slice(44, 76);
    const expected = hmac(sha256, macKey, concat(nonce32, ciphertext));
    if (!equalBytes(mac, expected)) return null;
    const padded = chacha20(cipherKey, cipherNonce, ciphertext);
    const plain = nip44Unpad(padded);
    if (!plain) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gift wrap (NIP-17-style): kind-14 rumor sealed to the recipient with an
// ephemeral X25519 key; the wrap carries the ephemeral pubkey + recipient hex.
// The relay sees the recipient hex and the ephemeral pubkey, never content.
// ---------------------------------------------------------------------------

export interface DmRumor {
  kind: 14;
  pubkey: string; // sender mesh pubkey hex (a claim, not a proof — see header)
  created_at: number;
  tags: string[][]; // [['p', recipientHex]]
  content: string; // plaintext DM text
}

export interface DmEnvelope {
  /** Ephemeral X25519 pubkey hex — the recipient derives the shared secret from it. */
  ephemeralPubkeyHex: string;
  /** Recipient mesh pubkey hex (the `p` tag value a relay filters on). */
  recipientHex: string;
  /** NIP-44-style sealed rumor JSON. */
  sealed: string;
  createdAt: number; // epoch seconds
}

/** Seal a DM for `recipientMeshHex`. `senderMeshHex` is recorded in the rumor. */
export function sealDm(
  text: string,
  senderMeshHex: string,
  recipientMeshHex: string,
  createdAtSec?: number,
): DmEnvelope {
  const recipient = dmFromHex(recipientMeshHex);
  if (!recipient || recipient.length !== 32) throw new Error('sealDm: bad recipient pubkey');
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralPubkey = x25519.getPublicKey(ephemeralSecret);
  const convKey = dmConversationKeyX(ephemeralSecret, meshPubkeyToX25519(recipient));
  const rumor: DmRumor = {
    kind: 14,
    pubkey: senderMeshHex,
    created_at: createdAtSec ?? Math.floor(Date.now() / 1000),
    tags: [['p', recipientMeshHex]],
    content: text,
  };
  return {
    ephemeralPubkeyHex: dmToHex(ephemeralPubkey),
    recipientHex: recipientMeshHex,
    sealed: nip44Encrypt(JSON.stringify(rumor), convKey),
    createdAt: rumor.created_at,
  };
}

/**
 * Unseal an envelope addressed to this device. Returns the rumor, or null
 * when the envelope is not for us, corrupt, or tampered with (relay view and
 * any third party get null — gibberish, never plaintext).
 */
export function unsealDm(envelope: DmEnvelope, ownDmKeys: DmKeypair): DmRumor | null {
  try {
    const ephemeral = dmFromHex(envelope.ephemeralPubkeyHex);
    if (!ephemeral || ephemeral.length !== 32) return null;
    const convKey = dmConversationKeyX(ownDmKeys.secretKey, ephemeral);
    const json = nip44Decrypt(envelope.sealed, convKey);
    if (!json) return null;
    const rumor = JSON.parse(json) as DmRumor;
    if (rumor.kind !== 14 || typeof rumor.content !== 'string' || typeof rumor.pubkey !== 'string') return null;
    if (!isHex64(rumor.pubkey)) return null;
    return rumor;
  } catch {
    return null;
  }
}
