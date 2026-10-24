// SPDX-License-Identifier: Apache-2.0
// KV singleton for the mobile app (T2: react-native-mmkv linked).
//
// Non-secret app state only (cursors, flags, UI prefs) — never identity
// keys or any secret material; those live in Keychain/Keystore. See the
// SECURITY note on packages/storage/src/mmkv.ts.
//
// The native module loads lazily inside loadRealKv(), never at module
// top level, so importing this file in the Jest harness is safe (and in
// Jest react-native-mmkv itself returns a mock instance).

import { MmkvKv, type KvPort } from '@airplane/storage';

let kv: KvPort | null = null;

/** Build the real MMKV-backed KvPort. Never call this in tests. */
function loadRealKv(): KvPort {
  // Lazy require: see the module header.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy native load
  const { MMKV } = require('react-native-mmkv') as {
    MMKV: new (opts: { id: string }) => {
      getString(key: string): string | undefined;
      set(key: string, value: string): void;
      delete(key: string): void;
    };
  };
  return new MmkvKv(new MMKV({ id: 'airplane-kv' }));
}

/** The app-wide key/value store. Create once, import everywhere. */
export function getKv(): KvPort {
  if (!kv) {
    kv = loadRealKv();
  }
  return kv;
}

/** Test seam: drop the singleton so the next getKv() rebuilds it. */
export function __resetKvForTests(): void {
  kv = null;
}

/** Test seam: install a fake KvPort (e.g. MemoryKv) for the test. */
export function __setKvForTests(fake: KvPort): void {
  kv = fake;
}
