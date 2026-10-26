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

/** Read the BLE and location grant states without prompting. Never throws. */
export async function checkBlePermissionStates(): Promise<BlePermissionReport> {
  const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const p = PermissionsAndroid.PERMISSIONS;
  return {
    scan: apiLevel >= 31 ? await checkOne(p.BLUETOOTH_SCAN) : 'unavailable',
    advertise: apiLevel >= 31 ? await checkOne(p.BLUETOOTH_ADVERTISE) : 'unavailable',
    connect: apiLevel >= 31 ? await checkOne(p.BLUETOOTH_CONNECT) : 'unavailable',
    location: await checkOne(p.ACCESS_FINE_LOCATION),
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
