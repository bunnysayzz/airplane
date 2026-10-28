// SPDX-License-Identifier: Apache-2.0
// Runtime BLE permission flow (Android).
//
// Declared (manifest, install-time): BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE /
// BLUETOOTH_CONNECT (API 31+), legacy BLUETOOTH/BLUETOOTH_ADMIN +
// ACCESS_FINE_LOCATION (maxSdkVersion 30, for API <= 30).
//
// Two operations, deliberately split for permission priming:
// - checkBlePermissions(): reads the OS state, NEVER prompts. The transport
//   uses this at startup so the OS dialog can never fire at boot.
// - requestBlePermissions(): fires the real OS request(s). Call ONLY from a
//   user action — the BlePrime dialog asks this after the user accepts the
//   in-app rationale.
// Both never throw: any failure (unsupported platform, denied, exception)
// resolves false and the mesh simply runs without the radio.

import { PermissionsAndroid, Platform, type Permission } from 'react-native';

function neededPermissions(): Permission[] {
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  return apiLevel >= 31
    ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
}

/** True when every BLE runtime permission needed on this API level is granted. Never prompts. */
export async function checkBlePermissions(): Promise<boolean> {
  try {
    if (Platform.OS !== 'android') return false;
    for (const perm of neededPermissions()) {
      if (!perm) return false; // permission constant missing on this build
      if (!(await PermissionsAndroid.check(perm))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Fire the real OS permission request(s). User-action only: the BlePrime
 * dialog calls this after the user accepts the in-app rationale. Never
 * throws; false on any denial or error.
 */
export async function requestBlePermissions(): Promise<boolean> {
  try {
    if (Platform.OS !== 'android') return false;
    for (const perm of neededPermissions()) {
      if (!perm) return false; // permission constant missing on this build
      const granted = await PermissionsAndroid.request(perm);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** One grant in the diagnostics permission dump. */
export type BlePermissionState = 'granted' | 'denied' | 'unavailable';

/**
 * Per-permission grant state for the diagnostics screen. Reads OS state
 * only, never prompts. Location services state, battery optimisation
 * exemption, and OEM autostart have no API wired in the app, so they
 * report 'unavailable' honestly instead of a guessed value: a missing
 * grant is shown with an Open Settings action, not a fabricated state.
 */
export interface BlePermissionReport {
  scan: BlePermissionState;
  advertise: BlePermissionState;
  connect: BlePermissionState;
  location: BlePermissionState;
  locationServices: BlePermissionState;
  batteryOptimisation: BlePermissionState;
  autostart: BlePermissionState;
}

async function checkOne(perm: Permission | undefined): Promise<BlePermissionState> {
  try {
    if (Platform.OS !== 'android' || !perm) return 'unavailable';
    return (await PermissionsAndroid.check(perm)) ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Location grant state, read against the permission the manifest actually
 * declares. R3 fix for the R2 diagnostics discrepancy (Diagnostics said
 * location denied while system settings showed it allowed while using):
 * the manifest declares only ACCESS_COARSE_LOCATION on API 31+ (fine is
 * maxSdkVersion 30), so a FINE check is always denied on API 31+ even
 * when the user granted coarse location. On API 31+ the location row
 * therefore checks COARSE; FINE is only checked on API <= 30, where it
 * is the declared permission. BLUETOOTH_SCAN also carries
 * neverForLocation, so on API 31+ location is not a BLE gate at all:
 * it only reports the feed-location grant, never blocks the radio.
 */
async function checkLocationState(apiLevel: number): Promise<BlePermissionState> {
  const p = PermissionsAndroid.PERMISSIONS;
  return apiLevel >= 31 ? checkOne(p.ACCESS_COARSE_LOCATION) : checkOne(p.ACCESS_FINE_LOCATION);
}

/** Read the BLE and location grant states without prompting. Never throws. */
export async function checkBlePermissionStates(): Promise<BlePermissionReport> {
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const p = PermissionsAndroid.PERMISSIONS;
  // Below API 31 there are no runtime BLUETOOTH_SCAN/ADVERTISE/CONNECT
  // permissions: legacy BLUETOOTH/BLUETOOTH_ADMIN are install-time grants,
  // so the three radio rows report granted (install-time) instead of
  // unavailable, which read as unknown radio health on older phones.
  const legacyGranted: BlePermissionState = Platform.OS === 'android' ? 'granted' : 'unavailable';
  return {
    scan: apiLevel >= 31 ? await checkOne(p.BLUETOOTH_SCAN) : legacyGranted,
    advertise: apiLevel >= 31 ? await checkOne(p.BLUETOOTH_ADVERTISE) : legacyGranted,
    connect: apiLevel >= 31 ? await checkOne(p.BLUETOOTH_CONNECT) : legacyGranted,
    location: await checkLocationState(apiLevel),
    locationServices: 'unavailable',
    batteryOptimisation: 'unavailable',
    autostart: 'unavailable',
  };
}

/**
 * Back-compat for the GATT port's deps (its requestPermissions slot):
 * the same request loop this module has always run.
 */
export async function ensureBlePermissions(): Promise<boolean> {
  return requestBlePermissions();
}
