// SPDX-License-Identifier: Apache-2.0
// react-native-mmkv KV stub (STORE-5).
//
// TODO(P2): link react-native-mmkv. On device this class is replaced by an
// adapter over `new MMKV({ id: 'airplane-kv', encryptionKey })` with the
// encryption key held in Keychain/Keystore.
//
// SECURITY — READ BEFORE WIRING: MMKV is NOT a secrets store. Identity
// private keys, seed phrases, and any other secret material must NEVER go
// through KvPort. Secrets live in iOS Keychain / Android Keystore (P2);
// KvPort is for non-secret app state only (cursors, flags, UI prefs).

import type { KvPort } from './ports';

/** KvPort stub. Every method throws until react-native-mmkv is linked (P2). */
export class MmkvKv implements KvPort {
  async get(_key: string): Promise<string | null> {
    throw new Error('react-native-mmkv not linked (P2)');
  }

  async set(_key: string, _value: string): Promise<void> {
    throw new Error('react-native-mmkv not linked (P2)');
  }

  async del(_key: string): Promise<void> {
    throw new Error('react-native-mmkv not linked (P2)');
  }
}
