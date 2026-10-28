// SPDX-License-Identifier: Apache-2.0
import { ReceiptDedup, dayBucket } from './dedup';
import { RECEIPT_DAY_BUCKET_S } from '../events/types';
import { toHex } from '../hex';
import { makeKeypair, makePost } from '../test-helpers';

const DAY = RECEIPT_DAY_BUCKET_S;
const T0 = 1_700_000_000 - (1_700_000_000 % DAY) + 3600; // 01:00 UTC on a day boundary

describe('receipt dedup', () => {
  test('dayBucket floors to UTC day', () => {
    expect(dayBucket(T0)).toBe(Math.floor(T0 / DAY));
    expect(dayBucket(T0 + DAY - 3601)).toBe(dayBucket(T0)); // 23:59:59 same day
    expect(dayBucket(T0 + DAY - 3600)).toBe(dayBucket(T0) + 1); // next day 00:00
  });

  test('same device + post + day is counted once', () => {
    const dedup = new ReceiptDedup();
    const { publicKey } = makeKeypair();
    const postId = toHex(makePost('viewed').id);
    const device = toHex(publicKey);
    expect(dedup.add(device, postId, T0)).toBe(true);
    expect(dedup.add(device, postId, T0 + 100)).toBe(false); // replay
    expect(dedup.add(device, postId, T0 + DAY - 3601)).toBe(false); // same day, 23:59:59
    expect(dedup.count(postId)).toBe(1);
  });

  test('next UTC day counts again', () => {
    const dedup = new ReceiptDedup();
    const { publicKey } = makeKeypair();
    const postId = toHex(makePost('daily').id);
    const device = toHex(publicKey);
    expect(dedup.add(device, postId, T0)).toBe(true);
    expect(dedup.add(device, postId, T0 + DAY)).toBe(true);
    expect(dedup.count(postId)).toBe(2);
  });

  test('a different device counts separately on the same day', () => {
    const dedup = new ReceiptDedup();
    const a = toHex(makeKeypair().publicKey);
    const b = toHex(makeKeypair().publicKey);
    const postId = toHex(makePost('popular').id);
    expect(dedup.add(a, postId, T0)).toBe(true);
    expect(dedup.add(b, postId, T0 + 5)).toBe(true);
    expect(dedup.count(postId)).toBe(2);
  });

  test('counts are per-post', () => {
    const dedup = new ReceiptDedup();
    const device = toHex(makeKeypair().publicKey);
    const p1 = toHex(makePost('one').id);
    const p2 = toHex(makePost('two').id);
    dedup.add(device, p1, T0);
    dedup.add(device, p2, T0);
    expect(dedup.count(p1)).toBe(1);
    expect(dedup.count(p2)).toBe(1);
    expect(dedup.count('nope')).toBe(0);
  });
});
