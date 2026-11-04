// SPDX-License-Identifier: Apache-2.0
// Unit tests for gaps 101 to 104: the visible warmup skip line, the
// foreground warmup retry trigger, the provider-stale marker, and the
// setup versus first-compose permission status lines. expo-location is
// fully mocked; the geohash encoder is real. No test here asserts on
// coordinates or cells appearing in a log line.

jest.mock('expo-location', () => ({
  LocationAccuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Location = require('expo-location') as {
  getForegroundPermissionsAsync: jest.Mock;
  requestForegroundPermissionsAsync: jest.Mock;
  hasServicesEnabledAsync: jest.Mock;
  getCurrentPositionAsync: jest.Mock;
  getLastKnownPositionAsync: jest.Mock;
};

import {
  ExpoLocationProvider,
  FIX_MAX_AGE_MS,
  logFirstComposePermissionStatus,
  logSetupPermissionStatus,
  subscribeComposeWarmupOnForeground,
  warmLocationCell,
  __resetLocationProviderForTests,
} from './location';
import { setDiagnosticsLogSink } from './diagnostics';

const BLR = { latitude: 12.9716, longitude: 77.5946 };
const OLD = { latitude: 12.9, longitude: 77.5 };

function grantPermission() {
  Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
}

function enableServices() {
  Location.hasServicesEnabledAsync.mockResolvedValue(true);
}

function lastKnownAt(coords: typeof BLR, timestamp: number) {
  Location.getLastKnownPositionAsync.mockResolvedValue({
    coords,
    timestamp,
  });
}

const lines: string[] = [];

function locationLines() {
  return lines.filter((line) => line.startsWith('location '));
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetLocationProviderForTests();
  lines.length = 0;
  setDiagnosticsLogSink((kind, detail) => {
    lines.push(`${kind} ${detail}`);
  });
});

afterEach(() => {
  __resetLocationProviderForTests();
  setDiagnosticsLogSink(null);
  jest.useRealTimers();
});

describe('gap 103: warmup skip is visible', () => {
  it('logs a distinct skip line for a denied grant and never prompts', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await warmLocationCell();
    expect(locationLines()).toEqual(['location warmup skipped denied']);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('logs a distinct skip line for an undetermined grant', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    await warmLocationCell();
    expect(locationLines()).toEqual(['location warmup skipped undetermined']);
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('gap 103: foreground warmup retry while compose is open', () => {
  it('re-attempts warmup when the app returns to foreground', async () => {
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const listeners = new Set<(state: string) => void>();
    const fakeAppState = {
      addEventListener: (_type: 'change', cb: (state: string) => void) => {
        listeners.add(cb);
        return {
          remove: () => {
            listeners.delete(cb);
          },
        };
      },
    };
    const unsubscribe = subscribeComposeWarmupOnForeground(fakeAppState);
    // A background return while still denied still only logs the skip.
    for (const cb of [...listeners]) cb('background');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locationLines()).toEqual([]);
    // Grant, then return to foreground: a fresh warmup attempt runs.
    grantPermission();
    enableServices();
    Location.getLastKnownPositionAsync.mockResolvedValue(null);
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    for (const cb of [...listeners]) cb('active');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locationLines()).toEqual([
      'location warmup started',
      'location warmup fresh-ok',
    ]);
    // After unsubscribe, a foreground return warms nothing more.
    unsubscribe();
    lines.length = 0;
    for (const cb of [...listeners]) cb('active');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locationLines()).toEqual([]);
  });
});

describe('gaps 101/102: provider-stale marker', () => {
  it('emits one provider-stale line on the second consecutive last-known resolution with no fresh fix', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    lastKnownAt(OLD, Date.now() - 3600_000);
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    const provider = new ExpoLocationProvider({ now: () => Date.now() });
    const first = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toMatchObject({ source: 'last-known' });
    expect(locationLines()).not.toContain('location provider stale');
    const second = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(second).resolves.toMatchObject({ source: 'last-known' });
    expect(locationLines()).toContain('location provider stale');
    expect(locationLines().filter((line) => line === 'location provider stale')).toHaveLength(1);
    // A third consecutive last-known resolution does not repeat it.
    const third = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(third).resolves.toMatchObject({ source: 'last-known' });
    expect(locationLines().filter((line) => line === 'location provider stale')).toHaveLength(1);
  });

  it('emits no provider-stale line when a fresh fix lands between last-known resolutions', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    lastKnownAt(OLD, Date.now() - 3600_000);
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    const provider = new ExpoLocationProvider({ now: () => Date.now() });
    const first = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toMatchObject({ source: 'last-known' });
    // A recent OS last known fix counts as fresh and resets the streak.
    lastKnownAt(BLR, Date.now());
    await expect(provider.getLocatedCell()).resolves.toMatchObject({ source: 'fresh' });
    // The fresh fix warmed the cache, so expire it before the next
    // call, or the next call would serve cached instead of running
    // the fresh path that the streak counts.
    await jest.advanceTimersByTimeAsync(FIX_MAX_AGE_MS + 1000);
    lastKnownAt(OLD, Date.now() - 3600_000);
    const third = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(third).resolves.toMatchObject({ source: 'last-known' });
    expect(locationLines()).not.toContain('location provider stale');
  });
});

describe('gap 104: permission status at setup and first compose open', () => {
  it('logs the setup status on every setup completion and the compose status only on the first open', async () => {
    grantPermission();
    await logSetupPermissionStatus();
    await logSetupPermissionStatus();
    expect(locationLines()).toEqual([
      'location setup permission granted',
      'location setup permission granted',
    ]);
    Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await logFirstComposePermissionStatus();
    await logFirstComposePermissionStatus();
    expect(locationLines()).toEqual([
      'location setup permission granted',
      'location setup permission granted',
      'location compose permission denied',
    ]);
  });
});
