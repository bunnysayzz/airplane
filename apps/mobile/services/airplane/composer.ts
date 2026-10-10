// SPDX-License-Identifier: Apache-2.0
// Post composer.
//
// Builds a signed kind-1 post event and stores it locally. The opt-in global
// uplink is a SIGNED ["uplink","1"] tag inside the event — default OFF, only
// present when the user explicitly opts in at compose time (v2 privacy rule:
// a local mesh post must never silently go global).

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
  /** Opt-in global relay uplink. Default false. NEVER silently true. */
  uplink: boolean;
  /**
   * Override for the post's geohash-5 cell. Defaults to the device cell via
   * getLocationCell() — which throws until the real location provider lands
   * (TODO(LOC-1)). The override exists for tests/dev.
   */
  geohash5?: string;
}

// TODO(LOC-1): no location provider exists in the app yet — real GPS needs a
// device permissions flow (P2/P3). The old code fell back to hardcoded
// Bengaluru coords (12.9716, 77.5946); that was worse than honest, so it is
// gone: a fake location poisons feed scoping and erodes trust in the mesh.
// Until the provider lands, composing without an explicit cell fails loudly.
export function getLocationCell(): string {
  throw new Error(
    'getLocationCell: location unavailable — pass geohash5 explicitly until TODO(LOC-1) lands',
  );
}

/** Pure builder seam: which tags a post carries for the given opts. Unit-tested. */
export function tagsForPublish(opts: PublishOpts): string[][] {
  return opts.uplink ? [['uplink', '1']] : [];
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
  notifyFeedListeners();
  return toHex(event.id);
}
