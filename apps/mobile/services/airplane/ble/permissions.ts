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

/**
 * Back-compat for the GATT port's deps (its requestPermissions slot):
 * the same request loop this module has always run.
 */
export async function ensureBlePermissions(): Promise<boolean> {
  return requestBlePermissions();
}
