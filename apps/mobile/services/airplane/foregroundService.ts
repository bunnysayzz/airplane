// SPDX-License-Identifier: Apache-2.0
// T4 background relay: JS lifecycle for the Android foreground service.
//
// The service itself (AirplaneForegroundService.kt) is only a keep-alive
// shell with a visible notification and a Stop action. It runs no relay
// protocol: while it runs, the existing hybrid transport simply stays up
// (BLE + Nostr, existing flood/dedup), and the app NEVER calls
// stopTransport on a background transition while the service is desired
// (see _layout.tsx). No new relay protocol is invented here, and no
// mesh re-flood is added: today a received event is stored and, when
// online, uploaded by WorldSync; it is not re-flooded over the mesh
// (see diagnostics.ts). This module keeps that transport alive in the
// background; it does not change what it forwards.
//
// State machine (actual native state, not the preference):
//   disabled    - service not running (also the initial state)
//   starting    - start requested, native call in flight
//   running     - native start accepted (confirmed on next sync query)
//   stopping    - stop requested, native call in flight
//   unavailable - no native module (iOS, Expo Go, or a build without the
//                 manually registered package): start always fails here
// `desired` is separate: true once the user turned the toggle on and
// until they turn it off. It survives a native death, so a background
// transition can re-assert the service without re-asking the user.
// The preference itself is persisted by SettingsContext, not here, so
// this module stays testable without AsyncStorage.
//
// Native behaviour that cannot run in Jest is stated, not claimed: the
// Kotlin service, its notification, and its Stop action are compiled by
// the CI Android build and need a real device to prove (see the T4
// device-proof list in the task report). Jest covers this state machine
// with an injected fake native module.

import { NativeModules } from 'react-native';

export type ForegroundRelayState =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'unavailable';

export interface ForegroundServiceNative {
  startService: () => Promise<boolean>;
  stopService: () => Promise<boolean>;
  isRunning: () => Promise<boolean>;
}

type Listener = () => void;

let state: ForegroundRelayState = 'disabled';
let desired = false;
// Bumps on every stop: a start still in flight when the user taps off
// must not flip the state back to running when its native call lands.
let epoch = 0;
const listeners = new Set<Listener>();

/** Test seam: injected native module replaces NativeModules lookup. */
let nativeOverride: ForegroundServiceNative | null | undefined;

export function __setForegroundServiceNativeForTests(
  native: ForegroundServiceNative | null,
): void {
  nativeOverride = native;
}

export function __resetForegroundServiceForTests(): void {
  state = 'disabled';
  desired = false;
  epoch += 1;
  listeners.clear();
  nativeOverride = undefined;
}

function getNative(): ForegroundServiceNative | null {
  if (nativeOverride !== undefined) return nativeOverride;
  const mod = (NativeModules as Record<string, unknown>)['AirplaneForegroundService'] as
    | ForegroundServiceNative
    | undefined;
  if (
    mod &&
    typeof mod.startService === 'function' &&
    typeof mod.stopService === 'function' &&
    typeof mod.isRunning === 'function'
  ) {
    return mod;
  }
  return null;
}

function setState(next: ForegroundRelayState): void {
  if (state === next) return;
  state = next;
  for (const cb of [...listeners]) cb();
}

export function getForegroundRelayState(): ForegroundRelayState {
  return state;
}

/** True once the user turned background relay on, until they turn it off. */
export function isForegroundRelayDesired(): boolean {
  return desired;
}

export function subscribeForegroundRelayState(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Start the service. Idempotent while running; returns false (and leaves
 * state disabled/unavailable) when there is no native module or the
 * native start fails. A second start while one is in flight is a no-op
 * that reports false rather than racing the first call.
 */
export async function startForegroundRelay(): Promise<boolean> {
  if (state === 'running') return true;
  if (state === 'starting' || state === 'stopping') return false;
  const native = getNative();
  if (!native) {
    desired = false;
    setState('unavailable');
    return false;
  }
  desired = true;
  const myEpoch = epoch;
  setState('starting');
  let ok = false;
  try {
    ok = await native.startService();
  } catch {
    ok = false;
  }
  if (myEpoch !== epoch) return ok;
  // The native start dispatches an intent and resolves before
  // onStartCommand lands, so `running` here means "start accepted".
  // syncForegroundRelayState() (polled by Diagnostics, run on
  // foreground return) confirms it against the native flag.
  setState(ok ? 'running' : 'disabled');
  if (!ok) desired = false;
  return ok;
}

/** Stop the service. Always succeeds from the JS side's point of view. */
export async function stopForegroundRelay(): Promise<boolean> {
  desired = false;
  epoch += 1;
  if (state === 'disabled' || state === 'unavailable') {
    setState('disabled');
    return true;
  }
  const native = getNative();
  setState('stopping');
  if (native) {
    try {
      await native.stopService();
    } catch {
      // A failed native stop still ends the JS desire; the notification's
      // own Stop action and the next sync are the recovery paths.
    }
  }
  setState('disabled');
  return true;
}

/**
 * Reconcile JS state with the native flag. Called on foreground return
 * and by the Diagnostics poll. A service that died without JS noticing
 * (OS kill, notification Stop tap) drops back to disabled while the
 * user's desire stays set, so the next background transition can
 * re-assert it via ensureForegroundRelayRunning().
 */
export async function syncForegroundRelayState(): Promise<ForegroundRelayState> {
  const native = getNative();
  if (!native) {
    setState('unavailable');
    return state;
  }
  let running = false;
  try {
    running = await native.isRunning();
  } catch {
    running = false;
  }
  if (running) {
    setState('running');
  } else if (state === 'running' || state === 'starting') {
    setState('disabled');
  }
  return state;
}

/**
 * Background-transition hook (called from _layout): if the user wants
 * background relay, make sure the service is up. No-op when never
 * enabled, and never starts the service for a user who turned it off.
 */
export async function ensureForegroundRelayRunning(): Promise<boolean> {
  if (!desired) return false;
  return startForegroundRelay();
}
