// SPDX-License-Identifier: Apache-2.0
// Tests for the publish-path fix set: warm-up outcome lines, background
// revalidation, the last-known fast path and fallback, the last-known
// post tag and card flag, and the failure-code mapping. expo-location
// is fully mocked; the geohash encoder is real. No test here asserts on
// coordinates or cells appearing in a log line: the point of the branch
// is that outcome lines carry outcome names only.

jest.mock('expo-location', () => ({
  LocationAccuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Location = require('expo-location') as {
  getForegroundPermissionsAsync: jest.Mock;
  requestForegroundPermissionsAsync: jest.Mock;
  hasServicesEnabledAsync: jest.Mock;
  getCurrentPositionAsync: jest.Mock;
  getLastKnownPositionAsync: jest.Mock;
  watchPositionAsync: jest.Mock;
};

import { encodeGeohash, type EventKind, type SignedEvent } from '@airplane/protocol';
import {
  ExpoLocationProvider,
  getLocatedCell,
  warmLocationCell,
  __resetLocationProviderForTests,
  locationError,
  failureCodeForPublishError,
  locationSourceFromTags,
  REVALIDATE_AFTER_MS,
  FIX_MAX_AGE_MS,
} from './location';
import { setDiagnosticsLogSink, recordUiEvent } from './diagnostics';
import { tagsForPublish } from './composer';
import { toPostCardModel } from './feed';

const BLR = { latitude: 12.9716, longitude: 77.5946 };
const BLR_CELL = encodeGeohash(BLR.latitude, BLR.longitude, 5);
const DELHI = { latitude: 28.6139, longitude: 77.209 };
const DELHI_CELL = encodeGeohash(DELHI.latitude, DELHI.longitude, 5);
const OLD = { latitude: 12.9, longitude: 77.5 };
const OLD_CELL = encodeGeohash(OLD.latitude, OLD.longitude, 5);

function grantPermission() {
  Location.getForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  Location.requestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
}

function enableServices() {
  Location.hasServicesEnabledAsync.mockResolvedValue(true);
}

function noLastKnown() {
  Location.getLastKnownPositionAsync.mockResolvedValue(null);
}

function lastKnownAt(coords: typeof BLR, timestamp: number) {
  Location.getLastKnownPositionAsync.mockResolvedValue({
    coords,
    timestamp,
  });
}

const lines: string[] = [];

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

function locationLines() {
  return lines.filter((line) => line.startsWith('location '));
}

describe('warm-up outcome lines', () => {
  it('logs started then fresh-ok on a cold warm-up', async () => {
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    await warmLocationCell();
    expect(locationLines()).toEqual([
      'location warmup started',
      'location warmup fresh-ok',
    ]);
  });

  it('logs served-cached on a warm cache without a second fix call', async () => {
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    await warmLocationCell();
    lines.length = 0;
    await warmLocationCell();
    expect(locationLines()).toEqual([
      'location warmup started',
      'location warmup served-cached',
    ]);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('logs fresh-ok after the cache expires', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    await warmLocationCell();
    await jest.advanceTimersByTimeAsync(FIX_MAX_AGE_MS + 1000);
    lines.length = 0;
    await warmLocationCell();
    expect(locationLines()).toEqual([
      'location warmup started',
      'location warmup fresh-ok',
    ]);
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('logs fresh-failed when the provider hangs and nothing else exists', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    const warm = warmLocationCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await warm;
    expect(locationLines()).toEqual([
      'location warmup started',
      'location watch started',
      'location watch failed',
      'location warmup fresh-failed',
    ]);
  });

  it('logs no-coordinates when the fix carries no usable coords', async () => {
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: NaN, longitude: 77.5946 },
    });
    await warmLocationCell();
    expect(locationLines()).toEqual([
      'location warmup started',
      'location watch started',
      'location watch failed',
      'location warmup no-coordinates',
    ]);
  });

  it('logs last-known when a hung provider falls back to an old fix', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    lastKnownAt(OLD, Date.now() - 3600_000);
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    const warm = warmLocationCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await warm;
    // The provider logs the fallback itself, then warm-up logs its own
    // outcome: two lines for one fallback, at two different layers.
    // The failed watch attempt logs between them.
    expect(locationLines()).toEqual([
      'location warmup started',
      'location watch started',
      'location watch failed',
      'location fresh last-known',
      'location warmup last-known',
    ]);
  });
});

describe('background revalidation', () => {
  it('serves the cached cell at once past the threshold and refreshes it behind', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getLocatedCell();
    now += REVALIDATE_AFTER_MS + 1000;
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: DELHI });
    const hit = await provider.getLocatedCell();
    expect(hit).toEqual({ cell: BLR_CELL, source: 'cached' });
    // A second hit while the refresh is in flight must not start another.
    await provider.getLocatedCell();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
    expect(locationLines()).toContain('location revalidate started');
    expect(locationLines()).toContain('location revalidate ok');
    // Past the original expiry the refreshed cache serves, no third call.
    now += FIX_MAX_AGE_MS + 1000 - (REVALIDATE_AFTER_MS + 1000);
    await expect(provider.getLocatedCell()).resolves.toEqual({
      cell: DELHI_CELL,
      source: 'cached',
    });
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('a failed refresh logs failed and leaves the cached cell alone', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getLocatedCell();
    now += REVALIDATE_AFTER_MS + 1000;
    Location.getCurrentPositionAsync.mockRejectedValue(new Error('no fix'));
    await provider.getLocatedCell();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(locationLines()).toContain('location revalidate failed');
    await expect(provider.getLocatedCell()).resolves.toEqual({
      cell: BLR_CELL,
      source: 'cached',
    });
  });
});

