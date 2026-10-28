// SPDX-License-Identifier: Apache-2.0
// View tracking: FlashList viewability -> signed view receipts.
//
// Wire FlashList's `onViewableItemsChanged` to `trackViewability`. For every
// newly viewable post (by event id), this emits a signed kind-2 view receipt
// into the store. The store enforces the dedup policy (one countable view
// per (device, post, UTC day)); this layer additionally tracks what it has
// already emitted this launch so it doesn't re-sign for the same post.
//
// Receipts are signed with the stable device keypair (see identity.ts), so
// the store's (pubkey, post, day) dedup bucket is a stable device identity
// across restarts: the same device re-viewing a post after a restart does
// NOT count twice.

import { EVENT_KIND_RECEIPT, type EventKind } from '@airplane/protocol';
import { onIdentityChange, signDeviceEvent } from './identity';
import { getStore } from './store';
import { notifyFeedListeners } from './feed';

export interface ViewabilityInfo {
  viewableItems: Array<{ key: string }>;
}

const HEX64 = /^[0-9a-f]{64}$/i;

// Event ids already receipted this launch (module scope = app launch).
const receiptedThisLaunch = new Set<string>();

// T8 rotation: a new identity may legitimately receipt the same post again
// (dedup is per pubkey), so a burn clears the per-launch set.
onIdentityChange(() => {
  receiptedThisLaunch.clear();
});

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
  // Dead posts earn no view: a deleted or expired post must not be
  // signed and counted, even though getEvent still returns its row.
  const state = await store.getPostState(postIdHex.toLowerCase());
  if (!state || state.deleted || state.expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  // T8: signed through the KeyStorePort sign() seam — same wire shape as
  // createViewReceipt, but the secret key never enters this module.
  const receipt = await signDeviceEvent({
    created_at: Math.floor(Date.now() / 1000),
    kind: EVENT_KIND_RECEIPT as EventKind,
    geohash: post.geohash,
    tags: [['e', postIdHex.toLowerCase()]],
    content: '',
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
