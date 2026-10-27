// SPDX-License-Identifier: Apache-2.0
// Tests for T8: signing behind the KeyStorePort.sign() seam and key rotation.
//
// The seam contract these tests pin down:
// - signDeviceEvent() produces a verifiable event without the caller ever
//   receiving the secret key (callers only see pubkey + signature).
// - rotateDeviceKey() burns the old identity: the new pubkey differs, later
//   loads + signatures use the new key only, and the old key verifies
//   nothing new.
// - A wipe failure aborts rotation with the old identity intact.
// - Rotation changes the derived DM address (same derivation, new secret),
//   which is why the rotation screen must say old DM peers can't reach the
//   new identity.

import { MemoryKeyStore } from '@airplane/crypto';
import {
  NobleCrypto,
  verifyEvent,
  EVENT_KIND_POST,
  type EventKind,
} from '@airplane/protocol';
import { dmKeypairFromDeviceSecret } from '@airplane/transport';
import {
  getDeviceKeypair,
  getDevicePublicKey,
  rotateDeviceKey,
  setKeyStore,
  signDeviceEvent,
  signWithDeviceKey,
  __resetDeviceKeypairForTests,
} from './identity';
import { __resetStarsForTests, resolveOwnPubkeyHex } from './stars';
import { __resetDmServiceForTests } from './dm';

const crypto = new NobleCrypto();

beforeEach(() => {
  __resetDeviceKeypairForTests();
  __resetStarsForTests();
  __resetDmServiceForTests();
  setKeyStore(new MemoryKeyStore());
});

afterEach(() => {
  __resetDeviceKeypairForTests();
  __resetStarsForTests();
  __resetDmServiceForTests();
});

describe('signing behind the KeyStorePort seam', () => {
  test('signDeviceEvent produces a verifiable event stamped with the device pubkey', async () => {
    const pubkey = await getDevicePublicKey();
    const event = await signDeviceEvent({
      created_at: 1_700_000_000,
      kind: EVENT_KIND_POST as EventKind,
      geohash: 'tdr1v',
      tags: [],
      content: 'seam signed',
    });
    expect(event.pubkey).toEqual(pubkey);
    expect(verifyEvent(crypto, event)).toBe(true);
  });

  test('signWithDeviceKey verifies against the device pubkey', async () => {
    const pubkey = await getDevicePublicKey();
    const msg = new TextEncoder().encode('raw message');
    const sig = await signWithDeviceKey(msg);
    expect(sig).toHaveLength(64);
    expect(crypto.verify(sig, msg, pubkey)).toBe(true);
  });
});

describe('rotateDeviceKey', () => {
  test('new pubkey differs, later loads + signatures use only the new key', async () => {
    const oldKp = await getDeviceKeypair();
    const oldHex = Buffer.from(oldKp.publicKey).toString('hex');
    const result = await rotateDeviceKey();
    expect(result.oldPublicKeyHex).toBe(oldHex);
    expect(result.newPublicKeyHex).not.toBe(oldHex);

    const current = await getDeviceKeypair();
    expect(Buffer.from(current.publicKey).toString('hex')).toBe(result.newPublicKeyHex);

    const event = await signDeviceEvent({
      created_at: 1_700_000_001,
      kind: EVENT_KIND_POST as EventKind,
      geohash: 'tdr1v',
      tags: [],
      content: 'after rotation',
    });
    expect(verifyEvent(crypto, event)).toBe(true);
    expect(crypto.verify(event.sig, event.id, oldKp.publicKey)).toBe(false);
  });

  test('rotation refreshes the cached own-pubkey (stars listener)', async () => {
    const before = await resolveOwnPubkeyHex();
    expect(before).not.toBeNull();
    await rotateDeviceKey();
    const after = await resolveOwnPubkeyHex();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  test('rotation changes the derived DM address', async () => {
    const oldKp = await getDeviceKeypair();
    const oldDm = dmKeypairFromDeviceSecret(oldKp.secretKey);
    await rotateDeviceKey();
    const newKp = await getDeviceKeypair();
    const newDm = dmKeypairFromDeviceSecret(newKp.secretKey);
    expect(Buffer.from(newDm.publicKey).toString('hex')).not.toBe(
      Buffer.from(oldDm.publicKey).toString('hex'),
    );
  });

  test('a wipe failure aborts rotation with the old identity intact', async () => {
    const failing = new (class extends MemoryKeyStore {
      override async wipeKeypair(): Promise<void> {
        throw new Error('keystore wipe exploded');
      }
    })();
    // Seed the failing store with the live identity first.
    const live = await getDeviceKeypair();
    await failing.storeKeypair(live);
    setKeyStore(failing);
    // Re-load through the failing store so it owns the identity.
    __resetDeviceKeypairForTests();
    setKeyStore(failing);
    const before = await getDeviceKeypair();
    await expect(rotateDeviceKey()).rejects.toThrow('keystore wipe exploded');
    const after = await getDeviceKeypair();
    expect(after.publicKey).toEqual(before.publicKey);
  });
});
