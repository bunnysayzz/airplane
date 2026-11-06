// SPDX-License-Identifier: Apache-2.0
import { dmRouteForPeer, isOwnHex } from './selfDm';

const OWN = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const OTHER = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('isOwnHex', () => {
  it('is true for the same hex in any case', () => {
    expect(isOwnHex(OWN, OWN)).toBe(true);
    expect(isOwnHex(OWN.toUpperCase(), OWN)).toBe(true);
    expect(isOwnHex(OWN, OWN.toUpperCase())).toBe(true);
  });

  it('is false for a different peer', () => {
    expect(isOwnHex(OTHER, OWN)).toBe(false);
  });

  it('is false when the own key is unknown', () => {
    expect(isOwnHex(OWN, null)).toBe(false);
    expect(isOwnHex(OWN, undefined)).toBe(false);
    expect(isOwnHex(OWN, '')).toBe(false);
  });

  it('is false for an empty candidate', () => {
    expect(isOwnHex('', OWN)).toBe(false);
    expect(isOwnHex(null, OWN)).toBe(false);
    expect(isOwnHex(undefined, OWN)).toBe(false);
  });
});

describe('dmRouteForPeer', () => {
  it('routes yourself to Saved, never to a DM thread', () => {
    expect(dmRouteForPeer(OWN, OWN)).toBe('/dm/self');
    expect(dmRouteForPeer(OWN.toUpperCase(), OWN)).toBe('/dm/self');
  });

  it('routes any other peer to their DM thread', () => {
    expect(dmRouteForPeer(OTHER, OWN)).toBe(`/dm/${OTHER}`);
    expect(dmRouteForPeer(OTHER.toUpperCase(), OWN)).toBe(`/dm/${OTHER}`);
  });

  it('routes to the DM thread when the own key is unknown', () => {
    expect(dmRouteForPeer(OTHER, null)).toBe(`/dm/${OTHER}`);
  });
});
