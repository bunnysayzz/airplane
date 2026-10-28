// SPDX-License-Identifier: Apache-2.0
// DM P1 tests: sealed round-trip, requests routing, block silent-drop,
// delete-local-only, outbox retry -> Failed after cap, per-conversation FIFO.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  DM_MAX_ATTEMPTS,
  chacha20,
  dmConversationKey,
  dmConversationKeyX,
  dmKeypairFromDeviceSecret,
  dmToHex,
  meshPubkeyToX25519,
  nip44Decrypt,
  nip44Encrypt,
  sealDm,
  unsealDm,
} from './dm';
import {
  DmService,
  FailingDmRelay,
  MemoryDmRelay,
  MemoryDmStore,
  type DmRelayPort,
} from './dmService';

const tick = () => new Promise<void>(r => setTimeout(r, 10));

interface Persona {
  secret: Uint8Array;
  meshHex: string;
  service: DmService;
  store: MemoryDmStore;
}

function makePersona(relay: DmRelayPort, nowRef: { now: number }): Persona {
  const secret = ed25519.utils.randomSecretKey();
  const meshHex = dmToHex(ed25519.getPublicKey(secret));
  const store = new MemoryDmStore();
  const service = new DmService({
    store,
    relay,
    ownKeys: () => dmKeypairFromDeviceSecret(secret),
    ownMeshHex: () => meshHex,
    now: () => nowRef.now,
  });
  return { secret, meshHex, service, store };
}

describe('DM crypto', () => {
  test('Ed25519 -> X25519 conversion is consistent with the derived keypair', () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(secret);
    const dm = dmKeypairFromDeviceSecret(secret);
    expect(dmToHex(dm.publicKey)).toBe(dmToHex(meshPubkeyToX25519(pub)));
  });

  test('conversation keys are symmetric across the pair', () => {
    const a = ed25519.utils.randomSecretKey();
    const b = ed25519.utils.randomSecretKey();
    const ka = dmConversationKey(dmKeypairFromDeviceSecret(a).secretKey, ed25519.getPublicKey(b));
    const kb = dmConversationKey(dmKeypairFromDeviceSecret(b).secretKey, ed25519.getPublicKey(a));
    expect(ka).toEqual(kb);
  });

  test('chacha20 matches node crypto (RFC 8439 construction)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto') as typeof import('crypto');
    const key = Buffer.alloc(32, 7);
    const nonce12 = Buffer.alloc(12, 3);
    const data = Buffer.from('hello dm world, this is a chacha check over 64 bytes..................');
    const nonce16 = Buffer.concat([Buffer.alloc(4, 0), nonce12]);
    const cipher = nodeCrypto.createCipheriv('chacha20', key, nonce16);
    const expected = Buffer.concat([cipher.update(data), cipher.final()]);
    const got = chacha20(new Uint8Array(key), new Uint8Array(nonce12), new Uint8Array(data));
    expect(Buffer.from(got)).toEqual(expected);
  });

  test('NIP-44-style round-trip; tamper and wrong key give null, never text', () => {
    const key = new Uint8Array(32).fill(9);
    const payload = nip44Encrypt('secret hello', key);
    expect(nip44Decrypt(payload, key)).toBe('secret hello');
    const wrongKey = new Uint8Array(32).fill(8);
    expect(nip44Decrypt(payload, wrongKey)).toBeNull();
    // Flip one ciphertext byte (middle of the payload) -> MAC failure.
    const raw = Buffer.from(payload, 'base64');
    raw[40] ^= 0x01;
    expect(nip44Decrypt(raw.toString('base64'), key)).toBeNull();
    expect(nip44Decrypt('not-base64!!', key)).toBeNull();
  });

  test('F18: sealDm lowercases sender and recipient hex', () => {
    const alice = ed25519.utils.randomSecretKey();
    const bob = ed25519.utils.randomSecretKey();
    const aliceHex = dmToHex(ed25519.getPublicKey(alice));
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    const envelope = sealDm('cased', aliceHex.toUpperCase(), bobHex.toUpperCase());
    expect(envelope.recipientHex).toBe(bobHex);
    const rumor = unsealDm(envelope, dmKeypairFromDeviceSecret(bob), bobHex);
    expect(rumor?.pubkey).toBe(aliceHex);
    expect(rumor?.tags).toEqual([['p', bobHex]]);
  });

  test('F11: unseal rejects oversize content, mistagged rumors, and rumors without a p tag', () => {
    const alice = ed25519.utils.randomSecretKey();
    const bob = ed25519.utils.randomSecretKey();
    const aliceHex = dmToHex(ed25519.getPublicKey(alice));
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    const bobKeys = dmKeypairFromDeviceSecret(bob);
    // Oversize content: sealed fine, rejected on ingress.
    const big = sealDm('x'.repeat(5000), aliceHex, bobHex);
    expect(unsealDm(big, bobKeys)).toBeNull();
    // Correct p tag passes, wrong expected recipient fails.
    const ok = sealDm('fine', aliceHex, bobHex);
    expect(unsealDm(ok, bobKeys, bobHex)?.content).toBe('fine');
    expect(unsealDm(ok, bobKeys, 'a'.repeat(64))).toBeNull();
    // A rumor with no p tag at all fails when a recipient is expected.
    const ephemeralSecret = x25519.utils.randomSecretKey();
    const ephemeralPubkey = x25519.getPublicKey(ephemeralSecret);
    const convKey = dmConversationKeyX(ephemeralSecret, meshPubkeyToX25519(ed25519.getPublicKey(bob)));
    const noTag = {
      ephemeralPubkeyHex: dmToHex(ephemeralPubkey),
      recipientHex: bobHex,
      sealed: nip44Encrypt(
        JSON.stringify({ kind: 14, pubkey: aliceHex, created_at: 1000, tags: [], content: 'no tag' }),
        convKey,
      ),
      createdAt: 1000,
    };
    expect(unsealDm(noTag, bobKeys, bobHex)).toBeNull();
  });

  test('sealed round-trip: recipient reads it, relay view and third party get gibberish', () => {
    const alice = ed25519.utils.randomSecretKey();
    const bob = ed25519.utils.randomSecretKey();
    const carol = ed25519.utils.randomSecretKey();
    const aliceHex = dmToHex(ed25519.getPublicKey(alice));
    const bobHex = dmToHex(ed25519.getPublicKey(bob));
    const envelope = sealDm('meet at dawn', aliceHex, bobHex);
    // Relay view: the sealed payload never contains the plaintext.
    expect(envelope.sealed).not.toContain('meet at dawn');
    expect(envelope.recipientHex).toBe(bobHex);
    const rumor = unsealDm(envelope, dmKeypairFromDeviceSecret(bob));
    expect(rumor?.content).toBe('meet at dawn');
    expect(rumor?.pubkey).toBe(aliceHex);
    expect(unsealDm(envelope, dmKeypairFromDeviceSecret(carol))).toBeNull();
    expect(unsealDm(envelope, dmKeypairFromDeviceSecret(alice))).toBeNull();
    // Tampered sealed bytes -> null for everyone, including the recipient.
    const tampered = { ...envelope, sealed: envelope.sealed.slice(0, -4) + 'AAAA' };
    expect(unsealDm(tampered, dmKeypairFromDeviceSecret(bob))).toBeNull();
  });
});

