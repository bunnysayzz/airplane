// SPDX-License-Identifier: Apache-2.0
// WorldSync tests. Storage and Nostr are mocked; no network.

import { toHex, type Hex64, type SignedEvent } from '@airplane/protocol';
import { makePost } from '../../protocol/src/test-helpers';
import { WorldSync, SYNC_PUSH_MIN_INTERVAL_MS, type WorldConfirmStore } from './sync';

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
  /** When false, sends succeed but no relay ever OKs (silent drop). */
  ackOk = true;
  published: SignedEvent[] = [];
  queried: Hex64[][] = [];

  async publish(event: SignedEvent): Promise<string[]> {
    if (!this.online) return [];
    this.published.push(event);
    return ['wss://mock.relay'];
  }

  async publishWithAck(event: SignedEvent): Promise<{ ok: string[]; rejected: string[]; timedOut: boolean }> {
    if (!this.online) return { ok: [], rejected: [], timedOut: false };
    this.published.push(event);
    return this.ackOk
      ? { ok: ['wss://mock.relay'], rejected: [], timedOut: false }
      : { ok: [], rejected: [], timedOut: true };
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

  test('onPushed fires with the pushed events after the push phase', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const pushed: SignedEvent[][] = [];
    const sync = new WorldSync(nostr as never, store, { onPushed: (events) => pushed.push(events) });

    const e1 = makePost('push hook 1');
    store.add(e1);

    const report = await sync.sync();
    expect(report.pushed).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toHaveLength(1);
    expect(pushed[0][0]).toBe(e1);
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

  test('confirmListener forwards even when the confirmation write fails', async () => {
    const store = new FakeConfirmStore();
    store.markWorldConfirmed = async () => {
      throw new Error('store gone');
    };
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);
    const forwarded: string[] = [];
    const wrapped = sync.confirmListener((e, source) => {
      forwarded.push(source);
    });
    await expect(wrapped(makePost('deliver anyway'), 'nostr')).resolves.toBeUndefined();
    expect(forwarded).toEqual(['nostr']);
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

  test('an unconfirmed event is pushed at most once per minute while unconfirmed', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);
    const id = store.add(makePost('throttled'));

    // Control the clock: the throttle window is 60 s of real time.
    const nowSpy = jest.spyOn(Date, 'now');
    let nowMs = 1_700_000_000_000;
    nowSpy.mockImplementation(() => nowMs);
    try {
      // First pass pushes immediately (never pushed before).
      const r1 = await sync.sync();
      expect(r1.pushed).toEqual([id]);
      expect(nostr.published).toHaveLength(1);
      // The v0.1.31 shape: a relay-win pass, a health pass 1 s later,
      // and another pass 0.3 s after that pushed the same event three
      // times in 1.3 s. With the throttle, later passes push nothing
      // new while the event stays unconfirmed.
      nowMs += 1_000;
      expect((await sync.sync()).pushed).toEqual([]);
      nowMs += 300;
      expect((await sync.sync()).pushed).toEqual([]);
      expect(nostr.published).toHaveLength(1);
      // Past the window the event is pushed again.
      nowMs += SYNC_PUSH_MIN_INTERVAL_MS;
      expect((await sync.sync()).pushed).toEqual([id]);
      expect(nostr.published).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('concurrent sync calls share one in-flight pass, not two pushes', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);
    store.add(makePost('overlap 1'));
    store.add(makePost('overlap 2'));
    const [r1, r2] = await Promise.all([sync.sync(), sync.sync()]);
    expect(r1.pushed).toEqual(r2.pushed);
    expect(nostr.published).toHaveLength(2);
    expect(nostr.queried).toHaveLength(1);
  });

  test('a pass is bounded: a backlog larger than the cap waits for later passes', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);
    for (let i = 0; i < 60; i++) store.add(makePost(`backlog ${i}`));
    const report = await sync.sync();
    expect(report.pushed).toHaveLength(50);
    expect(nostr.queried[0]).toHaveLength(50);
  });

  test('send success without a relay OK is not reported as pushed', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    nostr.ackOk = false;
    const sync = new WorldSync(nostr as never, store);
    const id = store.add(makePost('silent drop'));
    const report = await sync.sync();
    expect(report.pushed).toEqual([]);
    expect(nostr.queried[0]).toContain(id);
  });

  test('confirmation persists across WorldSync restarts sharing a store', async () => {
    // The durable store (SQLite on device) outlives the engine: a restart is
    // a brand-new WorldSync on the same store. Confirmations must survive.
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const before = new WorldSync(nostr as never, store);

    const id = store.add(makePost('confirmed before restart'));
    // Confirm via the relay-observed path (what confirmListener calls).
    await before.markConfirmed(id);
    expect(await store.isWorldConfirmed(id)).toBe(true);

    // "Restart": drop the engine, build a fresh one on the same store.
    const after = new WorldSync(nostr as never, store);
    const report = await after.sync();
    expect(report.pushed).toEqual([]); // confirmed posts are never re-pushed
    expect(nostr.published).toHaveLength(0);
    expect(await store.isWorldConfirmed(id)).toBe(true); // still there
  });

  test('confirmListener still forwards when confirmation storage fails', async () => {
    const store = new FakeConfirmStore();
    store.markWorldConfirmed = async () => {
      throw new Error('disk full');
    };
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);
    const forwarded: string[] = [];
    const wrapped = sync.confirmListener((event, source) => {
      forwarded.push(source);
    });
    await expect(wrapped(makePost('relay observed'), 'nostr')).resolves.toBeUndefined();
    expect(forwarded).toEqual(['nostr']);
  });

  test('confirmListener-wrapped handler survives and still forwards events', async () => {
    const store = new FakeConfirmStore();
    const nostr = new FakeNostr();
    const sync = new WorldSync(nostr as never, store);

    const forwarded: { id: Hex64; source: string }[] = [];
    const wrapped = sync.confirmListener((event, source) => {
      forwarded.push({ id: toHex(event.id), source });
    });

    const event = makePost('relay observed');
    const id = store.add(event);
    wrapped(event, 'nostr');
    // confirmListener is async: flush.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(await store.isWorldConfirmed(id)).toBe(true);
    expect(forwarded).toEqual([{ id, source: 'nostr' }]);

    // A second, fresh engine on the same store never re-pushes it.
    const restarted = new WorldSync(nostr as never, store);
    const report = await restarted.sync();
    expect(report.pushed).toEqual([]);
    expect(nostr.published).toHaveLength(0);
  });
});

