// SPDX-License-Identifier: Apache-2.0
// Runtime BLE permission flow (Android).
//
// Declared (manifest, install-time): BLUETOOTH_SCAN / BLUETOOTH_ADVERTISE /
// BLUETOOTH_CONNECT (API 31+), legacy BLUETOOTH/BLUETOOTH_ADMIN +
// ACCESS_FINE_LOCATION (maxSdkVersion 30, for API <= 30).
//
// This module requests the *runtime* grants. Never throws: any failure
// (unsupported platform, denied, exception) resolves false and the mesh
// simply runs without the radio.

import { PermissionsAndroid, Platform, type Permission } from 'react-native';

/** True when every BLE runtime permission needed on this API level is granted. */
export async function ensureBlePermissions(): Promise<boolean> {
  try {
    if (Platform.OS !== 'android') return false;
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const needed: Permission[] =
      apiLevel >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    for (const perm of needed) {
      if (!perm) return false; // permission constant missing on this build
      const granted = await PermissionsAndroid.request(perm);
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
    }
    return true;
  } catch {
    return false;
  }
}
