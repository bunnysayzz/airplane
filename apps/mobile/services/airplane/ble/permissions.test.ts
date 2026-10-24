// SPDX-License-Identifier: Apache-2.0
// ensureBlePermissions: never throws; false on any denial or error.
// The react-native module is the jest mock (__mocks__/react-native.ts),
// cast to its mock shape because the real RN types don't declare it.

import { ensureBlePermissions } from './permissions';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require('react-native') as {
  Platform: { OS: string; Version: number | string };
  PermissionsAndroid: {
    PERMISSIONS: Record<string, string>;
    request: jest.Mock;
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