describe('DmService routing + outbox', () => {
  test('unknown sender lands in requests, never inbox; Accept moves it to inbox', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 1_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'hi bob, saw your post');
    await alice.service.flushOutbox();
    await tick();
    expect(await bob.service.listInbox()).toEqual([]);
    const requests = await bob.service.listRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].peerHex).toBe(alice.meshHex);
    expect(requests[0].unread).toBe(1);
    // Thread decrypts on read; last-message preview would use the same path.
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread).toHaveLength(1);
    expect(thread[0].text).toBe('hi bob, saw your post');
    await bob.service.acceptRequest(alice.meshHex);
    expect((await bob.service.listInbox()).map(c => c.peerHex)).toContain(alice.meshHex);
    expect(await bob.service.listRequests()).toEqual([]);
    await bob.service.markRead(alice.meshHex);
    expect(await bob.service.totalUnread()).toBe(0);
  });

  test('Ignore hides the request; the peer writing again re-surfaces it in requests', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 2_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    bob.service.start();
    await bob.service.receiveEnvelope(sealDm('first', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
    await bob.service.ignoreRequest(alice.meshHex);
    expect(await bob.service.listRequests()).toEqual([]);
    expect(await bob.service.listInbox()).toEqual([]);
    await bob.service.receiveEnvelope(sealDm('second', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
  });

  test('block = silent drop of future messages (no row, no badge, no inbox)', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 3_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    bob.service.start();
    await bob.service.blockPeer(alice.meshHex);
    const verdict = await bob.service.receiveEnvelope(sealDm('spam?', alice.meshHex, bob.meshHex));
    expect(verdict).toBe('dropped');
    expect(await bob.service.listInbox()).toEqual([]);
    expect(await bob.service.listRequests()).toEqual([]);
    expect(await bob.service.getThread(alice.meshHex)).toEqual([]);
    expect(await bob.service.totalUnread()).toBe(0);
    await bob.service.unblockPeer(alice.meshHex);
    await bob.service.receiveEnvelope(sealDm('hello again', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
  });

  test('mute: messages arrive but the badge does not move', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 4_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    bob.service.start();
    await bob.service.receiveEnvelope(sealDm('yo', alice.meshHex, bob.meshHex));
    await bob.service.acceptRequest(alice.meshHex);
    await bob.service.markRead(alice.meshHex);
    await bob.service.mutePeer(alice.meshHex, true);
    await bob.service.receiveEnvelope(sealDm('yo again', alice.meshHex, bob.meshHex));
    expect((await bob.service.getThread(alice.meshHex)).length).toBe(2);
    expect(await bob.service.totalUnread()).toBe(0);
  });

  test('delete is local only: sender store emptied, recipient copy intact', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 5_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'will delete this');
    await alice.service.flushOutbox();
    await tick();
    expect((await bob.service.getThread(alice.meshHex)).length).toBe(1);
    await bob.service.deleteConversationLocalOnly(alice.meshHex);
    expect(await bob.service.listInbox()).toEqual([]);
    expect(await bob.service.listRequests()).toEqual([]);
    expect(await bob.service.getThread(alice.meshHex)).toEqual([]);
    expect(await bob.store.getConversation(alice.meshHex)).toBeNull();
    // Recipient-side deletion changed nothing on the sender's device.
    expect((await alice.service.getThread(bob.meshHex)).length).toBe(1);
  });

  test('outbox retry with backoff ends in Failed after the cap, never dropped', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 10_000_000 };
    const alice = makePersona(relay, nowRef);
    await alice.service.sendMessage('b'.repeat(64), 'offline msg');
    // Attempt 1 at t, then backoffs 1s / 5s / 30s / 120s -> 5 attempts total.
    const steps = [0, 1000, 5000, 30000, 120000];
    for (const step of steps) {
      nowRef.now += step;
      await alice.service.flushOutbox();
    }
    const thread = await alice.service.getThread('b'.repeat(64));
    expect(thread).toHaveLength(1);
    expect(thread[0].status).toBe('Failed');
    // Tap-to-retry re-queues it (still failing here, but back to Sending).
    await alice.service.retryMessage('b'.repeat(64), thread[0].id);
    const retried = await alice.service.getThread('b'.repeat(64));
    expect(retried[0].status).toBe('Sending');
    expect(DM_MAX_ATTEMPTS).toBe(5);
  });

  test('per-conversation FIFO: a failed head blocks its conversation only', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 20_000_000 };
    const alice = makePersona(relay, nowRef);
    const peerA = 'a'.repeat(64);
    const peerB = 'c'.repeat(64);
    await alice.service.sendMessage(peerA, 'a-first');
    await alice.service.sendMessage(peerA, 'a-second');
    await alice.service.sendMessage(peerB, 'b-only');
    await alice.service.flushOutbox();
    // All three failed once; FIFO means a-second was never attempted while
    // a-first was the failing head — observable via attempts on the rows.
    const rowsA = await alice.store.listMessages(peerA);
    const rowsB = await alice.store.listMessages(peerB);
    expect(rowsA.find(m => m.direction === 'out' && m.createdAtMs === rowsA[0].createdAtMs)).toBeDefined();
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(1);
    // The second message in conversation A is still queued (Sending, 0 attempts).
    const second = rowsA[1];
    expect(second.status).toBe('Sending');
    expect(second.attempts).toBe(0);
    expect(rowsB[0].attempts).toBe(1); // conversation B was not blocked by A
  });

  test('send order is preserved end to end on the relay path', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 30_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    alice.service.start();
    bob.service.start();
    await alice.service.sendMessage(bob.meshHex, 'one');
    await alice.service.sendMessage(bob.meshHex, 'two');
    await alice.service.sendMessage(bob.meshHex, 'three');
    await alice.service.flushOutbox();
    await tick();
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread.map(t => t.text)).toEqual(['one', 'two', 'three']);
    const sent = await alice.service.getThread(bob.meshHex);
    expect(sent.map(t => t.status)).toEqual(['Sent', 'Sent', 'Sent']);
  });

  test('validation: bad peer hex, self-DM, empty and over-cap text are rejected', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 40_000_000 };
    const alice = makePersona(relay, nowRef);
    await expect(alice.service.sendMessage('xyz', 'hi')).rejects.toThrow();
    await expect(alice.service.sendMessage(alice.meshHex, 'hi')).rejects.toThrow();
    await expect(alice.service.sendMessage('d'.repeat(64), '')).rejects.toThrow();
    await expect(alice.service.sendMessage('d'.repeat(64), 'x'.repeat(5000))).rejects.toThrow();
  });

  test('P1-06: repeat delivery of the same relay event id renders once', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 50_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const envelope = sealDm('same text twice', alice.meshHex, bob.meshHex);
    const delivered = { ...envelope, relayEventId: 'relay-event-1' };
    expect(await bob.service.receiveEnvelope(delivered)).toBe('request');
    expect(await bob.service.receiveEnvelope(delivered)).toBe('ignored');
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread).toHaveLength(1);
    const convs = await bob.service.listRequests();
    expect(convs[0].unread).toBe(1);
    // Identical text under a different event id is a distinct message.
    const second = { ...sealDm('same text twice', alice.meshHex, bob.meshHex), relayEventId: 'relay-event-2' };
    expect(await bob.service.receiveEnvelope(second)).toBe('request');
    expect(await bob.service.getThread(alice.meshHex)).toHaveLength(2);
  });

  test('P1-12: own send to an ignored request promotes it to inbox', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 70_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    // Bob receives from unknown alice, then ignores the request.
    await bob.service.receiveEnvelope(sealDm('hey', alice.meshHex, bob.meshHex));
    await bob.service.ignoreRequest(alice.meshHex);
    expect(await bob.service.listRequests()).toHaveLength(0);
    expect(await bob.service.listInbox()).toHaveLength(0);
    // Bob now messages alice first: the conversation must surface in inbox.
    await bob.service.sendMessage(alice.meshHex, 'actually hi');
    const inbox = await bob.service.listInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].peerHex).toBe(alice.meshHex);
    expect(inbox[0].ignored).toBe(false);
  });

  test('F6: thread orders by sender time, not arrival time', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 80_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    const late = sealDm('sent later', alice.meshHex, bob.meshHex, 2000);
    const early = sealDm('sent earlier', alice.meshHex, bob.meshHex, 1000);
    await bob.service.receiveEnvelope(late);
    await bob.service.receiveEnvelope(early);
    const thread = await bob.service.getThread(alice.meshHex);
    expect(thread.map(t => t.text)).toEqual(['sent earlier', 'sent later']);
  });

  test('F7: blocking fails queued Sending rows so they can be retried after unblock', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 90_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'f'.repeat(64);
    await alice.service.sendMessage(peer, 'queued when blocked');
    let rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Sending');
    await alice.service.blockPeer(peer);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Failed');
    // Unblock, then tap-to-retry re-queues the row.
    await alice.service.unblockPeer(peer);
    await alice.service.retryMessage(peer, rows[0].id);
    rows = await alice.store.listMessages(peer);
    expect(rows[0].status).toBe('Sending');
  });

  test('F8: unblock from a request restores the request, not inbox', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 95_000_000 };
    const alice = makePersona(relay, nowRef);
    const bob = makePersona(relay, nowRef);
    await bob.service.receiveEnvelope(sealDm('stranger hi', alice.meshHex, bob.meshHex));
    expect(await bob.service.listRequests()).toHaveLength(1);
    await bob.service.blockPeer(alice.meshHex);
    await bob.service.unblockPeer(alice.meshHex);
    expect(await bob.service.listInbox()).toHaveLength(0);
    expect(await bob.service.listRequests()).toHaveLength(1);
    // And an inbox conversation still restores to inbox.
    await bob.service.acceptRequest(alice.meshHex);
    await bob.service.blockPeer(alice.meshHex);
    await bob.service.unblockPeer(alice.meshHex);
    expect(await bob.service.listInbox()).toHaveLength(1);
  });

  test('F14-retry: concurrent flushes share one run and publish once', async () => {
    class DelayedCountingRelay implements DmRelayPort {
      calls = 0;
      async publish(): Promise<boolean> {
        this.calls += 1;
        await new Promise(r => setTimeout(r, 30));
        return true;
      }
      subscribe(): () => void {
        return () => {};
      }
    }
    const relay = new DelayedCountingRelay();
    const nowRef = { now: 100_000_000 };
    const alice = makePersona(relay, nowRef);
    await alice.service.sendMessage('a'.repeat(64), 'guard me');
    await Promise.all([alice.service.flushOutbox(), alice.service.flushOutbox()]);
    expect(relay.calls).toBe(1);
    const rows = await alice.store.listMessages('a'.repeat(64));
    expect(rows[0].status).toBe('Sent');
    alice.service.stop();
  });

  test('F15: missing-envelope rows fail fast instead of head-blocking the queue', async () => {
    const relay = new FailingDmRelay();
    const nowRef = { now: 110_000_000 };
    const alice = makePersona(relay, nowRef);
    const peer = 'b'.repeat(64);
    await alice.service.sendMessage(peer, 'first after restart');
    await alice.service.sendMessage(peer, 'second after restart');
    alice.service.stop();
    // A fresh service over the same store simulates a restart: the
    // in-memory outbox envelopes are gone, but the rows survive here.
    const restarted = new DmService({
      store: alice.store,
      relay,
      ownKeys: () => dmKeypairFromDeviceSecret(alice.secret),
      ownMeshHex: () => alice.meshHex,
      now: () => nowRef.now,
    });
    await restarted.flushOutbox();
    const rows = await alice.store.listMessages(peer);
    expect(rows.map(r => r.status)).toEqual(['Failed', 'Failed']);
    restarted.stop();
  });

  test('F16: per-conversation message lists cap with oldest eviction', async () => {
    const store = new MemoryDmStore();
    const peer = 'd'.repeat(64);
    for (let i = 0; i < 1005; i++) {
      await store.addMessage({
        id: `msg-${i}`,
        peerHex: peer,
        direction: 'in',
        sealed: 'sealed',
        createdAtMs: i,
        status: 'Sent',
        attempts: 0,
        nextAttemptAtMs: i,
      });
    }
    const rows = await store.listMessages(peer);
    expect(rows).toHaveLength(1000);
    expect(rows[0].id).toBe('msg-5');
    expect(rows[rows.length - 1].id).toBe('msg-1004');
  });

  test('F24: garbage peer ids are rejected before any row is created', async () => {
    const relay = new MemoryDmRelay();
    const nowRef = { now: 120_000_000 };
    const alice = makePersona(relay, nowRef);
    await expect(alice.service.blockPeer('garbage')).rejects.toThrow();
    await expect(alice.service.unblockPeer('garbage')).rejects.toThrow();
    await expect(alice.service.mutePeer('garbage', true)).rejects.toThrow();
    await expect(alice.service.acceptRequest('garbage')).rejects.toThrow();
    await expect(alice.service.ignoreRequest('garbage')).rejects.toThrow();
    await expect(alice.service.deleteConversationLocalOnly('garbage')).rejects.toThrow();
    await expect(alice.service.markRead('garbage')).rejects.toThrow();
    await expect(alice.service.getThread('garbage')).rejects.toThrow();
    await expect(alice.service.getConversation('garbage')).rejects.toThrow();
    await expect(alice.service.previewFor('garbage')).rejects.toThrow();
    await expect(alice.service.retryMessage('garbage', 'nope')).rejects.toThrow();
    expect(await alice.service.listBlocked()).toHaveLength(0);
    expect(await alice.service.listInbox()).toHaveLength(0);
  });

  test('P1-09: the flush scheduler re-arms on the backoff and drains without user action', async () => {
    jest.useFakeTimers();
    try {
      const relay = new FailingDmRelay();
      const nowRef = { now: 60_000_000 };
      const alice = makePersona(relay, nowRef);
      alice.service.start();
      await alice.service.sendMessage('e'.repeat(64), 'scheduler please');
      const microtasks = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      };
      await microtasks();
      // The send scheduled a due-now flush; firing it attempts once.
      await jest.advanceTimersByTimeAsync(0);
      await microtasks();
      let rows = await alice.store.listMessages('e'.repeat(64));
      expect(rows[0].attempts).toBe(1);
      expect(rows[0].status).toBe('Sending');
      // Move the fake clock past the 1000ms backoff and fire the re-armed timer.
      nowRef.now += 1000;
      await jest.advanceTimersByTimeAsync(1000);
      await microtasks();
      rows = await alice.store.listMessages('e'.repeat(64));
      expect(rows[0].attempts).toBe(2);
      alice.service.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
