// SPDX-License-Identifier: Apache-2.0
// Saved messages tests: durable local only storage, and the hard privacy
// rule: saving a note must never produce a relay publish, a DM row, or a
// log line carrying the note text.

import { ed25519 } from '@noble/curves/ed25519.js';
import { MemoryKv } from '@airplane/storage';
import {
  DmService,
  MemoryDmRelay,
  MemoryDmStore,
  dmKeypairFromDeviceSecret,
  dmToHex,
  type DmRelayPublishResult,
} from '@airplane/transport';
import {
  SELF_MESSAGES_KEY,
  SELF_MESSAGE_MAX_BYTES,
  SelfMessageStore,
  getSelfMessageStore,
  __resetSelfMessageStoreForTests,
  __setSelfMessageStoreForTests,
} from './selfMessages';
import { __resetKvForTests, __setKvForTests } from './kv';
import {
  recordUiEvent,
  resetDiagnosticsForTests,
  setDiagnosticsLogSink,
} from './diagnostics';

afterEach(() => {
  __resetSelfMessageStoreForTests();
  __resetKvForTests();
  setDiagnosticsLogSink(null);
  resetDiagnosticsForTests();
});

/** Relay that counts every publish call, so a zero is a live zero. */
class CountingRelay extends MemoryDmRelay {
  publishCalls = 0;

  override async publish(envelope: Parameters<MemoryDmRelay['publish']>[0]): Promise<DmRelayPublishResult> {
    this.publishCalls += 1;
    return super.publish(envelope);
  }
}

describe('SelfMessageStore', () => {
  test('save and list round trip in chronological order', async () => {
    const store = new SelfMessageStore(new MemoryKv(), () => 1000);
    const first = await store.save('first note');
    const second = await store.save('second note');
    const list = await store.list();
    expect(list.map(m => m.text)).toEqual(['first note', 'second note']);
    expect(list.map(m => m.id)).toEqual([first.id, second.id]);
    expect(list[0].createdAtMs).toBe(1000);
  });

  test('empty and oversize notes throw and store nothing', async () => {
    const store = new SelfMessageStore(new MemoryKv());
    await expect(store.save('   ')).rejects.toThrow('self message is empty');
    await expect(store.save('x'.repeat(SELF_MESSAGE_MAX_BYTES + 1))).rejects.toThrow('longer than');
    expect(await store.list()).toEqual([]);
  });

  test('delete removes one note, deleteAll removes every note', async () => {
    const store = new SelfMessageStore(new MemoryKv());
    const first = await store.save('keep me out');
    await store.save('second');
    await store.delete(first.id);
    expect((await store.list()).map(m => m.text)).toEqual(['second']);
    await store.delete('missing-id');
    expect((await store.list()).map(m => m.text)).toEqual(['second']);
    await store.deleteAll();
    expect(await store.list()).toEqual([]);
  });

  test('notes survive a store recreation over the same KV (app restart)', async () => {
    const kv = new MemoryKv();
    const before = new SelfMessageStore(kv);
    await before.save('survives restart');
    // A new store instance over the same durable KV is what an app
    // restart looks like: the singleton and the memory are gone, the
    // KV file is not.
    const after = new SelfMessageStore(kv);
    expect((await after.list()).map(m => m.text)).toEqual(['survives restart']);
  });

  test('a corrupt KV row reads as empty and the next save replaces it', async () => {
    const kv = new MemoryKv();
    await kv.set(SELF_MESSAGES_KEY, 'not json at all');
    const store = new SelfMessageStore(kv);
    expect(await store.list()).toEqual([]);
    await store.save('fresh after corruption');
    expect((await store.list()).map(m => m.text)).toEqual(['fresh after corruption']);
  });

  test('the app singleton persists over the shared KV port', async () => {
    const kv = new MemoryKv();
    __setKvForTests(kv);
    await getSelfMessageStore().save('via singleton');
    __resetSelfMessageStoreForTests();
    __setSelfMessageStoreForTests(new SelfMessageStore(kv));
    expect((await getSelfMessageStore().list()).map(m => m.text)).toEqual(['via singleton']);
  });
});

describe('self messages never enter a send path', () => {
  test('saving notes produces no relay publish and no DM conversation', async () => {
    const relay = new CountingRelay();
    const secret = ed25519.utils.randomSecretKey();
    const ownHex = dmToHex(ed25519.getPublicKey(secret));
    const service = new DmService({
      store: new MemoryDmStore(),
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(secret),
      ownMeshHex: () => ownHex,
    });
    service.start();
    const selfStore = new SelfMessageStore(new MemoryKv());
    await selfStore.save('a secret note that must stay on this phone');
    await selfStore.save('another private note');
    await service.flushOutbox();
    expect(relay.publishCalls).toBe(0);
    expect(await service.listInbox()).toEqual([]);
    expect(await service.getThread(ownHex)).toEqual([]);
    expect((await selfStore.list()).map(m => m.text)).toEqual([
      'a secret note that must stay on this phone',
      'another private note',
    ]);
    // Sanity: the counter is live, a real DM send does hit the relay.
    const peerSecret = ed25519.utils.randomSecretKey();
    const peerHex = dmToHex(ed25519.getPublicKey(peerSecret));
    await service.sendMessage(peerHex, 'a real dm');
    await service.flushOutbox();
    expect(relay.publishCalls).toBeGreaterThan(0);
    service.stop();
  });

  test('self UI actions log action names only, never note text', async () => {
    const lines: string[] = [];
    setDiagnosticsLogSink((_kind, detail) => {
      lines.push(detail);
    });
    const note = 'my private note text must not appear in logs';
    const store = new SelfMessageStore(new MemoryKv());
    await store.save(note);
    // The Saved thread logs exactly what every other screen logs: the
    // action name, with no target and no content argument.
    recordUiEvent('self:open');
    recordUiEvent('self:save');
    recordUiEvent('self:delete');
    expect(lines).toEqual(['tap self:open', 'tap self:save', 'tap self:delete']);
    expect(lines.join('\n')).not.toContain(note);
  });
});
