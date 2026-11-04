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
// - The last good fix is cached briefly and refreshed in the background
//   (true stale-while-revalidate): a geohash5 cell is ~4.9 km x 4.9 km,
//   so a minutes-old fix is still the right cell. A cache hit past
//   REVALIDATE_AFTER_MS serves the cached cell at once and kicks a
//   background refresh; a fix older than FIX_MAX_AGE_MS is NEVER served
//   as fresh - past that age the call runs the fresh path below. The
//   cache is consulted only when foreground permission is still granted.
// - Last-known fallback, last resort only: after the fresh fix race fails
//   with timeout or unavailable (never for permission or services
//   failures), the call may serve a real previously observed position:
//   the OS last known fix, else the app's own expired cache cell. That
//   cell is NEVER written back into the fresh cache, and it is always
//   reported with source 'last-known' so the post carries an honest tag
//   (see LOCATION_SOURCE_TAG). Fail loud stays the default; the fallback
//   only rescues a post that would otherwise fail outright.

import { encodeGeohash } from '@airplane/protocol';
import type * as ExpoLocationTypes from 'expo-location';
import { recordLocationEvent, type LocationLogDetail } from './diagnostics';

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
// Past this age a cache hit still serves at once, but it also kicks a
// background refresh, so a session that keeps posting never walks into
// the expiry cliff unprepared: the next submit finds a fresh cache.
export const REVALIDATE_AFTER_MS = 3 * 60_000;
// The OS last known fix is a cached value, not a provider activation, so
// it answers fast or not at all; past this wait it is treated as absent.
export const LAST_KNOWN_TIMEOUT_MS = 5_000;
// Bounded second chance for a live fix (logging coverage fix): when the
// one-shot fix times out, one watch attempt runs for at most this long
// before the last-known fallback. The watch path is a different native
// call (location updates listener) from the one-shot call that hangs on
// some Android builds, so it can deliver where the one-shot never
// resolves. Same Balanced accuracy, same fail-loud contract: a watch
// that also fails falls through to the marked last-known fallback, and
// permission or services failures never reach this path at all.
export const WATCH_TIMEOUT_MS = 10_000;

/** Where a resolved cell came from. 'fresh' is a current fix (a live
 * provider fix, or an OS last known fix within the cache window, which
 * is equally current for a 4.9 km cell). 'cached' is the app's own
 * cache within the window. 'last-known' is the last resort fallback:
 * a real previously observed position served only after the fresh race
 * failed, and never written back into the fresh cache. */
export type LocationSource = 'fresh' | 'cached' | 'last-known';

/** A resolved cell plus its source, so callers can mark last-known posts. */
export interface LocatedCell {
  cell: string;
  source: LocationSource;
}

/** Signed post tag marking a post published from a last-known cell.
 * Readers ignore unknown tags safely, so older installs just never show
 * the marker; the tag is part of the signed pre-image like any other. */
export const LOCATION_SOURCE_TAG = 'location_source';

/** Read the location source back out of a post's tags, if it carries one. */
export function locationSourceFromTags(
  tags: string[][] | undefined | null,
): LocationSource | null {
  if (!tags) return null;
  for (const row of tags) {
    if (row[0] === LOCATION_SOURCE_TAG && row[1] === 'last-known') {
      return 'last-known';
    }
  }
  return null;
}

/** Map any publish failure onto the code the compose:failed log line
 * carries: the typed location code when it is one, else 'failed'. The
 * code is an outcome name only, never content or coordinates. */
