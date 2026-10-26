// SPDX-License-Identifier: Apache-2.0
// Publish stage tagging (T1): publishPost() must wrap keypair/sign/save/
// notify failures in a PublishError carrying the stage, while LocationError
// still propagates unwrapped (the UI maps it to location copy, never the
// generic "Publishing failed" dialog).

import { publishPost, PublishError } from './composer';
import {
  LocationError,
  locationError,
  setLocationProviderForTests,
  __resetLocationProviderForTests,
} from './location';
import { getStore, __resetStoreForTests } from './store';
import { setKeyStore, __resetDeviceKeypairForTests } from './identity';
import { subscribeFeed, __resetFeedListenersForTests } from './feed';
import type { KeyStorePort } from '@airplane/crypto';

beforeEach(() => {
  __resetStoreForTests();
  __resetDeviceKeypairForTests();
  __resetLocationProviderForTests();
  __resetFeedListenersForTests();
});

afterEach(() => {
  __resetLocationProviderForTests();
  __resetFeedListenersForTests();
  __resetDeviceKeypairForTests();
});

function throwingStore(message: string): KeyStorePort {
  return {
    generateKeypair: () => {
      throw new Error(message);
    },
    storeKeypair: async () => {},
    loadKeypair: async () => {
      throw new Error(message);
    },
    sign: async () => new Uint8Array(64),
    getPublicKey: async () => null,
    wipeKeypair: async () => {},
  };
}

describe('publishPost stage tagging', () => {
  test('keypair failure throws PublishError with stage keypair and the original cause', async () => {
    setKeyStore(throwingStore('secure store exploded'));
    const err = await publishPost('stage test', {
      geohash5: 'tdr1v',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).stage).toBe('keypair');
    expect((err as PublishError).cause).toBeInstanceOf(Error);
    expect(((err as PublishError).cause as Error).message).toBe('secure store exploded');
  });

  test('save failure throws PublishError with stage save', async () => {
    const saveSpy = jest.spyOn(getStore(), 'saveEvent').mockRejectedValue(new Error('disk full'));
    const err = await publishPost('stage test', {
      geohash5: 'tdr1v',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).stage).toBe('save');
    saveSpy.mockRestore();
  });

  test('notify failure throws PublishError with stage notify, after the event is saved', async () => {
    subscribeFeed(() => {
      throw new Error('listener boom');
    });
    const err = await publishPost('stage test', {
      geohash5: 'tdr1v',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).stage).toBe('notify');
    // The post landed in the store before notify threw.
    expect(await getStore().listFeed({ cells: ['tdr1v'], limit: 50 })).toHaveLength(1);
  });

  test('location failure still propagates as a bare LocationError, never PublishError', async () => {
    setLocationProviderForTests({
      getCurrentCell: async () => {
        throw locationError('services-disabled');
      },
    });
    const err = await publishPost('stage test', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocationError);
    expect(err).not.toBeInstanceOf(PublishError);
  });

  test('happy path is unchanged: override cell publishes and returns a hex event id', async () => {
    const id = await publishPost('stage test', { geohash5: 'tdr1v' });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await getStore().getEvent(id)).not.toBeNull();
  });
});
