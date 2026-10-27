// SPDX-License-Identifier: Apache-2.0
import {
  cellsInScope,
  decodeGeohash,
  encodeGeohash,
  isInScope,
  neighbors,
} from './geohash';

describe('geohash', () => {
  test('encode(42.6, -5.6, 5) === "ezs42"', () => {
    expect(encodeGeohash(42.6, -5.6, 5)).toBe('ezs42');
  });

  test('decode inverts encode (center of cell)', () => {
    const { lat, lon } = decodeGeohash('ezs42');
    expect(lat).toBeCloseTo(42.6, 1);
    expect(lon).toBeCloseTo(-5.6, 1);
    // Re-encoding the center lands back in the same cell.
    expect(encodeGeohash(lat, lon, 5)).toBe('ezs42');
  });

  test('neighbors returns the cell plus 8 distinct neighbors', () => {
    const cells = neighbors('ezs42');
    expect(cells).toHaveLength(9);
    expect(new Set(cells).size).toBe(9);
    expect(cells).toContain('ezs42');
  });

  test('cellsInScope is the 3x3 block around the viewer', () => {
    expect(cellsInScope('ezs42')).toHaveLength(9);
  });

  test('isInScope: same cell and neighbors in scope, far cell out', () => {
    expect(isInScope('ezs42', 'ezs42')).toBe(true);
    const [neighbor] = neighbors('ezs42').filter((c) => c !== 'ezs42');
    expect(isInScope(neighbor, 'ezs42')).toBe(true);
    const sydney = encodeGeohash(-33.87, 151.21, 5);
    expect(isInScope(sydney, 'ezs42')).toBe(false);
  });

  test('precision parameter respected', () => {
    expect(encodeGeohash(42.6, -5.6, 1)).toHaveLength(1);
    expect(encodeGeohash(42.6, -5.6, 8)).toHaveLength(8);
    expect(encodeGeohash(42.6, -5.6, 8).startsWith('ezs42')).toBe(true);
  });
});
