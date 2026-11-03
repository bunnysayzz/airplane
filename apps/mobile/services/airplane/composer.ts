// SPDX-License-Identifier: Apache-2.0
// Post composer.
//
// Builds a signed kind-1 post event and stores it locally. Under the
// single-feed hybrid model, every post is relay-eligible by default:
// phones with internet silently relay posts to Nostr (no opt-in tag,
// no per-post approval). World status is tracked client-side via
// worldConfirmed in storage, not via a signed tag.
//
// ONE DRAFT STORY: there is exactly one draft and one delivery queue,
// and they never compete. The modal text is the draft: it lives only
// in modal state, the discard guard blocks close while a publish is
// in flight, and discarding (or a kill) before save loses the text.
// Once save succeeds, the text is no longer a draft: the signed post
// is in the events table and its delivery lives in the durable post
// outbox (storage post_outbox), which survives kill and relaunch and
// drains over BLE on peer arrival and over relay via WorldSync. The
// outbox never holds unsaved text, and the modal never re-saves a
// post that already has an outbox row.

import {
  normalizeContent,
  toHex,
  EVENT_KIND_POST,
  type EventKind,
} from '@airplane/protocol';
import { getDevicePublicKey, signDeviceEvent } from './identity';
import { getStore } from './store';
import { notifyFeedListeners } from './feed';
import { recordMessage } from './diagnostics';
import {
  getLocationCell as resolveLocationCell,
  getLocatedCell,
  LOCATION_SOURCE_TAG,
  type LocationSource,
} from './location';
import {
  DISPLAY_NAME_TAG,
  getOwnDisplayName,
  normalizeDisplayName,
} from './displayNames';

export { LocationError, type LocationFailureCode } from './location';

/**
 * Which publishPost stage threw. Attached to the error so the composer catch
 * can report it (Sentry tag) without changing user-facing copy. Location is
 * deliberately NOT a stage: location failures stay typed LocationErrors and
 * propagate unwrapped, so the UI keeps mapping them to location copy.
 */
export type PublishStage = 'keypair' | 'sign' | 'save' | 'notify';

/** publishPost failure with its stage attached. `cause` holds the original. */
export class PublishError extends Error {
  readonly stage: PublishStage;

  constructor(stage: PublishStage, cause: unknown) {
    super(
      `publish failed at stage ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'PublishError';
    this.stage = stage;
    this.cause = cause;
  }
}

export interface PublishOpts {
  /**
   * Override for the post's geohash-5 cell. Defaults to the device cell via
   * getLocationCell(). The override exists for tests/dev.
   */
  geohash5?: string;
  /**
   * Display name carried on this post as a signed tag. Undefined (the
   * normal app path) means the device's own saved display name, when
   * one is set; null means explicitly no tag; a string is normalized
   * and dropped when invalid, never allowed to fail the post.
   */
  displayName?: string | null;
  /**
   * Where the post's cell came from. Only 'last-known' adds a tag: the
   * honest marker readers see on the card. Fresh and cached cells need
   * no marker, and the geohash5 override path carries no source.
   */
  locationSource?: LocationSource;
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

/**
 * Pure builder seam: which tags a post carries for the given opts.
 * Unit-tested. A display name becomes one signed tag row
 * ["display_name", name]; see displayNames.ts for why that tag is a
 * signed claim and why older installs ignore it safely.
 */
export function tagsForPublish(opts: PublishOpts): string[][] {
  const tags: string[][] = [];
  if (opts.displayName !== undefined && opts.displayName !== null) {
    const normalized = normalizeDisplayName(opts.displayName);
    if (normalized !== null) tags.push([DISPLAY_NAME_TAG, normalized]);
  }
  if (opts.locationSource === 'last-known') {
    tags.push([LOCATION_SOURCE_TAG, 'last-known']);
  }
  return tags;
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
  // T8: the keypair load stays its own stage (a keystore failure is still
  // stage 'keypair'), but signing itself goes through the KeyStorePort
  // sign() seam — publishPost never receives the secret key.
  try {
    await getDevicePublicKey();
  } catch (err) {
    throw new PublishError('keypair', err);
  }
  // Location resolves here, OUTSIDE any stage wrapper: a LocationError must
  // propagate unwrapped so the UI maps it to location copy, never generic.
  // The source travels with the post only as the last-known tag: a reader
  // can tell the cell may be stale, and the tag is signed like any other.
  let geohash: string;
  let locationSource: LocationSource | undefined;
  if (opts.geohash5) {
    geohash = opts.geohash5;
  } else {
    const located = await getLocatedCell();
    geohash = located.cell;
    locationSource = located.source;
  }
  // The display name resolves before signing, so it lands in the signed
  // tags. A KV failure here must not fail the post: the post simply
  // carries no name tag, and the memorable name still identifies it.
  let displayName: string | null = null;
  if (opts.displayName !== undefined) {
    displayName = opts.displayName;
  } else {
    try {
      displayName = await getOwnDisplayName();
    } catch {
      displayName = null;
    }
  }
  let event;
  try {
    event = await signDeviceEvent({
      created_at: Math.floor(Date.now() / 1000),
      kind: EVENT_KIND_POST as EventKind,
      geohash,
      tags: tagsForPublish({ ...opts, displayName, locationSource }),
      content,
    });
  } catch (err) {
    throw new PublishError('sign', err);
  }
  try {
    await getStore().saveEvent(event);
  } catch (err) {
    throw new PublishError('save', err);
  }
  // Enqueue the saved post for delivery retry BEFORE fan-out runs, so
  // a kill during fan-out still leaves a queued row: the post is
  // saved, so it must be retryable, not silently unsent. Enqueue is
  // idempotent and best-effort: a store failure here must not fail
  // a post that is already saved and about to fan out.
  try {
    await getStore().enqueuePostOutbox(toHex(event.id), event.created_at);
  } catch {
    // The fan-out below still runs; the row is re-created only if
    // the store recovers, and WorldSync still retries unconfirmed
    // posts over relay regardless of the outbox.
  }
  // Fan out via hybrid transport (BLE + Nostr when online). Non-blocking;
  // the post is already in the local feed. publishViaTransport itself
  // records the RouteResult in Diagnostics (relayed, sent over BLE, or
  // not delivered), so a queued result is already surfaced there and is
  // not re-recorded here. What used to be swallowed entirely was a
  // transport-start failure (the empty catch): that is now recorded.
  const { publishViaTransport } = await import('./transport');
  void publishViaTransport(event).catch((err: unknown) => {
    recordMessage({
      id: toHex(event.id),
      sequence: null,
      sizeBytes: 0,
      direction: 'outbound',
      attempts: [
        {
          transport: 'relay',
          atMs: Date.now(),
          outcome: 'failed',
          detail: err instanceof Error ? err.message : 'transport failed to start',
        },
      ],
      finalStatus: 'fan-out failed',
    });
  });
  // Notify is best-effort, not a publish stage that can fail the post:
  // notifyFeedListeners guards each listener, so one throwing subscriber
  // no longer fails a post that is already saved in the feed.
  notifyFeedListeners();
  return toHex(event.id);
}