export function failureCodeForPublishError(error: unknown): string {
  if (error instanceof LocationError) return error.code;
  return 'failed';
}

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
  /** In-flight fresh fix, shared by concurrent callers (audit F39). */
  private inflight: Promise<LocatedCell> | null = null;
  /** In-flight background refresh, deduped the same way. */
  private revalidating: Promise<void> | null = null;
  /**
   * Provider-stale tracker (gaps 101/102, observability only, not a
   * provider fix). Counts consecutive fresh-path resolutions that fell
   * back to last-known, with no fresh fix all session. A cached serve
   * is not a fresh-path resolution, so it neither counts nor resets.
   * On the second consecutive last-known resolution with no fresh fix
   * yet, one 'provider stale' line is emitted for the session: the
   * signal that the fresh provider is not delivering at all, as the
   * 2026-11-04 logs showed (12 fresh resolutions, all last-known).
   * This line never changes resolution behavior and never promises a
   * fix; the previously rejected provider approaches (library upgrade,
   * accuracy change, single-shot watch) stay rejected without new
   * evidence, which would be reported as a follow-up, not smuggled in.
   */
  private freshSeenInSession = false;
  private lastKnownStreak = 0;
  private providerStaleLogged = false;

  private noteFreshPathOutcome(source: 'fresh' | 'last-known'): void {
    if (source === 'fresh') {
      this.freshSeenInSession = true;
      this.lastKnownStreak = 0;
      return;
    }
    this.lastKnownStreak += 1;
    if (
      this.lastKnownStreak >= 2 &&
      !this.freshSeenInSession &&
      !this.providerStaleLogged
    ) {
      this.providerStaleLogged = true;
      recordLocationEvent('provider stale');
    }
  }

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

  private validCoords(latitude: number, longitude: number): boolean {
    return (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180
    );
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
    if (!this.validCoords(latitude, longitude)) {
      throw locationError('unavailable', 'non-finite/out-of-range coords');
    }
    return { latitude, longitude };
  }

  /**
   * The OS last known fix, or null when there is none, it is unusable,
   * or the read itself fails or times out. This read never activates
   * the provider, so it cannot hang the way getCurrentPositionAsync
   * does on some Android builds (expo issue 33981: the first call
   * succeeds, later calls hang indefinitely, and last-known keeps
   * working for subsequent fetches). The timestamp is preserved so the
   * caller can tell a current fix from a stale one; a missing or
   * non-finite timestamp counts as stale, never as current.
   */
  private async readLastKnown(
    Location: typeof ExpoLocationTypes,
  ): Promise<{
    latitude: number;
    longitude: number;
    timestampMs: number;
  } | null> {
    try {
      if (typeof Location.getLastKnownPositionAsync !== 'function') {
        return null;
      }
      const position = await withTimeout(
        Location.getLastKnownPositionAsync(),
        LAST_KNOWN_TIMEOUT_MS,
        () => new Error('last-known timeout'),
      );
      if (!position || !position.coords) return null;
      const { latitude, longitude } = position.coords;
      if (!this.validCoords(latitude, longitude)) return null;
      const timestampMs =
        typeof position.timestamp === 'number' ? position.timestamp : NaN;
      return { latitude, longitude, timestampMs };
    } catch {
      return null;
    }
  }

  /**
   * One bounded watch attempt for a live fix, used only after the
   * one-shot fix times out or is unavailable. The watch path is a
   * different native call (location updates listener) from the
   * one-shot call that hangs on some Android builds, so it can deliver
   * where the one-shot never resolves. Returns null when the watch
   * delivers nothing in time, when it delivers unusable coordinates,
   * or when the API is absent; it never throws, so a failed watch
   * always falls through to the last-known fallback below. The
   * subscription is removed on every path, including a late arrival
   * after the timeout, so a timed-out watch cannot leak a listener.
   */
  private async watchFix(
    Location: typeof ExpoLocationTypes,
  ): Promise<{ latitude: number; longitude: number } | 'cancelled' | null> {
    if (typeof Location.watchPositionAsync !== 'function') return null;
    // Holder object, not a plain variable: TS narrows a captured
    // variable to its initial null after the await, which would make
    // the removal below untypable. A property read is not narrowed.
    const holder: { current: { remove: () => void } | null } = { current: null };
    let finished = false;
    // Cancellation race: backgrounding resolves this promise, which
    // beats the watch timeout and the late native callback alike.
    // The cancel closure is held in the module slot only for the life
    // of this call (see the finally below), so a stale cancel can
    // never kill a later watch.
    let cancelResolve: (() => void) | null = null;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      cancelResolve = () => resolve('cancelled');
    });
    const cancelFn = (): void => {
      cancelResolve?.();
    };
    activeWatchCancel = cancelFn;
    try {
      return await Promise.race([
        withTimeout(
          new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
            void Location.watchPositionAsync(
              { accuracy: Location.LocationAccuracy.Balanced },
              (position) => {
                const { latitude, longitude } = position.coords;
                if (this.validCoords(latitude, longitude)) {
                  resolve({ latitude, longitude });
                } else {
                  reject(new Error('watch invalid coords'));
                }
              },
            )
              .then((s) => {
                if (finished) {
                  try {
                    s.remove();
                  } catch {
                    // Already timed out: removal is best-effort.
                  }
                } else {
                  holder.current = s;
                }
              })
              .catch(reject);
          }),
          WATCH_TIMEOUT_MS,
          () => new Error('watch timeout'),
        ),
        cancelled,
      ]);
    } catch {
      return null;
    } finally {
      finished = true;
      if (activeWatchCancel === cancelFn) activeWatchCancel = null;
      if (holder.current !== null) {
        try {
          holder.current.remove();
        } catch {
          // Removal is best-effort.
        }
        holder.current = null;
      }
    }
  }

  /**
   * The fresh path: a current fix, or the last resort fallback. Order
   * matters. First the OS last known fix when it is within the cache
   * window: that is a current fix for a 4.9 km cell, and reading it
   * avoids the provider call that hangs on some Android builds. Then
   * the live provider fix. Only when that race fails with timeout or
   * unavailable does the second chance run: one bounded watch attempt,
   * and only when that also fails does the fallback run: the OS last
   * known fix at any age, else the app's own expired cache cell.
   * Permission and services failures never reach this fallback (they
   * throw earlier), and a fallback cell is never written back into
   * the fresh cache.
   */
  private async freshLocated(
    Location: typeof ExpoLocationTypes,
  ): Promise<LocatedCell> {
    const recent = await this.readLastKnown(Location);
    if (
      recent &&
      Number.isFinite(recent.timestampMs) &&
      this.now() - recent.timestampMs <= this.maxAgeMs
    ) {
      const cell = encodeGeohash(recent.latitude, recent.longitude, 5);
      this.cached = { cell, atMs: this.now() };
      this.noteFreshPathOutcome('fresh');
      return { cell, source: 'fresh' };
    }
    try {
      const coords = await this.freshFix(Location);
      const cell = encodeGeohash(coords.latitude, coords.longitude, 5);
      this.cached = { cell, atMs: this.now() };
      this.noteFreshPathOutcome('fresh');
      return { cell, source: 'fresh' };
    } catch (error) {
      const mapped =
        error instanceof LocationError ? error : mapExpoError(error);
      if (mapped.code !== 'timeout' && mapped.code !== 'unavailable') {
        throw mapped;
      }
      recordLocationEvent('watch started');
      const watched = await this.watchFix(Location);
      if (watched === 'cancelled') {
        // Backgrounded mid-watch: the v0.1.23 log showed a watch
        // start with no outcome line at all, because the process
        // died with the old JS context. Cancelling from the
        // background transition logs the outcome before the
        // fallback runs, so the next log shows the cancel, not a gap.
        recordLocationEvent('watch cancelled backgrounded');
      } else if (watched) {
        const cell = encodeGeohash(watched.latitude, watched.longitude, 5);
        this.cached = { cell, atMs: this.now() };
        this.noteFreshPathOutcome('fresh');
        recordLocationEvent('watch fresh-ok');
        return { cell, source: 'fresh' };
      } else {
        recordLocationEvent('watch failed');
      }
      const stale = await this.readLastKnown(Location);
      if (stale) {
        recordLocationEvent('fresh last-known');
        this.noteFreshPathOutcome('last-known');
        return {
          cell: encodeGeohash(stale.latitude, stale.longitude, 5),
          source: 'last-known',
        };
      }
      if (this.cached) {
        recordLocationEvent('fresh last-known');
        this.noteFreshPathOutcome('last-known');
        return { cell: this.cached.cell, source: 'last-known' };
      }
      throw mapped;
    }
  }

  /**
   * Background refresh for a cache hit past the revalidation threshold.
   * Fire-and-forget and deduped: at most one refresh runs at a time,
   * failures are logged and swallowed (the caller already got its
   * cached cell), and a refresh only ever writes a current fix into
   * the cache, never a stale one. The caller never awaits this.
   */
  private kickRevalidation(Location: typeof ExpoLocationTypes): void {
    if (this.revalidating) return;
    recordLocationEvent('revalidate started');
    const run = (async (): Promise<void> => {
      try {
        const recent = await this.readLastKnown(Location);
        let cell: string;
        if (
          recent &&
          Number.isFinite(recent.timestampMs) &&
          this.now() - recent.timestampMs <= this.maxAgeMs
        ) {
          cell = encodeGeohash(recent.latitude, recent.longitude, 5);
        } else {
          const coords = await this.freshFix(Location);
          cell = encodeGeohash(coords.latitude, coords.longitude, 5);
        }
        this.cached = { cell, atMs: this.now() };
        this.noteFreshPathOutcome('fresh');
        recordLocationEvent('revalidate ok');
      } catch (error: unknown) {
        // A bare revalidate failed line hid the cause in the v0.1.23
        // logs (5 failures, no reason). Log the mapped code:
        // timeout, permission-denied, services-disabled, or
        // unavailable. An unmapped provider failure keeps its error
        // class name after the colon, so the next log can tell
        // provider error shapes apart instead of lumping them.
        recordLocationEvent(`revalidate failed ${revalidateFailureCode(error)}`);
      }
    })();
    this.revalidating = run;
    void run.finally(() => {
      if (this.revalidating === run) this.revalidating = null;
    });
  }

  async getLocatedCell(): Promise<LocatedCell> {
    const Location = this.loadLocation();

    // Permission is re-checked on EVERY call, before the cache is consulted:
    // a revoked grant must never serve even a fresh cached cell.
    await this.ensurePermission(Location);

    // Services probe runs BEFORE the cache is consulted (T10 hardening):
    // a warm cached cell must not mask location services being switched
    // off — that would post to a stale cell with no failure copy shown.
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
      // Non-Android / unexpected probe failure: fall through to the cache
      // and the fix attempt, which report the real state.
    }

    const cached = this.cached;
    if (cached && this.now() - cached.atMs <= this.maxAgeMs) {
      // Stale-while-revalidate: serve at once, refresh in the background
      // once the entry is past the threshold, so the next submit after
      // expiry finds a fresh cache instead of a cold 15 second race.
      if (this.now() - cached.atMs > REVALIDATE_AFTER_MS) {
        this.kickRevalidation(Location);
      }
      return { cell: cached.cell, source: 'cached' };
    }

    // Dedupe concurrent resolutions: the cache above covers sequential
    // calls, but concurrent callers previously each ran a fresh GPS fix.
    // Permission and services probes still run per call above; only the
    // fix itself is shared, and the shared promise clears on settle so a
    // later failure can retry instead of reusing a rejection.
    if (this.inflight) return this.inflight;
    const run = (async (): Promise<LocatedCell> => {
      try {
        return await this.freshLocated(Location);
      } catch (error) {
        if (error instanceof LocationError) throw error;
        throw mapExpoError(error);
      }
    })();
    this.inflight = run;
    try {
      return await run;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  async getCurrentCell(): Promise<string> {
    return (await this.getLocatedCell()).cell;
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

/**
 * Reason code for a background revalidation failure: the typed code
 * when the failure carries one, else the mapped expo code. An
 * unmapped provider failure keeps its error class name after the
 * colon (an outcome name only, never content or coordinates), so
 * the diagnostics line distinguishes provider error shapes.
 */
function revalidateFailureCode(error: unknown): string {
  if (error instanceof LocationError) return error.code;
  const mapped = mapExpoError(error);
  if (mapped.code !== 'unavailable') return mapped.code;
  const cls = error instanceof Error ? error.name : typeof error;
  return `unavailable:${cls}`;
}

/**
 * Cancel closure for the in-flight location watch, if any. The watch
 * cancel subscription (below) resolves through this slot, mirroring
 * how the compose warmup seam reaches the default provider: only one
 * watch can be in flight at a time in practice, and the slot clears
 * when the watch settles, so a stale cancel never fires.
 */
let activeWatchCancel: (() => void) | null = null;

/** Cancel the in-flight location watch, if any. No-op otherwise. */
export function cancelPendingLocationWatch(): void {
  activeWatchCancel?.();
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
  composePermissionLogged = false;
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
 * The device's current geohash-5 cell, plus where it came from. The
 * default provider tracks the source; test seam providers expose only
 * getCurrentCell, so their cells report as 'fresh' (production always
 * uses the Expo provider above, where the source is real).
 */
export async function getLocatedCell(): Promise<LocatedCell> {
  const provider =
    providerOverride ?? (defaultProvider ??= new ExpoLocationProvider());
  if (provider instanceof ExpoLocationProvider) {
    return provider.getLocatedCell();
  }
  return { cell: await provider.getCurrentCell(), source: 'fresh' };
}

/**
 * The device's current geohash-5 cell. Async: resolving a fix may prompt for
 * permission and wait on GPS. Fails loud with LocationError on any failure -
 * callers must surface the copy and keep the explicit-geohash5 override for
 * tests/dev.
 */
export async function getLocationCell(): Promise<string> {
  return (await getLocatedCell()).cell;
}

/**
 * Warm the location fix ahead of a post (compose-open prefetch). When the
 * OS foreground grant is already present, this resolves a cell through the
 * same default provider publishPost uses, so by submit time the cache is
 * warm or the fix is already in flight and submit awaits that same
 * attempt through the provider's in-flight sharing. Never throws: a
 * warm-up failure is logged as an outcome line and submit retries and
 * surfaces the typed error then. When the grant is not already present,
 * warming is skipped entirely, so the OS permission dialog still only
 * fires through the composer's priming flow, never from opening the
 * sheet. Outcome lines carry outcome names only, never coordinates or
 * cells, so the shared diagnostics log stays safe to share. Nothing
 * about the fail-loud contract changes except the documented last-known
 * fallback, which only runs after the fresh race fails.
 */
export async function warmLocationCell(): Promise<void> {
  try {
    // Gap 103: a skipped warmup is visible, not silent. The line names
    // the permission status only, never content or location, so the
    // log can no longer be read as "warmup never ran" when it ran and
    // was skipped for permission, and the log can distinguish the two
    // skip reasons. The OS dialog still only fires from the composer's
    // priming flow, never from warming.
    const permission = await getLocationPermissionStatus();
    if (permission !== 'granted') {
      recordLocationEvent(
        permission === 'denied' ? 'warmup skipped denied' : 'warmup skipped undetermined',
      );
      return;
    }
    recordLocationEvent('warmup started');
    const { source } = await getLocatedCell();
    recordLocationEvent(
      source === 'cached'
        ? 'warmup served-cached'
        : source === 'fresh'
          ? 'warmup fresh-ok'
          : 'warmup last-known',
    );
  } catch (error) {
    recordLocationEvent(
      error instanceof LocationError && error.code === 'unavailable'
        ? 'warmup no-coordinates'
        : 'warmup fresh-failed',
    );
  }
}

/**
 * Gap 104, observability only: log the foreground-location permission
 * status (status word only, never content or location) at setup
 * completion and at first compose open. This does NOT change any
 * permission behavior: it only records the two readings the
 * first-launch hypothesis needs, so a later log can show whether the
 * grant read absent at setup and present at first open, or the
 * reverse, without guessing at the mechanism. The compose reading is
 * logged once per session; the setup reading logs on every setup
 * completion (setup completes once per install).
 */
let composePermissionLogged = false;

async function recordPermissionStatus(prefix: 'setup' | 'compose'): Promise<void> {
  try {
    const status = await getLocationPermissionStatus();
    recordLocationEvent(`${prefix} permission ${status}` as LocationLogDetail);
  } catch {
    // Logging never breaks setup or compose.
  }
}

/** Log the permission status at setup completion (gap 104). */
export async function logSetupPermissionStatus(): Promise<void> {
  await recordPermissionStatus('setup');
}

/** Log the permission status at the first compose open only (gap 104). */
export async function logFirstComposePermissionStatus(): Promise<void> {
  if (composePermissionLogged) return;
  composePermissionLogged = true;
  await recordPermissionStatus('compose');
}

/**
 * Gap 103 retry trigger, as a testable seam: subscribe a foreground
 * return to a fresh warmup attempt, for use while compose is open.
 * The compose sheet owns the subscription lifetime (it subscribes on
 * open and unsubscribes on close), so a user typing for minutes in one
 * open gets a second warmup attempt on returning to the app, instead
 * of waiting for the next open. The AppState shape is the
 * react-native one, narrowed to what this seam uses, so unit tests can
 * pass a fake. Warmup itself never throws and never prompts.
 */
export interface ComposeWarmupAppState {
  addEventListener: (
    type: 'change',
    cb: (state: string) => void,
  ) => { remove: () => void };
}

export function subscribeComposeWarmupOnForeground(
  appState: ComposeWarmupAppState,
): () => void {
  const sub = appState.addEventListener('change', (state) => {
    if (state === 'active') void warmLocationCell();
  });
  return () => sub.remove();
}

/**
 * Background seam for the location watch, mirroring the warmup seam
 * above: when the app backgrounds mid-watch, cancel the watch so
 * its outcome line (watch cancelled backgrounded) lands before the
 * last-known fallback runs, instead of the watch dying silently
 * with the old JS context. Only the background transition cancels:
 * transient inactive states (dialogs, permission prompts) leave the
 * watch running.
 */
export function subscribeWatchCancelOnBackground(
  appState: ComposeWarmupAppState,
): () => void {
  const sub = appState.addEventListener('change', (state) => {
    if (state === 'background') cancelPendingLocationWatch();
  });
  return () => sub.remove();
}
