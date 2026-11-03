// SPDX-License-Identifier: Apache-2.0
// Compose draft persistence tests (transport-matrix rank 12).
//
// No draft text is asserted through any log or publish path here: the
// store only ever touches the KV port, and these tests assert KV contents.

import { MemoryKv } from '@airplane/storage';
import {
  COMPOSE_DRAFT_KEY,
  COMPOSE_DRAFT_MAX_LENGTH,
  ComposeDraftStore,
  __resetComposeDraftStoreForTests,
  __setComposeDraftStoreForTests,
  getComposeDraftStore,
} from './composeDraft';

afterEach(() => {
  __resetComposeDraftStoreForTests();
});

describe('ComposeDraftStore', () => {
  test('loads empty when nothing was saved', async () => {
    const store = new ComposeDraftStore(new MemoryKv());
    await expect(store.load()).resolves.toBe('');
  });

  test('save then load round-trips the draft (the kill-during-race restore)', async () => {
    const kv = new MemoryKv();
    const store = new ComposeDraftStore(kv);
    await store.save('hello from the compose sheet');
    await expect(store.load()).resolves.toBe('hello from the compose sheet');
    await expect(kv.get(COMPOSE_DRAFT_KEY)).resolves.toBe('hello from the compose sheet');
  });

  test('saving an empty draft deletes the key', async () => {
    const kv = new MemoryKv();
    const store = new ComposeDraftStore(kv);
    await store.save('something');
    await store.save('');
    await expect(store.load()).resolves.toBe('');
    await expect(kv.get(COMPOSE_DRAFT_KEY)).resolves.toBeNull();
  });

  test('clear removes the draft (publish success and explicit Discard share this path)', async () => {
    const kv = new MemoryKv();
    const store = new ComposeDraftStore(kv);
    await store.save('about to be published');
    await store.clear();
    await expect(store.load()).resolves.toBe('');
    await expect(kv.get(COMPOSE_DRAFT_KEY)).resolves.toBeNull();
  });

  test('overlong drafts are capped at the compose input limit on save and load', async () => {
    const kv = new MemoryKv();
    const store = new ComposeDraftStore(kv);
    const long = 'x'.repeat(COMPOSE_DRAFT_MAX_LENGTH + 50);
    await store.save(long);
    await expect(store.load()).resolves.toBe('x'.repeat(COMPOSE_DRAFT_MAX_LENGTH));
    await kv.set(COMPOSE_DRAFT_KEY, long);
    await expect(store.load()).resolves.toBe('x'.repeat(COMPOSE_DRAFT_MAX_LENGTH));
  });

  test('a later save overwrites the earlier draft, so the newest keystroke wins', async () => {
    const store = new ComposeDraftStore(new MemoryKv());
    await store.save('first');
    await store.save('second');
    await expect(store.load()).resolves.toBe('second');
  });
});

describe('getComposeDraftStore singleton', () => {
  test('returns the fake installed by __setComposeDraftStoreForTests', async () => {
    const fake = new ComposeDraftStore(new MemoryKv());
    __setComposeDraftStoreForTests(fake);
    expect(getComposeDraftStore()).toBe(fake);
    await getComposeDraftStore().save('via singleton');
    await expect(fake.load()).resolves.toBe('via singleton');
  });
});
