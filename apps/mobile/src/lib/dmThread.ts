// SPDX-License-Identifier: Apache-2.0
// Pure list helpers for the DM thread (audit F4/F5). No React Native
// imports: these run in the node jest harness.

/** Distance in points from the bottom below which the list counts as "at the bottom". */
export const DM_NEAR_BOTTOM_THRESHOLD = 120;

export interface NearBottomInput {
    contentHeight: number;
    offsetY: number;
    viewportHeight: number;
    threshold?: number;
}

/**
 * True when the list is scrolled near enough to the bottom that
 * auto-scrolling to a new message will not yank the user away from history
 * they are reading. An empty or shorter-than-viewport list counts as at the
 * bottom (its distance is zero or negative).
 */
export function isNearBottom(input: NearBottomInput): boolean {
    const threshold = input.threshold ?? DM_NEAR_BOTTOM_THRESHOLD;
    return input.contentHeight - (input.offsetY + input.viewportHeight) < threshold;
}
