// SPDX-License-Identifier: Apache-2.0
// Unit tests for the expo-location provider (LOC-1): fail-loud semantics,
// cache contract, and error mapping. expo-location is fully mocked; the
// geohash ENCODER is real.

import { encodeGeohash } from '@airplane/protocol';

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

import {
  ExpoLocationProvider,
  getLocationCell,
  setLocationProviderForTests,
  __resetLocationProviderForTests,
  LocationError,
  locationError,
  FIX_MAX_AGE_MS,
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

function fixAt(coords = BLR) {
  Location.getCurrentPositionAsync.mockResolvedValue({ coords });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetLocationProviderForTests();
});

describe('ExpoLocationProvider', () => {
  it('resolves the cell via the real encoder', async () => {
    grantPermission();
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider({ now: () => 1_000_000 });
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh cached fix without hitting GPS again', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getCurrentCell();
    now += FIX_MAX_AGE_MS - 1; // still within the documented window
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('never serves a fix past FIX_MAX_AGE_MS: it refetches', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getCurrentCell();
    now += FIX_MAX_AGE_MS + 1; // stale: must not be served silently
    await provider.getCurrentCell();
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('permission denied fails loud with a typed, user-presentable error', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const provider = new ExpoLocationProvider();
    const error = await provider.getCurrentCell().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocationError);
    expect((error as LocationError).code).toBe('permission-denied');
    expect((error as LocationError).userMessage).toMatch(/permission/i);
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('a revoked grant is honored before the cache: no stale cell on denial', async () => {
    grantPermission();
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider({ now: () => 1_000_000 });
    await provider.getCurrentCell(); // populates the cache
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await expect(provider.getCurrentCell()).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('prompts when the grant is undetermined, succeeds when the user allows', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider();
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('disabled location services fail loud (services-disabled)', async () => {
    grantPermission();
    Location.hasServicesEnabledAsync.mockResolvedValue(false);
    const provider = new ExpoLocationProvider();
    await expect(provider.getCurrentCell()).rejects.toMatchObject({
      code: 'services-disabled',
    });
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('GPS timeout fails loud (timeout)', async () => {
    grantPermission();
    enableServices();
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    const provider = new ExpoLocationProvider({ timeoutMs: 20 });
    await expect(provider.getCurrentCell()).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('non-finite coords fail loud (unavailable), never encoded', async () => {
    grantPermission();
    enableServices();
    fixAt({ latitude: NaN, longitude: 77.5946 });
    const provider = new ExpoLocationProvider();
    await expect(provider.getCurrentCell()).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('maps expo native errors onto typed codes', async () => {
    grantPermission();
    enableServices();
    Location.getCurrentPositionAsync.mockRejectedValue(
      new Error('E_LOCATION_TIMEOUT: timed out'),
    );
    await expect(new ExpoLocationProvider({ timeoutMs: 5_000 }).getCurrentCell()).rejects.toMatchObject({
      code: 'timeout',
    });
    Location.getCurrentPositionAsync.mockRejectedValue(
      new Error('E_LOCATION_UNAVAILABLE: no fix'),
    );
    await expect(new ExpoLocationProvider().getCurrentCell()).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('getLocationCell seam', () => {
  it('delegates to the injected provider', async () => {
    setLocationProviderForTests({ getCurrentCell: async () => 'tdr1v' });
    await expect(getLocationCell()).resolves.toBe('tdr1v');
  });

  it('locationError builds the typed error', () => {
    const error = locationError('timeout');
    expect(error).toBeInstanceOf(LocationError);
    expect(error.code).toBe('timeout');
    expect(error.message).toMatch(/location\/timeout/);
    expect(error.userMessage.length).toBeGreaterThan(0);
  });
});
