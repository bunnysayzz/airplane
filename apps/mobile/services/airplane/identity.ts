// SPDX-License-Identifier: Apache-2.0
// Device identity stub.
//
// TODO(P2): replace with the real identity subsystem — a STABLE per-device
// Ed25519 keypair persisted in the platform keystore (iOS Keychain / Android
// Keystore) behind the `KeyStorePort` planned in packages/crypto
// (blueprint-v2 PLAN_CHANGELOG.md §1 item 5). That work does not exist yet.
//
// Until then this returns one EPHEMERAL keypair per app launch (cached in
// module scope so every post/receipt in a launch shares the same pseudonym).
// Consequences, stated honestly:
//   - Tombstones break across launches: a tombstone signed tomorrow won't
//     match the author pubkey of a post signed today (authorship continuity).
//   - Receipt dedup breaks across launches: the store dedups per
//     (device-pubkey, post, day), so the same device re-viewing a post after
//     a restart counts twice.
// Both are fixed the moment the keypair becomes stable + persistent.

import { NobleCrypto, type CryptoPort } from '@airplane/protocol';

export interface DeviceKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Shared crypto backend (pure JS; swappable for a native keystore in P2). */
export const crypto: CryptoPort = new NobleCrypto();

// TODO(P2): keypair must survive restarts; see header comment.
let launchKeypair: DeviceKeypair | null = null;

/** Stable-for-this-launch device keypair. Ephemeral — see TODO(P2) above. */
export async function getDeviceKeypair(): Promise<DeviceKeypair> {
  if (!launchKeypair) {
    launchKeypair = crypto.generateKeypair();
  }
  return launchKeypair;
}

/** Test seam: reset the launch keypair (forces regeneration on next call). */
export function __resetDeviceKeypairForTests(): void {
  launchKeypair = null;
}
