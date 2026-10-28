// SPDX-License-Identifier: Apache-2.0
import { DM_NEAR_BOTTOM_THRESHOLD, dmBubblePropsEqual, isNearBottom } from './dmThread';

describe('isNearBottom', () => {
    it('is true exactly at the bottom', () => {
        expect(isNearBottom({ contentHeight: 1000, offsetY: 500, viewportHeight: 500 })).toBe(true);
    });

    it('is true within the threshold above the bottom', () => {
        expect(isNearBottom({ contentHeight: 1000, offsetY: 500 - (DM_NEAR_BOTTOM_THRESHOLD - 1), viewportHeight: 500 })).toBe(true);
    });

    it('is false at exactly the threshold distance', () => {
        expect(isNearBottom({ contentHeight: 1000, offsetY: 500 - DM_NEAR_BOTTOM_THRESHOLD, viewportHeight: 500 })).toBe(false);
    });

    it('is false when scrolled far up', () => {
        expect(isNearBottom({ contentHeight: 2000, offsetY: 0, viewportHeight: 500 })).toBe(false);
    });

    it('is true for an empty list and for content shorter than the viewport', () => {
        expect(isNearBottom({ contentHeight: 0, offsetY: 0, viewportHeight: 500 })).toBe(true);
        expect(isNearBottom({ contentHeight: 300, offsetY: 0, viewportHeight: 500 })).toBe(true);
    });

    it('honors an explicit threshold', () => {
        expect(isNearBottom({ contentHeight: 1000, offsetY: 400, viewportHeight: 500, threshold: 200 })).toBe(true);
        expect(isNearBottom({ contentHeight: 1000, offsetY: 400, viewportHeight: 500, threshold: 50 })).toBe(false);
    });
});

describe('dmBubblePropsEqual', () => {
    const retry = () => {};
    const base = { item: { id: 'm1', direction: 'out' as const, text: 'hi', status: 'Sent' }, onRetry: retry };

    it('is true for identical content in rebuilt row objects', () => {
        const rebuilt = { item: { ...base.item }, onRetry: retry };
        expect(dmBubblePropsEqual(base, rebuilt)).toBe(true);
    });

    it('is true when only the unrendered createdAtMs differs', () => {
        const withTimestamp = { item: { ...base.item, createdAtMs: 123 }, onRetry: retry };
        expect(dmBubblePropsEqual(base, withTimestamp)).toBe(true);
    });

    it('is false when id, direction, text, or status changes', () => {
        expect(dmBubblePropsEqual(base, { item: { ...base.item, id: 'm2' }, onRetry: retry })).toBe(false);
        expect(dmBubblePropsEqual(base, { item: { ...base.item, direction: 'in' as const }, onRetry: retry })).toBe(false);
        expect(dmBubblePropsEqual(base, { item: { ...base.item, text: 'bye' }, onRetry: retry })).toBe(false);
        expect(dmBubblePropsEqual(base, { item: { ...base.item, text: null }, onRetry: retry })).toBe(false);
        expect(dmBubblePropsEqual(base, { item: { ...base.item, status: 'Failed' }, onRetry: retry })).toBe(false);
    });

    it('is false when the retry callback identity changes', () => {
        expect(dmBubblePropsEqual(base, { item: { ...base.item }, onRetry: () => {} })).toBe(false);
    });
});
