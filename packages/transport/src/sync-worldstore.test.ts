// SPDX-License-Identifier: Apache-2.0
// WorldSync against the REAL MemoryEventStore - the second WorldConfirmStore
// implementation. sync.test.ts covers the engine against a fake store; this
// file proves the engine + real store integrate: confirmation sticks,
// getUnconfirmed excludes confirmed/deleted/non-post rows, and an empty
// store makes sync a no-op.

import { toHex, type Hex64, type SignedEvent } from '@airplane/protocol';
import { MemoryEventStore } from '@airplane/storage';
import { makePost } from '../../protocol/src/test-helpers';
import { WorldSync } from './sync';
import type { NostrTransport } from './nostr';

/** Controllable NostrTransport stand-in (mirrors sync.test.ts's). */
class FakeNostr {
  online = true;
  published: SignedEvent[] = [];
  queried: Hex64[][] = [];

  async publish(event: SignedEvent): Promise<string[]> {
    if (!this.online) return [];
    this.published.push(event);
    return ['wss://mock.relay'];
  }

  async queryByIds(ids: Hex64[]): Promise<void> {
    this.queried.push(ids);
  }
}

function makeSync(store: MemoryEventStore, online = true) {
  const nostr = new FakeNostr();
  nostr.online = online;
  const sync = new WorldSync(nostr as unknown as NostrTransport, store);
  return { sync, nostr };
}

/**
 * Posts with a wall-clock createdAt: getUnconfirmed() excludes expired
 * posts, and makePost's default createdAt (Nov 2023) is long expired.
 */
function freshPost(content: string): SignedEvent {
  return makePost(content, Math.floor(Date.now() / 1000));
}

describe('WorldSync over MemoryEventStore', () => {
  test('sync pushes every unconfirmed post held by the real store', async () => {
    const store = new MemoryEventStore();
    const e1 = freshPost('real store 1');
    const e2 = freshPost('real store 2');
    await store.saveEvent(e1);
    await store.saveEvent(e2);

    const { sync, nostr } = makeSync(store);
    const report = await sync.sync();

    expect(report.pushed).toHaveLength(2);
    expect(report.pushed).toEqual(expect.arrayContaining([toHex(e1.id), toHex(e2.id)]));
    expect(report.skipped).toEqual([]);
    expect(nostr.queried).toHaveLength(1);
    expect(nostr.queried[0]).toEqual(expect.arrayContaining([toHex(e1.id), toHex(e2.id)]));
  });

  test('full loop: push -> relay echo via confirmListener -> excluded from next sync', async () => {
    const store = new MemoryEventStore();
    const event = freshPost('round trip');
    await store.saveEvent(event);
    const idHex = toHex(event.id);
    const { sync, nostr } = makeSync(store);

    await sync.sync();
    expect(nostr.published).toHaveLength(1);

    // The relay echo arrives through the confirm listener.
    const forward = sync.confirmListener(() => {});
    await forward(event, 'nostr');
    expect(await store.isWorldConfirmed(idHex)).toBe(true);
    expect(await store.getUnconfirmed()).toEqual([]);

    const report2 = await sync.sync();
    expect(report2.pushed).toEqual([]);
    expect(nostr.published).toHaveLength(1); // nothing re-pushed
  });

  test('empty store: sync returns an empty report and queries nothing', async () => {
    const store = new MemoryEventStore();
    const { sync, nostr } = makeSync(store);
    const report = await sync.sync();
    expect(report).toEqual({ pushed: [], confirmed: [], skipped: [] });
    expect(nostr.queried).toHaveLength(0);
  });

  test('deleted posts are never pushed', async () => {
    const store = new MemoryEventStore();
    const event = freshPost('doomed');
    await store.saveEvent(event);
    await store.markDeleted(toHex(event.id));

    const { sync, nostr } = makeSync(store);
    const report = await sync.sync();
    expect(report.pushed).toEqual([]);
    expect(nostr.published).toHaveLength(0);
    expect(nostr.queried).toHaveLength(0);
  });

  test('confirmListener leaves BLE-sourced events unconfirmed (still syncable)', async () => {
    const store = new MemoryEventStore();
    const event = freshPost('ble arrival');
    await store.saveEvent(event);
    const idHex = toHex(event.id);
    const { sync } = makeSync(store);

    const seen: string[] = [];
    const forward = sync.confirmListener((_e, source) => {
      seen.push(source);
    });
    await forward(event, 'ble');

    expect(await store.isWorldConfirmed(idHex)).toBe(false);
    expect(seen).toEqual(['ble']);
    // Still unconfirmed, so a later sync pushes it.
    expect(await store.getUnconfirmed()).toEqual([idHex]);
  });

  test('markConfirmed is sticky and idempotent on the real store', async () => {
    const store = new MemoryEventStore();
    const { sync } = makeSync(store);
    const id = 'ee'.repeat(32);
    await sync.markConfirmed(id);
    await sync.markConfirmed(id);
    expect(await store.isWorldConfirmed(id)).toBe(true);
  });

  test('sync while offline touches nothing', async () => {
    const store = new MemoryEventStore();
    await store.saveEvent(freshPost('offline post'));
    const { sync, nostr } = makeSync(store, false);
    const report = await sync.sync();
    expect(report.pushed).toEqual([]);
    expect(report.confirmed).toEqual([]);
    expect(nostr.published).toHaveLength(0);
    expect(nostr.queried).toHaveLength(0);
  });

  test('already-confirmed posts are skipped, not re-pushed', async () => {
    const store = new MemoryEventStore();
    const event = freshPost('already out there');
    await store.saveEvent(event);
    const idHex = toHex(event.id);
    await store.markWorldConfirmed(idHex);

    const { sync, nostr } = makeSync(store);
    const report = await sync.sync();
    expect(report.pushed).toEqual([]);
    expect(nostr.published).toHaveLength(0);
  });
});
