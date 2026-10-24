// SPDX-License-Identifier: Apache-2.0
// Post composer.
//
// Builds a signed kind-1 post event and stores it locally. Under the
// single-feed hybrid model, every post is relay-eligible by default:
// phones with internet silently relay posts to Nostr (no opt-in tag,
// no per-post approval). World status is tracked client-side via
// worldConfirmed in storage, not via a signed tag.

import {
  normalizeContent,
  signEvent,
  toHex,
  EVENT_KIND_POST,
  type EventKind,
} from '@airplane/protocol';
import { getDeviceKeypair, crypto } from './identity';
import { getStore } from './store';
import { notifyFeedListeners } from './feed';
import { getLocationCell as resolveLocationCell } from './location';

export { LocationError, type LocationFailureCode } from './location';

export interface PublishOpts {
  /**
   * Override for the post's geohash-5 cell. Defaults to the device cell via
   * getLocationCell(). The override exists for tests/dev.
   */
  geohash5?: string;
}

/**
 * The device's current geohash-5 cell, resolved through the location
 * provider (expo-location). Async: resolving a fix may prompt for permission
 * and wait on GPS. Fails loud with LocationError on permission denied,
 * disabled services, timeout, or missing native module - never a
 * fake/default location.
 */
export async function getLocationCell(): Promise<string> {
  return resolveLocationCell();
}

/** Pure builder seam: which tags a post carries for the given opts. Unit-tested. */
export function tagsForPublish(_opts: PublishOpts): string[][] {
  return [];
}

/**
 * Publish a post to the local mesh feed. Returns the event id (hex).
 * Signed with the STABLE device keypair (identity.ts), so the post's author
 * pubkey is enforceable for tombstones and view receipts across restarts.
 * Throws PayloadError on empty/overlong content (protocol validation), and
 * throws LocationError when no geohash5 override is given and location is
 * unavailable (permission denied, services off, GPS timeout).
 */
export async function publishPost(body: string, opts: PublishOpts): Promise<string> {
  const content = normalizeContent(body);
  const { publicKey, secretKey } = await getDeviceKeypair();
  const event = signEvent(crypto, secretKey, {
    pubkey: publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: EVENT_KIND_POST as EventKind,
    geohash: opts.geohash5 ?? (await getLocationCell()),
    tags: tagsForPublish(opts),
    content,
  });
  await getStore().saveEvent(event);
  // Fan out via hybrid transport (BLE + Nostr when online). Non-blocking;
  // the post is already in the local feed.
  const { publishViaTransport } = await import('./transport');
  publishViaTransport(event).catch(() => {});
  notifyFeedListeners();
  return toHex(event.id);
}
