// SPDX-License-Identifier: Apache-2.0
import { isDoublePush, isWithinWindow } from './navGuard';

describe('isDoublePush', () => {
    test('no previous push never blocks', () => {
        expect(isDoublePush(null, 'abc', 10000)).toBe(false);
    });

    test('same id within the window blocks', () => {
        expect(isDoublePush({ eventId: 'abc', atMs: 10000 }, 'abc', 10500)).toBe(true);
    });

    test('same id after the window passes', () => {
        expect(isDoublePush({ eventId: 'abc', atMs: 10000 }, 'abc', 11000)).toBe(false);
    });

    test('different id within the window passes', () => {
        expect(isDoublePush({ eventId: 'abc', atMs: 10000 }, 'def', 10500)).toBe(false);
    });
});

describe('isWithinWindow', () => {
    test('recent action blocks', () => {
        expect(isWithinWindow(10000, 10400, 500)).toBe(true);
    });

    test('old action passes', () => {
        expect(isWithinWindow(10000, 11000, 500)).toBe(false);
    });

    test('never-acted (0) passes', () => {
        expect(isWithinWindow(0, 11000, 500)).toBe(false);
    });
});
