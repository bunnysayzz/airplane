// SPDX-License-Identifier: Apache-2.0
// View tracking: FlashList viewability -> signed view receipts.
//
// Wire FlashList's `onViewableItemsChanged` to `trackViewability`. For every
// newly viewable post (by event id), this emits a signed kind-2 view receipt
// into the store. The store enforces the dedup policy (one countable view
// per (device, post, UTC day)); this layer additionally tracks what it has
// already emitted this launch so it doesn't re-sign for the same post.
//
// Receipts are signed with the device keypair (see identity.ts). NOTE the
// honest limitation: until P2 the keypair is ephemeral per launch, so the
// (pubkey, post, day) dedup bucket changes identity on restart — the same
// device can count twice for one post across launches. TODO(P2): fixed by the
// stable KeyStore-backed keypair.

import { createViewReceipt, fromHex } from '@airplane/protocol';
import { getDeviceKeypair, crypto } from './identity';
import { getStore } from './store';
import { notifyFeedListeners } from './feed';

export interface ViewabilityInfo {
  viewableItems: Array<{ key: string }>;
}

const HEX64 = /^[0-9a-f]{64}$/i;

// Event ids already receipted this launch (module scope = app launch).
const receiptedThisLaunch = new Set<string>();

/**
 * Pure: which viewable keys are newly seen event ids?
 * - `prev`: ids already handled (mutated by caller convention).
 * - `viewableKeys`: raw FlashList keys.
 * Returns only valid 64-hex event ids not already in `prev`; adds the
 * returned ids to `prev`.
 */
export function extractNewViewIds(prev: Set<string>, viewableKeys: string[]): string[] {
  const fresh: string[] = [];
  for (const key of viewableKeys) {
    if (typeof key !== 'string') continue;
    const id = key.toLowerCase();
    if (!HEX64.test(id)) continue;
    if (prev.has(id)) continue;
    prev.add(id);
    fresh.push(id);
  }
  return fresh;
}

/**
 * Emit a signed view receipt for one post id. Returns true when the receipt
 * was new and countable (store dedup accepted it).
 */
export async function emitViewReceipt(postIdHex: string): Promise<boolean> {
  const store = getStore();
  const post = await store.getEvent(postIdHex);
  if (!post) return false; // receipt only references posts we actually hold
  const { publicKey, secretKey } = await getDeviceKeypair();
  const receipt = createViewReceipt({
    crypto,
    secretKey,
    pubkey: publicKey,
    geohash5: post.geohash,
    postId: fromHex(postIdHex),
    createdAt: Math.floor(Date.now() / 1000),
  });
  const accepted = await store.saveReceipt(receipt);
  if (accepted) notifyFeedListeners(); // views/score changed
  return accepted;
}

/**
 * FlashList `onViewableItemsChanged` handler. Fire-and-forget: returns void;
 * receipt failures are swallowed (views are best-effort, never fatal).
 */
export function trackViewability(info: ViewabilityInfo): void {
  const keys = (info?.viewableItems ?? []).map((i) => i?.key).filter(Boolean) as string[];
  const fresh = extractNewViewIds(receiptedThisLaunch, keys);
  if (fresh.length === 0) return;
  void Promise.all(fresh.map((id) => emitViewReceipt(id).catch(() => false)));
}

/** Test seam: clear the per-launch receipt set. */
export function __resetViewTrackerForTests(): void {
  receiptedThisLaunch.clear();
}
