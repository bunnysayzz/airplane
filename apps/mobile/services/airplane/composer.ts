// SPDX-License-Identifier: Apache-2.0
// Post composer.
//
// Builds a signed kind-1 post event and stores it locally. The opt-in global
// uplink is a SIGNED ["uplink","1"] tag inside the event — default OFF, only
// present when the user explicitly opts in at compose time (v2 privacy rule:
// a local mesh post must never silently go global).

import {
  encodeGeohash,
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
  /** Opt-in global relay uplink. Default false. NEVER silently true. */
  uplink: boolean;
  /**
   * Override for the post's geohash-5 cell. Defaults to the current cell.
   * TODO(P2): remove the placeholder fallback — wire the real location
   * provider and fail loudly instead of posting to a fake cell.
   */
  geohash5?: string;
}

// TODO(P2): no location provider exists in the app yet, so new posts land in
// a placeholder cell. The placeholder is computed with the real geohash
// encoder (Bengaluru, where the project is built) — it is a visible hack,
// not a silent default. Location scope for listFeedPosts still comes from
// the real viewer cell passed by the caller.
function placeholderCell(): string {
  return encodeGeohash(12.9716, 77.5946, 5);
}

/** Pure builder seam: which tags a post carries for the given opts. Unit-tested. */
export function tagsForPublish(opts: PublishOpts): string[][] {
  return opts.uplink ? [['uplink', '1']] : [];
}

/**
 * Publish a post to the local mesh feed. Returns the event id (hex).
 * Throws PayloadError on empty/overlong content (protocol validation).
 */
export async function publishPost(body: string, opts: PublishOpts): Promise<string> {
  const content = normalizeContent(body);
  const { publicKey, secretKey } = await getDeviceKeypair();
  const event = signEvent(crypto, secretKey, {
    pubkey: publicKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: EVENT_KIND_POST as EventKind,
    geohash: opts.geohash5 ?? placeholderCell(),
    tags: tagsForPublish(opts),
    content,
  });
  await getStore().saveEvent(event);
  notifyFeedListeners();
  return toHex(event.id);
}
