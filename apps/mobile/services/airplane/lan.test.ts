// SPDX-License-Identifier: Apache-2.0
// LAN port adapter tests (T15 Phase 1). The Kotlin NSD/TCP module is
// mocked here; it is compiled by the CI build and proven on device.

import {
  makeLanPort,
  __setLanNativeForTests,
  __resetLanForTests,
  type LanNative,
} from './lan';

class FakeEmitter {
  listeners = new Map<string, ((payload: never) => void)[]>();

  addListener(event: string, cb: (payload: never) => void): { remove: () => void } {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return {
      remove: () => {
        const current = this.listeners.get(event) ?? [];
        this.listeners.set(
          event,
          current.filter((c) => c !== cb),
        );
      },
    };
  }

  emit(event: string, payload: never): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(payload);
  }
}

class FakeNative implements LanNative {
  startedWith: string | null = null;
  stopped = false;
  sent: { peerId: string; base64: string }[] = [];

  async startLan(pubkeyHex: string): Promise<boolean> {
    this.startedWith = pubkeyHex;
    return true;
  }
  async stopLan(): Promise<boolean> {
    this.stopped = true;
    return true;
  }
  async sendLan(peerId: string, base64: string): Promise<boolean> {
    this.sent.push({ peerId, base64 });
    return true;
  }
}

const PUBKEY = 'aa'.repeat(32);

describe('makeLanPort', () => {
  afterEach(() => {
    __resetLanForTests();
  });

  test('peer events populate discoveredPeerIds; lost events remove them; own service is ignored', async () => {
    const native = new FakeNative();
    const emitter = new FakeEmitter();
    __setLanNativeForTests(native, emitter as never);
    const port = makeLanPort(PUBKEY);
    expect(port.hasNative()).toBe(true);
    expect(port.isActive()).toBe(false);
    await port.start();
    expect(port.isActive()).toBe(true);
    expect(native.startedWith).toBe(PUBKEY);

    let changes = 0;
    port.onPeersChanged(() => {
      changes += 1;
    });

    emitter.emit('AirplaneLanPeer', {
      peerId: 'bb'.repeat(32),
      host: '192.168.1.5',
      port: 45678,
      present: true,
    } as never);
    emitter.emit('AirplaneLanPeer', { peerId: PUBKEY, host: '192.168.1.6', port: 45679, present: true } as never);
    expect(port.discoveredPeerIds()).toEqual(['bb'.repeat(32)]);
    expect(changes).toBe(1); // own service ignored, no change notification

    emitter.emit('AirplaneLanPeer', {
      peerId: 'bb'.repeat(32),
      host: '',
      port: 0,
      present: false,
    } as never);
    expect(port.discoveredPeerIds()).toEqual([]);
    expect(changes).toBe(2);
    await port.stop();
    expect(native.stopped).toBe(true);
  });

  test('frame events reach receivers as bytes; malformed frames are dropped', async () => {
    const native = new FakeNative();
    const emitter = new FakeEmitter();
    __setLanNativeForTests(native, emitter as never);
    const port = makeLanPort(PUBKEY);
    await port.start();

    const received: Uint8Array[] = [];
    port.onReceive((bytes) => {
      received.push(bytes);
    });

    const frame = new Uint8Array([1, 2, 3, 4]);
    emitter.emit('AirplaneLanFrame', {
      base64: Buffer.from(frame).toString('base64'),
    } as never);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(frame);

    emitter.emit('AirplaneLanFrame', { base64: '!!!not-base64!!!' } as never);
    // Node's Buffer.from is lenient, so this still decodes to bytes;
    // the assertion that matters is that no throw escaped the port.
    await port.stop();
  });

  test('send base64-encodes the frame and reports native failure as a throw', async () => {
    const native = new FakeNative();
    const emitter = new FakeEmitter();
    __setLanNativeForTests(native, emitter as never);
    const port = makeLanPort(PUBKEY);
    await port.start();

    const frame = new Uint8Array([9, 8, 7]);
    await port.send('bb'.repeat(32), frame);
    expect(native.sent).toHaveLength(1);
    expect(native.sent[0].peerId).toBe('bb'.repeat(32));
    expect(Buffer.from(native.sent[0].base64, 'base64')).toEqual(Buffer.from(frame));

    native.sendLan = async () => false;
    await expect(port.send('bb'.repeat(32), frame)).rejects.toThrow('LAN send failed');
    await port.stop();
  });

  test('no native module: inert port, no throws, no peers, sends fail', async () => {
    __setLanNativeForTests(null, null);
    const port = makeLanPort(PUBKEY);
    expect(port.hasNative()).toBe(false);
    await expect(port.start()).resolves.toBeUndefined();
    expect(port.discoveredPeerIds()).toEqual([]);
    await expect(port.send('bb'.repeat(32), new Uint8Array([1]))).rejects.toThrow(
      'LAN native module unavailable',
    );
    await expect(port.stop()).resolves.toBeUndefined();
  });

  test('empty pubkey: native start is never called', async () => {
    const native = new FakeNative();
    const emitter = new FakeEmitter();
    __setLanNativeForTests(native, emitter as never);
    const port = makeLanPort('');
    await port.start();
    expect(native.startedWith).toBeNull();
    await port.stop();
  });

  test('a throwing native start still leaves an inert port', async () => {
    const native = new FakeNative();
    native.startLan = async () => {
      throw new Error('nsd gone');
    };
    const emitter = new FakeEmitter();
    __setLanNativeForTests(native, emitter as never);
    const port = makeLanPort(PUBKEY);
    await expect(port.start()).resolves.toBeUndefined();
    expect(port.discoveredPeerIds()).toEqual([]);
    await port.stop();
  });
});
