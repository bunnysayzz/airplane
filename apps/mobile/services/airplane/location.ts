// SPDX-License-Identifier: Apache-2.0
// Device location provider (LOC-1).
//
// Resolves the device's current position and returns the geohash-5 cell via
// the protocol encoder (packages/protocol/src/geo/geohash.ts).
//
// Fail-loud semantics (never weakened):
// - permission denied / location services off / GPS timeout / missing native
//   module -> a typed LocationError. Never a fake/default location: a
//   fabricated cell would poison feed scoping and erode trust in the mesh.
// - The last good fix is cached briefly (stale-while-revalidate): a geohash5
//   cell is ~4.9 km x 4.9 km, so a minutes-old fix is still the right cell.
//   A fix older than FIX_MAX_AGE_MS is NEVER served - past that age the call
//   blocks on a fresh fix (or throws timeout). The cache is consulted only
//   when foreground permission is still granted.

import { encodeGeohash } from '@airplane/protocol';
import type * as ExpoLocationTypes from 'expo-location';

/** Typed failure modes. `code` is stable for UI copy mapping. */
export type LocationFailureCode =
  | 'permission-denied'
  | 'services-disabled'
  | 'timeout'
  | 'unavailable';

/** A location failure with a user-presentable message. */
export class LocationError extends Error {
  readonly code: LocationFailureCode;
  /** Copy safe to show the user as-is. */
  readonly userMessage: string;

