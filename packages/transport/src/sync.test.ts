// SPDX-License-Identifier: Apache-2.0
// WorldSync tests. Storage and Nostr are mocked; no network.

import { toHex, type Hex64, type SignedEvent } from '@airplane/protocol';
import { makePost } from '../../protocol/src/test-helpers';
import { WorldSync, type WorldConfirmStore } from './sync';

/** In-memory WorldConfirmStore for tests. */
class FakeConfirmStore implements WorldConfirmStore {
  readonly events = new Map<Hex64, SignedEvent>();
  readonly confirmed = new Set<Hex64>();

  add(event: SignedEvent): Hex64 {
    const idHex = toHex(event.id);
    this.events.set(idHex, event);
    return idHex;
  }

  async markWorldConfirmed(eventId: Hex64): Promise<void> {
    this.confirmed.add(eventId.toLowerCase());
  }

  async isWorldConfirmed(eventId: Hex64): Promise<boolean> {
    return this.confirmed.has(eventId.toLowerCase());
  }

  async getUnconfirmed(): Promise<Hex64[]> {
    return [...this.events.keys()].filter((id) => !this.confirmed.has(id));
  }

  async getEvent(id: Hex64): Promise<SignedEvent | null> {
    return this.events.get(id.toLowerCase()) ?? null;
  }
}

/** Mock NostrTransport: controllable online state, records publishes. */
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

describe('WorldSync', () => {
  test('sync pushes unconfirmed posts and queries their ids', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);

    const e1 = makePost('sync me 1');
    const e2 = makePost('sync me 2');
    const id1 = store.add(e1);
    const id2 = store.add(e2);

    const report = await sync.sync();
    expect(report.pushed).toEqual(expect.arrayContaining([id1, id2]));
    expect(report.skipped).toEqual([]);
    expect(nostr.published).toHaveLength(2);
    expect(nostr.queried).toHaveLength(1);
    expect(nostr.queried[0]).toEqual(expect.arrayContaining([id1, id2]));
  });

  test('sync is a no-op when offline', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    nostr.online = false;
    const sync = new WorldSync(nostr as never, store);

    store.add(makePost('offline post'));
    const report = await sync.sync();
    expect(report.pushed).toEqual([]);
    expect(report.confirmed).toEqual([]);
    expect(nostr.published).toHaveLength(0);
    expect(nostr.queried).toHaveLength(0);
  });

  test('already-confirmed posts are skipped', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);

    const id = store.add(makePost('already there'));
    await store.markWorldConfirmed(id);

    const report = await sync.sync();
    expect(report.pushed).toEqual([]);
    // getUnconfirmed excludes it, so nothing is queried either.
    expect(nostr.queried).toHaveLength(0);
  });

  test('missing local event is skipped, not published', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);

    // getUnconfirmed returns an id whose event is gone (e.g. pruned).
    const ghostId = 'cc'.repeat(32);
    const origUnconfirmed = store.getUnconfirmed.bind(store);
    store.getUnconfirmed = async () => [...(await origUnconfirmed()), ghostId];

    const report = await sync.sync();
    expect(report.skipped).toContain(ghostId);
    expect(nostr.published).toHaveLength(0);
  });

  test('confirmListener marks nostr-sourced events confirmed', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);

    const seen: string[] = [];
    const wrapped = sync.confirmListener((e, source) => {
      seen.push(source);
    });

    const event = makePost('observed on relay');
    const idHex = toHex(event.id);
    expect(await store.isWorldConfirmed(idHex)).toBe(false);

    await wrapped(event, 'nostr');
    expect(await store.isWorldConfirmed(idHex)).toBe(true);
    expect(seen).toEqual(['nostr']);

    // BLE-sourced events are NOT auto-confirmed.
    const bleEvent = makePost('ble only');
    await wrapped(bleEvent, 'ble');
    expect(await store.isWorldConfirmed(toHex(bleEvent.id))).toBe(false);
    expect(seen).toEqual(['nostr', 'ble']);
  });

  test('markConfirmed is sticky and idempotent', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);
    const id = 'dd'.repeat(32);

    await sync.markConfirmed(id);
    await sync.markConfirmed(id); // no throw, still confirmed
    expect(await store.isWorldConfirmed(id)).toBe(true);
  });

  test('sync is idempotent across runs (second run pushes nothing new)', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);

    const id = store.add(makePost('once'));
    await sync.sync();
    // Simulate the relay echo confirming it.
    await store.markWorldConfirmed(id);

    const report2 = await sync.sync();
    expect(report2.pushed).toEqual([]);
    expect(nostr.published).toHaveLength(1); // only the first run published
  });
});
