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

export interface PublishOpts {
  /**
   * Override for the post's geohash-5 cell. Defaults to the device cell via
   * getLocationCell() - which throws until the real location provider lands
   * (location track, P2/P3). The override exists for tests/dev.
   */
  geohash5?: string;
}

// No location provider in the app yet (location track, P2/P3) - real GPS needs
// a device permissions flow. The old code fell back to hardcoded Bengaluru
// coords (12.9716, 77.5946); that was worse than honest, so it is gone: a fake
// location poisons feed scoping and erodes trust in the mesh. Until the
// provider lands, composing without an explicit cell fails loudly.
export function getLocationCell(): string {
  throw new Error(
    'getLocationCell: location unavailable - pass geohash5 explicitly until TODO(LOC-1) lands',
  );
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
 * throws when no geohash5 override is given and location is unavailable.
 */
export async function publishPost(body: string, opts: PublishOpts): Promise<string> {
  const content = normalizeContent(body);
  const { publicKey, secretKey } = await getDeviceKeypair();
  const event = signEvent(crypto, secretKey, {
    pubkey: publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: EVENT_KIND_POST as EventKind,
    geohash: opts.geohash5 ?? getLocationCell(),
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