describe('last-known fast path and fallback', () => {
  it('uses a recent OS last known fix without calling the live provider', async () => {
    grantPermission();
    enableServices();
    lastKnownAt(BLR, Date.now());
    const provider = new ExpoLocationProvider({ now: () => Date.now() });
    await expect(provider.getLocatedCell()).resolves.toEqual({
      cell: BLR_CELL,
      source: 'fresh',
    });
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('a hanging provider plus an old last known fix resolves marked last-known', async () => {
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
    await expect(first).resolves.toEqual({
      cell: OLD_CELL,
      source: 'last-known',
    });
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    // The fallback cell is never written back as fresh: the next call
    // runs the fresh path again instead of serving it from cache.
    const second = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(second).resolves.toEqual({
      cell: OLD_CELL,
      source: 'last-known',
    });
    expect(Location.getCurrentPositionAsync).toHaveBeenCalledTimes(2);
  });

  it('an expired app cache is the last fallback when the OS has nothing', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getLocatedCell();
    now += FIX_MAX_AGE_MS + 1000;
    Location.getCurrentPositionAsync.mockRejectedValue(
      new Error('E_LOCATION_TIMEOUT: timed out'),
    );
    await expect(provider.getLocatedCell()).resolves.toEqual({
      cell: BLR_CELL,
      source: 'last-known',
    });
    expect(locationLines()).toContain('location fresh last-known');
  });

  it('with neither last known nor cache, the original timeout still fails loud', async () => {
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockRejectedValue(
      new Error('E_LOCATION_TIMEOUT: timed out'),
    );
    await expect(
      new ExpoLocationProvider().getLocatedCell(),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('fallback never masks disabled services, even with an expired cache', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getLocatedCell();
    now += FIX_MAX_AGE_MS + 1000;
    Location.hasServicesEnabledAsync.mockResolvedValue(false);
    await expect(provider.getLocatedCell()).rejects.toMatchObject({
      code: 'services-disabled',
    });
  });

  it('fallback never masks a denied grant, even with an expired cache', async () => {
    let now = 1_000_000;
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: BLR });
    const provider = new ExpoLocationProvider({ now: () => now });
    await provider.getLocatedCell();
    now += FIX_MAX_AGE_MS + 1000;
    Location.getForegroundPermissionsAsync.mockResolvedValue({
      status: 'denied',
    });
    Location.requestForegroundPermissionsAsync.mockResolvedValue({
      status: 'denied',
    });
    await expect(provider.getLocatedCell()).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('last-known tag and card flag', () => {
  it('tagsForPublish marks only last-known posts', () => {
    expect(tagsForPublish({ locationSource: 'last-known' })).toEqual([
      ['location_source', 'last-known'],
    ]);
    expect(tagsForPublish({ locationSource: 'fresh' })).toEqual([]);
    expect(tagsForPublish({ locationSource: 'cached' })).toEqual([]);
    expect(tagsForPublish({})).toEqual([]);
  });

  it('locationSourceFromTags reads only the last-known tag', () => {
    expect(
      locationSourceFromTags([['location_source', 'last-known']]),
    ).toBe('last-known');
    expect(locationSourceFromTags([['display_name', 'tuba']])).toBeNull();
    expect(locationSourceFromTags([['location_source', 'fresh']])).toBeNull();
    expect(locationSourceFromTags(null)).toBeNull();
  });

  it('toPostCardModel flags last-known posts and leaves the rest alone', () => {
    const event = (tags: string[][]): SignedEvent =>
      ({
        id: new Uint8Array(32).fill(7),
        pubkey: new Uint8Array(32).fill(9),
        created_at: 1750000000,
        kind: 1 as EventKind,
        geohash: 'tdr1v',
        tags,
        content: 'mesh post',
        sig: new Uint8Array(64),
      }) as SignedEvent;
    const stale = toPostCardModel({
      event: event([['location_source', 'last-known']]),
      views: 3,
      score: 0.5,
      ageHours: 1,
    });
    expect(stale.locationStale).toBe(true);
    const fresh = toPostCardModel({
      event: event([]),
      views: 3,
      score: 0.5,
      ageHours: 1,
    });
    expect(fresh.locationStale).toBe(false);
  });
});

describe('failure codes and log privacy', () => {
  it('maps publish failures onto log-safe codes', () => {
    expect(failureCodeForPublishError(locationError('timeout'))).toBe(
      'timeout',
    );
    expect(failureCodeForPublishError(locationError('permission-denied'))).toBe(
      'permission-denied',
    );
    expect(failureCodeForPublishError(locationError('services-disabled'))).toBe(
      'services-disabled',
    );
    expect(failureCodeForPublishError(locationError('unavailable'))).toBe(
      'unavailable',
    );
    expect(failureCodeForPublishError(new Error('boom'))).toBe('failed');
  });

  it('compose failed actions pass the UI action filter', () => {
    recordUiEvent('compose:failed:timeout');
    recordUiEvent('compose:failed:permission-denied');
    recordUiEvent('compose:failed:services-disabled');
    recordUiEvent('compose:failed:unavailable');
    recordUiEvent('compose:failed:failed');
    recordUiEvent('compose:declined');
    expect(lines).toEqual([
      'ui tap compose:failed:timeout',
      'ui tap compose:failed:permission-denied',
      'ui tap compose:failed:services-disabled',
      'ui tap compose:failed:unavailable',
      'ui tap compose:failed:failed',
      'ui tap compose:declined',
    ]);
  });

  it('no location line ever carries coordinates, cells, or content', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    lastKnownAt(OLD, Date.now() - 3600_000);
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    const warm = warmLocationCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await warm;
    const located = getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(located).resolves.toEqual({
      cell: OLD_CELL,
      source: 'last-known',
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('12.9716');
    expect(joined).not.toContain('77.5946');
    expect(joined).not.toContain('12.9');
    expect(joined).not.toContain(BLR_CELL);
    expect(joined).not.toContain(OLD_CELL);
    for (const line of locationLines()) {
      expect(line).toMatch(
        /^location (warmup (started|served-cached|fresh-ok|fresh-failed|last-known|no-coordinates|skipped (denied|undetermined))|fresh last-known|watch (started|fresh-ok|failed)|revalidate (started|ok|failed)|provider stale|(setup|compose) permission (granted|denied|undetermined))$/,
      );
    }
  });
});

describe('watch second chance', () => {
  function watchDelivers(coords: typeof BLR) {
    Location.watchPositionAsync.mockImplementation(
      (_opts: unknown, cb: (pos: { coords: typeof BLR }) => void) => {
        cb({ coords });
        return Promise.resolve({ remove: jest.fn() });
      },
    );
  }

  function watchNeverDelivers() {
    Location.watchPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
  }

  it('delivers a fresh fix when the one-shot hangs', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    watchDelivers(BLR);
    const provider = new ExpoLocationProvider({ now: () => Date.now() });
    const located = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(located).resolves.toEqual({ cell: BLR_CELL, source: 'fresh' });
    expect(locationLines()).toContain('location watch started');
    expect(locationLines()).toContain('location watch fresh-ok');
    expect(locationLines()).not.toContain('location fresh last-known');
  });

  it('falls back to last-known when the watch also delivers nothing', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    lastKnownAt(OLD, Date.now() - 3600_000);
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    watchNeverDelivers();
    const provider = new ExpoLocationProvider({ now: () => Date.now() });
    const located = provider.getLocatedCell();
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(located).resolves.toEqual({ cell: OLD_CELL, source: 'last-known' });
    expect(locationLines()).toContain('location watch started');
    expect(locationLines()).toContain('location watch failed');
    expect(locationLines()).toContain('location fresh last-known');
  });

  it('fails loud when one-shot, watch, and fallback all come up empty', async () => {
    jest.useFakeTimers();
    grantPermission();
    enableServices();
    noLastKnown();
    Location.getCurrentPositionAsync.mockImplementation(
      () => new Promise(() => {}),
    );
    watchNeverDelivers();
    const provider = new ExpoLocationProvider({ now: () => Date.now() });
    const located = provider.getLocatedCell();
    // Attach the rejection handler before advancing timers: the
    // rejection lands while timers run, and an unhandled rejection in
    // that window fails the test even though the assertion follows.
    const assertion = expect(located).rejects.toMatchObject({ code: 'timeout' });
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(locationLines()).toContain('location watch failed');
  });
});
