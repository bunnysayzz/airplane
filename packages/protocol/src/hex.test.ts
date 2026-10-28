// SPDX-License-Identifier: Apache-2.0
import { toHex, fromHex, bytesEqual } from './hex';

describe('toHex', () => {
  test('encodes bytes as lowercase hex', () => {
    expect(toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  test('encodes empty input as empty string', () => {
    expect(toHex(new Uint8Array(0))).toBe('');
  });

  test('zero-pads single nibbles', () => {
    expect(toHex(new Uint8Array([0x0f, 0x00, 0x01]))).toBe('0f0001');
  });
});

describe('fromHex', () => {
  test('decodes lowercase hex', () => {
    expect(fromHex('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('decodes uppercase hex', () => {
    expect(fromHex('DEADBEEF')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('decodes mixed case hex', () => {
    expect(fromHex('DeAdBeEf')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test('decodes empty string to empty bytes', () => {
    expect(fromHex('')).toEqual(new Uint8Array(0));
  });

  test('throws on odd length', () => {
    expect(() => fromHex('abc')).toThrow(/odd length/);
  });

  test('throws on invalid hex chars', () => {
    expect(() => fromHex('zz')).toThrow(/invalid hex char/);
    expect(() => fromHex('de!d')).toThrow(/invalid hex char/);
  });
});

describe('toHex/fromHex round-trip', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });
});

describe('bytesEqual', () => {
  test('equal buffers return true', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  test('different buffers return false', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  test('different lengths return false', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  test('empty buffers are equal', () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
