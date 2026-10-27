// SPDX-License-Identifier: Apache-2.0
// Hex / bytes helpers used across the protocol package.

const HEX = '0123456789abcdef';

/** Encode bytes as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/** Decode a lowercase/uppercase hex string. Throws on odd length or bad chars. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`fromHex: odd length ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = HEX.indexOf(hex[2 * i].toLowerCase());
    const lo = HEX.indexOf(hex[2 * i + 1].toLowerCase());
    if (hi < 0 || lo < 0) throw new Error(`fromHex: invalid hex char in "${hex}"`);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Constant-ish-time equality for same-length buffers (avoids early exit). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
