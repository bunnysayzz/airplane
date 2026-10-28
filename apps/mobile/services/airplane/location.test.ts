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
  getLocationPermissionStatus,
  requestLocationPermission,
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

  it('concurrent resolutions share one in-flight GPS fix', async () => {
    grantPermission();
    enableServices();
    let resolveFix!: (value: { coords: typeof BLR }) => void;
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise((resolve) => {
        resolveFix = resolve;
      }),
    );
    const provider = new ExpoLocationProvider({ now: () => 1_000_000 });
    const a = provider.getCurrentCell();
    const b = provider.getCurrentCell();
    // Both callers are waiting on the same fix; only one GPS call ran.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    resolveFix({ coords: BLR });
    await expect(a).resolves.toBe(BLR_CELL);
    await expect(b).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh cached fix without hitting GPS again', async () => {    let now = 1_000_000;
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

  it('disabled services fail loud even with a warm cache (T10 hardening)', async () => {
    // The services probe runs before the cache: switching services off
    // must surface services-disabled, never silently post a stale cell.
    const now = 1_000_000;
    grantPermission();
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider({ now: () => now });
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    Location.hasServicesEnabledAsync.mockResolvedValue(false);
    await expect(provider.getCurrentCell()).rejects.toMatchObject({
      code: 'services-disabled',
    });
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    // Services back on: the warm cache serves again without a new fix.
    enableServices();
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('a failing services probe falls through to the warm cache', async () => {
    // Non-Android / unexpected probe failure must not break posting when
    // a fresh cached cell exists; the probe failure is not a LocationError.
    const now = 1_000_000;
    grantPermission();
    enableServices();
    fixAt();
    const provider = new ExpoLocationProvider({ now: () => now });
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    Location.hasServicesEnabledAsync.mockRejectedValue(new Error('not implemented'));
    await expect(provider.getCurrentCell()).resolves.toBe(BLR_CELL);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
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

  it('every failure code carries distinct actionable user copy (T10)', () => {
    // The composer shows userMessage for non-denied failures, so each path
    // must say something different and actionable — not one generic line.
    const copy = {
      'permission-denied': locationError('permission-denied').userMessage,
      'services-disabled': locationError('services-disabled').userMessage,
      timeout: locationError('timeout').userMessage,
      unavailable: locationError('unavailable').userMessage,
    };
    expect(new Set(Object.values(copy)).size).toBe(4);
    expect(copy['services-disabled']).toMatch(/services are off/i);
    expect(copy.timeout).toMatch(/in time|try again/i);
    expect(copy.unavailable).toMatch(/try again/i);
  });
});

// Permission priming seams: the composer reads the OS state without
// prompting, and fires the real OS request only on the user's action.
describe('permission priming', () => {
  it('getPermissionStatus maps OS states without prompting', async () => {
    const provider = new ExpoLocationProvider();
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await expect(provider.getPermissionStatus()).resolves.toBe('granted');
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await expect(provider.getPermissionStatus()).resolves.toBe('denied');
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    await expect(provider.getPermissionStatus()).resolves.toBe('undetermined');
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requestPermission fires the OS request once and returns the grant', async () => {
    const provider = new ExpoLocationProvider();
    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await expect(provider.requestPermission()).resolves.toBe(true);
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);

    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await expect(provider.requestPermission()).resolves.toBe(false);
  });

  it('module-level helpers share the default expo provider', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await expect(getLocationPermissionStatus()).resolves.toBe('denied');
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();

    Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
    await expect(requestLocationPermission()).resolves.toBe(true);
    expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});