  constructor(code: LocationFailureCode, userMessage: string, detail?: string) {
    super(`location ${detail ?? 'failed'} (location/${code})`);
    this.name = 'LocationError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

const USER_COPY: Record<LocationFailureCode, string> = {
  'permission-denied':
    'Location permission is off. Allow approximate location to post.',
  'services-disabled': 'Location services are off. Turn them on to post.',
  timeout: "Couldn't get your location in time. Try again.",
  unavailable: "Location isn't available right now. Try again.",
};

export function locationError(code: LocationFailureCode, detail?: string): LocationError {
  return new LocationError(code, USER_COPY[code], detail);
}

/** The contract getLocationCell() publishes against. Tests inject fakes. */
export interface LocationProvider {
  getCurrentCell(): Promise<string>;
}

// --- expo-location provider ------------------------------------------------

// How long a GPS fix may take before we fail loud.
export const FIX_TIMEOUT_MS = 15_000;
// How old a cached fix may be before it is never served again. A geohash5
// cell spans ~4.9 km; a fix within this window is still the right cell for
// scoping, so reusing it keeps posting fast and battery-cheap.
export const FIX_MAX_AGE_MS = 5 * 60_000;

interface ExpoProviderOpts {
  timeoutMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Default provider backed by expo-location. The module is lazily required
 * (never at startup): location is only needed on the publish path, so a
 * missing native module must fail the post, never the app launch. This also
 * keeps expo-location out of the startup native-module guard's import graph,
 * matching how expo-secure-store / NetInfo are treated.
 */
/** The OS foreground-location permission state, read without prompting. */
export type LocationPermissionState = 'granted' | 'denied' | 'undetermined';

export class ExpoLocationProvider implements LocationProvider {
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private cached: { cell: string; atMs: number } | null = null;

  constructor(opts: ExpoProviderOpts = {}) {
    this.timeoutMs = opts.timeoutMs ?? FIX_TIMEOUT_MS;
    this.maxAgeMs = opts.maxAgeMs ?? FIX_MAX_AGE_MS;
    this.now = opts.now ?? Date.now;
  }

  private loadLocation(): typeof ExpoLocationTypes {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('expo-location') as typeof ExpoLocationTypes;
    } catch {
      // Native module not linked (should be impossible: expo-location is a
      // direct dep and autolinked at Gradle time). Fail loud, never fake.
      throw locationError('unavailable', 'expo-location native module missing');
    }
  }

  private async ensurePermission(
    Location: typeof ExpoLocationTypes,
  ): Promise<void> {
    let status = (await Location.getForegroundPermissionsAsync()).status;
    if (status !== 'granted') {
      status = (await Location.requestForegroundPermissionsAsync()).status;
    }
    if (status !== 'granted') {
      throw locationError('permission-denied', `status=${status}`);
    }
  }

  /**
   * The foreground-location permission state WITHOUT prompting the OS.
   * The UI layer uses this for permission priming: it shows the app's own
   * rationale first and fires the real OS dialog only on the user's action
   * (via requestPermission()). `ensurePermission()` above stays the
   * fail-loud backstop on the publish path.
   */
  async getPermissionStatus(): Promise<LocationPermissionState> {
    const Location = this.loadLocation();
    const status = (await Location.getForegroundPermissionsAsync()).status;
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  }

  /**
   * Fire the one real OS permission request. Call only from a user action
   * (e.g. after the user accepts the in-app pre-prompt). Returns true when
   * the grant came through.
   */
  async requestPermission(): Promise<boolean> {
    const Location = this.loadLocation();
    return (await Location.requestForegroundPermissionsAsync()).status === 'granted';
  }

  private async freshFix(
    Location: typeof ExpoLocationTypes,
  ): Promise<{ latitude: number; longitude: number }> {
    const position = await withTimeout(
      Location.getCurrentPositionAsync({
        // Balanced (~100 m) is plenty for a 4.9 km cell and battery-cheap.
        // The manifest declares only ACCESS_COARSE_LOCATION, so the OS clamps
        // to approximate regardless of the requested accuracy.
        accuracy: Location.LocationAccuracy.Balanced,
      }),
      this.timeoutMs,
      () => locationError('timeout', `no fix within ${this.timeoutMs}ms`),
    );
    const { latitude, longitude } = position.coords;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw locationError('unavailable', 'non-finite/out-of-range coords');
    }
    return { latitude, longitude };
  }

  async getCurrentCell(): Promise<string> {
    const Location = this.loadLocation();

    // Permission is re-checked on EVERY call, before the cache is consulted:
    // a revoked grant must never serve even a fresh cached cell.
    await this.ensurePermission(Location);

    const cached = this.cached;
    if (cached && this.now() - cached.atMs <= this.maxAgeMs) {
      return cached.cell;
    }

    // hasServicesEnabledAsync is Android-only; on other platforms the OS
    // surfaces the failure through getCurrentPositionAsync instead.
    try {
      if (
        typeof Location.hasServicesEnabledAsync === 'function' &&
        !(await Location.hasServicesEnabledAsync())
      ) {
        throw locationError('services-disabled');
      }
    } catch (error) {
      if (error instanceof LocationError) throw error;
      // Non-Android / unexpected probe failure: fall through to the fix
      // attempt, which reports the real state.
    }

    let coords: { latitude: number; longitude: number };
    try {
      coords = await this.freshFix(Location);
    } catch (error) {
      if (error instanceof LocationError) throw error;
      throw mapExpoError(error);
    }

    const cell = encodeGeohash(coords.latitude, coords.longitude, 5);
    this.cached = { cell, atMs: this.now() };
    return cell;
  }
}

/** Map expo-location's native error shapes onto our typed codes. */
function mapExpoError(error: unknown): LocationError {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return locationError('timeout', message);
  if (/settings|disabled|denied/i.test(message)) {
    return /denied/i.test(message)
      ? locationError('permission-denied', message)
      : locationError('services-disabled', message);
  }
  return locationError('unavailable', message);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// --- provider seam ---------------------------------------------------------

let defaultProvider: LocationProvider | null = null;
let defaultExpoProvider: ExpoLocationProvider | null = null;
let providerOverride: LocationProvider | null = null;

/** Tests (and dev tooling) inject a fake provider here. */
export function setLocationProviderForTests(
  provider: LocationProvider | null,
): void {
  providerOverride = provider;
}

export function __resetLocationProviderForTests(): void {
  providerOverride = null;
  defaultProvider = null;
  defaultExpoProvider = null;
}

/**
 * The OS foreground-location state, read without prompting. UI-only seam for
 * permission priming; the publish path still goes through getLocationCell()
 * (whose ensurePermission() stays the fail-loud backstop).
 */
export function getLocationPermissionStatus(): Promise<LocationPermissionState> {
  const provider =
    defaultExpoProvider ?? (defaultExpoProvider = new ExpoLocationProvider());
  return provider.getPermissionStatus();
}

/**
 * Fire the real OS permission request. Call ONLY from a user action — the
 * composer asks this after the user accepts the in-app pre-prompt.
 */
export function requestLocationPermission(): Promise<boolean> {
  const provider =
    defaultExpoProvider ?? (defaultExpoProvider = new ExpoLocationProvider());
  return provider.requestPermission();
}

/**
 * The device's current geohash-5 cell. Async: resolving a fix may prompt for
 * permission and wait on GPS. Fails loud with LocationError on any failure -
 * callers must surface the copy and keep the explicit-geohash5 override for
 * tests/dev.
 */
export async function getLocationCell(): Promise<string> {
  const provider =
    providerOverride ?? (defaultProvider ??= new ExpoLocationProvider());
  return provider.getCurrentCell();
}
