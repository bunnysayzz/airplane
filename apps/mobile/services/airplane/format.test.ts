import { formatCompact } from '../../src/lib/format';

describe('formatCompact', () => {
    it.each([
        [0, '0'],
        [7, '7'],
        [999, '999'],
        [1000, '1k'],
        [1200, '1.2k'],
        [1550, '1.6k'],
        [10000, '10k'],
        [1234567, '1.2M'],
        [3400000, '3.4M'],
        [2000000000, '2B'],
    ])('formats %i as %s', (value, expected) => {
        expect(formatCompact(value)).toBe(expected);
    });
});
