// SPDX-License-Identifier: Apache-2.0
// react-native-mmkv KV adapter (STORE-5, linked in T2).
//
// The adapter takes the MMKV instance as a constructor argument instead of
// importing 'react-native-mmkv' here, so this package stays native-free
// and unit-testable: the app wires a real `new MMKV({ id: 'airplane-kv' })`
// (see apps/mobile/services/airplane/kv.ts), tests inject a Map-backed
// fake. In Jest, react-native-mmkv itself returns a mock instance, so the
// app-level wiring is testable too.
//
// SECURITY - READ BEFORE WIRING: MMKV is NOT a secrets store. Identity
// private keys, seed phrases, and any other secret material must NEVER go
// through KvPort. Secrets live in iOS Keychain / Android Keystore (P2);
// KvPort is for non-secret app state only (cursors, flags, UI prefs).

import type { KvPort } from './ports';

/**
 * Minimal structural subset of the react-native-mmkv `MMKV` class used
 * here. `set` accepts only strings through this adapter (KvPort is
 * string-only); the real class accepts more types, which is fine — a
 * wider-accepting method satisfies this narrower interface.
 */
export interface MmkvLike {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** KvPort over a react-native-mmkv instance. */
export class MmkvKv implements KvPort {
  constructor(private readonly mmkv: MmkvLike) {}

  async get(key: string): Promise<string | null> {
    return this.mmkv.getString(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.mmkv.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.mmkv.delete(key);
  }
}
