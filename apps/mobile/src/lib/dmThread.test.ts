// SPDX-License-Identifier: Apache-2.0
import { DM_NEAR_BOTTOM_THRESHOLD, isNearBottom } from './dmThread';

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
