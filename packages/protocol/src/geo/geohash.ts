// SPDX-License-Identifier: Apache-2.0
// Pure-TS geohash (standard algorithm). Precision 5 ≈ 4.9km × 4.9km cells.
// A node relays/shows events whose cell is its own or one of the 8 neighbors.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Encode lat/lon to a geohash of `precision` chars (default 5). */
export function encodeGeohash(lat: number, lon: number, precision: number = 5): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isLon = true;
  let bits = 0;
  let bitsCount = 0;
  let hash = '';
  while (hash.length < precision) {
    if (isLon) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        bits = (bits << 1) | 1;
        lonMin = mid;
      } else {
        bits = bits << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        latMin = mid;
      } else {
        bits = bits << 1;
        latMax = mid;
      }
    }
    isLon = !isLon;
    bitsCount++;
    if (bitsCount === 5) {
      hash += BASE32[bits];
      bits = 0;
      bitsCount = 0;
    }
  }
  return hash;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Decode a geohash to its cell center. */
export function decodeGeohash(hash: string): LatLon {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isLon = true;
  for (const ch of hash.toLowerCase()) {
    const code = BASE32.indexOf(ch);
    if (code < 0) throw new Error(`decodeGeohash: invalid char "${ch}"`);
    for (let mask = 16; mask > 0; mask >>= 1) {
      const bit = (code & mask) !== 0;
      if (isLon) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      isLon = !isLon;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

/** Cell dimensions (degrees) for a precision-5-style hash length. */
function cellSize(precision: number): { latH: number; lonW: number } {
  const totalBits = precision * 5;
  const lonBits = Math.ceil(totalBits / 2);
  const latBits = Math.floor(totalBits / 2);
  return { latH: 180 / 2 ** latBits, lonW: 360 / 2 ** lonBits };
}

/**
 * The cell plus its 8 neighbors (9 cells). Cells outside the valid
 * lat/lon range (poles, antimeridian wrap) are skipped.
 */
export function neighbors(cell: string): string[] {
  const { lat, lon } = decodeGeohash(cell);
  const { latH, lonW } = cellSize(cell.length);
  const out = new Set<string>();
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      const nLat = lat + dLat * latH;
      const nLon = lon + dLon * lonW;
      if (nLat < -90 || nLat > 90 || nLon < -180 || nLon > 180) continue;
      out.add(encodeGeohash(nLat, nLon, cell.length));
    }
  }
  return [...out];
}

/** The 9 cells in scope for a viewer standing in `centerCell` (precision 5). */
export function cellsInScope(centerCell: string): string[] {
  return neighbors(centerCell);
}

/** True when an event's cell is the viewer's cell or an adjacent one. */
export function isInScope(eventGeohash: string, viewerCell: string): boolean {
  return cellsInScope(viewerCell).includes(eventGeohash);
}
