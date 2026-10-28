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

/** Minimal bubble content: exactly the fields a DM bubble renders. */
export interface DmBubbleItem {
    id: string;
    direction: 'out' | 'in';
    text: string | null;
    status: string;
}

export interface DmBubblePropsLike {
    item: DmBubbleItem;
    onRetry: (messageId: string) => void;
}

/**
 * Memo comparison for the DM bubble (audit F5): a bubble re-renders only
 * when its own rendered content changes. createdAtMs is deliberately
 * excluded: it is never rendered, so a refresh that rebuilds row objects
 * with identical content must not re-render bubbles. The parent must still
 * pass a stable onRetry (useCallback) for the comparison to hold.
 */
export function dmBubblePropsEqual(prev: DmBubblePropsLike, next: DmBubblePropsLike): boolean {
    return (
        prev.item.id === next.item.id &&
        prev.item.direction === next.item.direction &&
        prev.item.text === next.item.text &&
        prev.item.status === next.item.status &&
        prev.onRetry === next.onRetry
    );
}
