// SPDX-License-Identifier: Apache-2.0
// KV singleton tests (T2).
//
// In Jest, react-native-mmkv returns a mock instance (it detects
// JEST_WORKER_ID), so getKv() without a fake exercises the real wiring:
// getKv -> loadRealKv -> MmkvKv over a mock MMKV. No native module loads.

import { MemoryKv } from '@airplane/storage';
import { getKv, __resetKvForTests, __setKvForTests } from './kv';

afterEach(() => {
  __resetKvForTests();
});

describe('getKv', () => {
  test('returns the fake installed by __setKvForTests (singleton)', async () => {
    const fake = new MemoryKv();
    __setKvForTests(fake);
    expect(getKv()).toBe(fake);
    expect(getKv()).toBe(fake);
    await getKv().set('k', 'v');
    await expect(getKv().get('k')).resolves.toBe('v');
  });

  test('without a fake, builds the real MMKV-backed port (mock in Jest)', async () => {
    const kv = getKv();
    await kv.set('kv-test-key', 'hello');
    await expect(kv.get('kv-test-key')).resolves.toBe('hello');
    await kv.del('kv-test-key');
    await expect(kv.get('kv-test-key')).resolves.toBeNull();
  });

  test('__resetKvForTests drops the singleton so the next getKv rebuilds', async () => {
    const fake = new MemoryKv();
    __setKvForTests(fake);
    __resetKvForTests();
    const rebuilt = getKv();
    expect(rebuilt).not.toBe(fake);
    await rebuilt.set('after-reset', '1');
    await expect(rebuilt.get('after-reset')).resolves.toBe('1');
  });
});
