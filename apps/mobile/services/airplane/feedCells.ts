// SPDX-License-Identifier: Apache-2.0
// Feed scope resolution: which geohash-5 cells the viewer's feed covers.
//
// Blueprint rule: a node shows events whose cell is its own or one of the 8
// neighbours. The feed tab resolves the viewer's cell and expands it via
// neighbors(); Timeline then shows exactly those cells' posts.
//
// This NEVER prompts the OS permission dialog: permission is checked first,
// and a non-granted state resolves to no cells. Location is only ever read
// after the user already granted it (typically during posting).
//
// Return contract (the feed tab relies on it):
// - string[] : resolved scope. [] means "no scope" (permission not granted);
//   the tab passes it through, so the feed is empty — the same as before
//   this wiring, and posting requires location anyway.
// - null : resolution failed (GPS timeout, missing module, ...). The tab
//   KEEPS its previous cells instead of flashing the feed empty. The
//   failure is logged to Sentry (never post text, location, or secrets).

import { neighbors } from '@airplane/protocol';
import { captureError } from '../../src/sentry';
import { getLocationCell, getLocationPermissionStatus } from './location';

/** Feed-scope Sentry reports are throttled (audit F39): a persistent GPS
 *  failure must not spam one event per feed focus. */
const FEED_SCOPE_CAPTURE_THROTTLE_MS = 60_000;
let lastFeedScopeCaptureMs = 0;

/** Test seam: reset the capture throttle so tests are independent. */
export function __resetFeedCellsThrottleForTests(): void {
  lastFeedScopeCaptureMs = 0;
}

/** The viewer's in-scope cells, or null when resolution failed (keep previous). */
export async function resolveFeedCells(): Promise<string[] | null> {
  try {
    if ((await getLocationPermissionStatus()) !== 'granted') return [];
    return neighbors(await getLocationCell());
  } catch (error) {
    const nowMs = Date.now();
    if (nowMs - lastFeedScopeCaptureMs >= FEED_SCOPE_CAPTURE_THROTTLE_MS) {
      lastFeedScopeCaptureMs = nowMs;
      captureError(error);
    }
    return null;
  }
}
