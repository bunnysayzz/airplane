// SPDX-License-Identifier: Apache-2.0
// Unit tests for compose-open location warm-up: warming through the same
// default provider publishPost uses, so submit finds a warm cache or shares
// the in-flight fix. expo-location is fully mocked; the geohash ENCODER is
// real. Warm-up never throws and never prompts for permission itself.

jest.mock('expo-location', () => ({
  LocationAccuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Location = require('expo-location') as {
  getForegroundPermissionsAsync: jest.Mock;
  requestForegroundPermissionsAsync: jest.Mock;
  hasServicesEnabledAsync: jest.Mock;
  getCurrentPositionAsync: jest.Mock;
};

import { encodeGeohash } from '@airplane/protocol';
import {
  getLocationCell,
  warmLocationCell,
  setLocationProviderForTests,
  __resetLocationProviderForTests,
  locationError,
} from './location';

const BLR = { latitude: 12.9716, longitude: 77.5946 };
const BLR_CELL = encodeGeohash(BLR.latitude, BLR.longitude, 5);

function grantPermission() {
  Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
}

function enableServices() {
  Location.hasServicesEnabledAsync.mockResolvedValue(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetLocationProviderForTests();
});

afterEach(() => {
  __resetLocationProviderForTests();
});

describe('warmLocationCell', () => {
  it('warms the cache so a later submit uses the cached cell without a second fix call', async () => {
    grantPermission();
    enableServices();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    await warmLocationCell();
    await expect(getLocationCell()).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('open plus rapid submit shares one fix attempt', async () => {
    grantPermission();
    enableServices();
    let resolveFix!: (value: { coords: typeof BLR }) => void;
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise((resolve) => {
        resolveFix = resolve;
      }),
    );
    const warm = warmLocationCell();
    const submit = getLocationCell();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    resolveFix({ coords: BLR });
    await expect(warm).resolves.toBeUndefined();
    await expect(submit).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('never prompts for permission itself: skips warming when the grant is absent', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await warmLocationCell();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('never throws on warm-up failure; submit still fails loud with no fake cell', async () => {
    grantPermission();
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('timeout');
      },
    });
    await expect(warmLocationCell()).resolves.toBeUndefined();
    await expect(getLocationCell()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a failed warm-up leaves no stale rejection: submit retries cleanly', async () => {
    grantPermission();
    let calls = 0;
    setLocationProviderForTests({
      getCurrentCell: async () => {
        calls += 1;
        if (calls === 1) throw locationError('timeout');
        return 'tdr1v';
      },
    });
    await expect(warmLocationCell()).resolves.toBeUndefined();
    await expect(getLocationCell()).resolves.toBe('tdr1v');
    expect(calls).toBe(2);
  });
});
