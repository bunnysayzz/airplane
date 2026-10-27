// SPDX-License-Identifier: Apache-2.0
// Location fail-loud audit tests (LOC-1 is now implemented).
//
// The location provider is deliberately fail-loud: on permission denied,
// disabled services, GPS timeout, or a missing native module it rejects
// with a typed LocationError - it NEVER returns a fake/default location
// (that would poison feed scoping and erode trust in the mesh).
// publishPost() must propagate that failure - never catch it and
// substitute coordinates. The UI layer (ComposeModal.handlePublish) maps
// the LocationError to user-facing copy. These tests prove nothing is ever
// written to the store on the failing path, and that an explicit geohash5
// override bypasses the provider entirely.

import { publishPost, getLocationCell } from './composer';
import {
  LocationError,
  locationError,
  setLocationProviderForTests,
  __resetLocationProviderForTests,
} from './location';
import { getStore, __resetStoreForTests } from './store';
import { __resetDeviceKeypairForTests } from './identity';

beforeEach(() => {
  __resetStoreForTests();
  __resetDeviceKeypairForTests();
  __resetLocationProviderForTests();
});

afterEach(() => {
  __resetLocationProviderForTests();
});

describe('location fail-loud (LOC-1)', () => {
  test('getLocationCell() rejects with LocationError, never a fake cell', async () => {
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('permission-denied');
      },
    });
    const err = await getLocationCell().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocationError);
    expect((err as LocationError).code).toBe('permission-denied');
  });

  test('publishPost without geohash5 rejects BEFORE anything hits the store', async () => {
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('services-disabled');
      },
    });
    const saveSpy = jest.spyOn(getStore(), 'saveEvent');
    await expect(publishPost('no cell post', {})).rejects.toBeInstanceOf(
      LocationError,
    );
    await expect(publishPost('no cell post', {})).rejects.toMatchObject({
      code: 'services-disabled',
    });
    expect(saveSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
    // Belt and suspenders: the store is genuinely empty.
    expect(
      await getStore().listFeed({ cells: ['tdr1v'], limit: 50 }),
    ).toHaveLength(0);
    expect(await getStore().getEvent('00'.repeat(32))).toBeNull();
  });

  test('an explicit geohash5 override bypasses the provider and stores normally', async () => {
    // Even a hard-failing provider must not be consulted on the override path.
    let consulted = false;
    setLocationProviderForTests({
      getCurrentCell: async () => {
        consulted = true;
        throw locationError('timeout');
      },
    });
    const id = await publishPost('explicit cell post', { geohash5: 'tdr1v' });
    expect(consulted).toBe(false);
    const saved = await getStore().getEvent(id);
    expect(saved).not.toBeNull();
    expect(saved!.geohash).toBe('tdr1v');
  });

  test('no catch site substitutes a fake location on the failing path', async () => {
    // A provider that would hand back a hardcoded cell if anyone fell back
    // to defaults - publishPost must surface the LocationError instead.
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('unavailable', 'expo-location native module missing');
      },
    });
    await expect(publishPost('x', {})).rejects.toThrow(
      /location\/unavailable/,
    );
    expect(
      await getStore().listFeed({ cells: ['tdr1v'], limit: 50 }),
    ).toHaveLength(0);
  });
});
