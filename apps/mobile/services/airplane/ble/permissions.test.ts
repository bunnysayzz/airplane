// SPDX-License-Identifier: Apache-2.0
// ensureBlePermissions: never throws; false on any denial or error.
// The react-native module is the jest mock (__mocks__/react-native.ts),
// cast to its mock shape because the real RN types don't declare it.

import { ensureBlePermissions, checkBlePermissions, requestBlePermissions, checkBlePermissionStates } from './permissions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require('react-native') as {
  Platform: { OS: string; Version: number | string };
  PermissionsAndroid: {
    PERMISSIONS: Record<string, string>;
    request: jest.Mock;
    check: jest.Mock;
  };
  __resetReactNativeMock(): void;
};

describe('ensureBlePermissions', () => {
  beforeEach(() => {
    RN.__resetReactNativeMock();
  });

  test('grants all three runtime permissions on API 31+', async () => {
    RN.Platform.OS = 'android';
    RN.Platform.Version = 34;
    await expect(ensureBlePermissions()).resolves.toBe(true);
    const requested = RN.PermissionsAndroid.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(requested).toEqual([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_ADVERTISE',
      'android.permission.BLUETOOTH_CONNECT',
    ]);
  });

  test('requests location on API <= 30', async () => {
    RN.Platform.OS = 'android';
    RN.Platform.Version = 30;
    await expect(ensureBlePermissions()).resolves.toBe(true);
    const requested = RN.PermissionsAndroid.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(requested).toEqual(['android.permission.ACCESS_FINE_LOCATION']);
  });

  test('false when any permission is denied', async () => {
    RN.PermissionsAndroid.request
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce('denied');
    await expect(ensureBlePermissions()).resolves.toBe(false);
  });

  test('false on non-android platforms', async () => {
    RN.Platform.OS = 'ios';
    await expect(ensureBlePermissions()).resolves.toBe(false);
    expect(RN.PermissionsAndroid.request).not.toHaveBeenCalled();
  });

  test('false when the request throws (never propagates)', async () => {
    RN.PermissionsAndroid.request.mockRejectedValue(new Error('boom'));
    await expect(ensureBlePermissions()).resolves.toBe(false);
  });
});

describe('checkBlePermissions (priming: never prompts)', () => {
  beforeEach(() => {
    RN.__resetReactNativeMock();
  });

  test('true when all grants are in place, without requesting', async () => {
    RN.Platform.OS = 'android';
    RN.Platform.Version = 34;
    await expect(checkBlePermissions()).resolves.toBe(true);
    expect(RN.PermissionsAndroid.check).toHaveBeenCalledTimes(3);
    expect(RN.PermissionsAndroid.request).not.toHaveBeenCalled();
  });

  test('false when any grant is missing, without requesting', async () => {
    RN.PermissionsAndroid.check.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(checkBlePermissions()).resolves.toBe(false);
    expect(RN.PermissionsAndroid.request).not.toHaveBeenCalled();
  });

  test('false on non-android platforms', async () => {
    RN.Platform.OS = 'ios';
    await expect(checkBlePermissions()).resolves.toBe(false);
    expect(RN.PermissionsAndroid.check).not.toHaveBeenCalled();
    expect(RN.PermissionsAndroid.request).not.toHaveBeenCalled();
  });

  test('false when the check throws (never propagates)', async () => {
    RN.PermissionsAndroid.check.mockRejectedValue(new Error('boom'));
    await expect(checkBlePermissions()).resolves.toBe(false);
  });
});

describe('requestBlePermissions (priming: user-action only)', () => {
  beforeEach(() => {
    RN.__resetReactNativeMock();
  });

  test('fires the OS request for each needed permission', async () => {
    RN.Platform.OS = 'android';
    RN.Platform.Version = 34;
    await expect(requestBlePermissions()).resolves.toBe(true);
    const requested = RN.PermissionsAndroid.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(requested).toEqual([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_ADVERTISE',
      'android.permission.BLUETOOTH_CONNECT',
    ]);
    expect(RN.PermissionsAndroid.check).not.toHaveBeenCalled();
  });

  test('false when denied at the OS dialog', async () => {
    RN.PermissionsAndroid.request.mockResolvedValueOnce('granted').mockResolvedValueOnce('denied');
    await expect(requestBlePermissions()).resolves.toBe(false);
  });
});

describe('checkBlePermissionStates (R3 location fix)', () => {
  beforeEach(() => {
    RN.__resetReactNativeMock();
  });

  test('API 31+ location row checks COARSE, not FINE', async () => {
    RN.Platform.OS = 'android';
    RN.Platform.Version = 34;
    const report = await checkBlePermissionStates();
    expect(report.location).toBe('granted');
    const checked = RN.PermissionsAndroid.check.mock.calls.map((c: unknown[]) => c[0]);
    expect(checked).toContain('android.permission.ACCESS_COARSE_LOCATION');
    expect(checked).not.toContain('android.permission.ACCESS_FINE_LOCATION');
  });

  test('API <= 30 location row checks FINE', async () => {
    RN.Platform.OS = 'android';
    RN.Platform.Version = 30;
    await checkBlePermissionStates();
    const checked = RN.PermissionsAndroid.check.mock.calls.map((c: unknown[]) => c[0]);
    expect(checked).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(checked).not.toContain('android.permission.ACCESS_COARSE_LOCATION');
  });
});

describe('checkBlePermissionStates pre-31 (audit F-P3-6)', () => {
  test('API <= 30 reports scan/advertise/connect as granted (install-time)', async () => {
    RN.__resetReactNativeMock();
    RN.Platform.OS = 'android';
    RN.Platform.Version = 30;
    const report = await checkBlePermissionStates();
    expect(report.scan).toBe('granted');
    expect(report.advertise).toBe('granted');
    expect(report.connect).toBe('granted');
  });
});
