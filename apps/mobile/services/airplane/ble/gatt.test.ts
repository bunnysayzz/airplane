// SPDX-License-Identifier: Apache-2.0
// GattBlePort tests with fake native adapters (no radio, no native modules).
// Covers: advertise/scan lifecycle, tie-break auto-connect, identity
// exchange both directions, MTU-aware ATT chunking, datagram reassembly,
// provisional peer ids, disconnect/close, and fail-closed null adapters.
// A final block verifies the real adapter delegation with jest.mock factories.

import { toHex } from '@airplane/protocol';
import {
  GattBlePort,
  defaultBleDeps,
  type BleNativeDeps,
  type CentralAdapter,
  type PeripheralAdapter,
} from './gatt';
import {
  ATT_DEFAULT_MTU,
  ATT_OVERHEAD,
  DATAGRAM_FRAME,
  DATAGRAM_HELLO,
  DatagramReassembler,
  chunkBytes,
  encodeDatagram,
  encodeHello,
  parseHello,
  peerTagOf,
} from './profile';

const OWN_PUB = new Uint8Array(32).fill(0x0a);
const PEER_PUB = new Uint8Array(32).fill(0x0b);
const SMALLER_PUB = new Uint8Array(32).fill(0x09); // tag sorts below ours
const OWN_HEX = toHex(OWN_PUB);
const PEER_HEX = toHex(PEER_PUB);
const PEER_TAG = peerTagOf(PEER_PUB);

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

/** Fake central-role adapter (ble-manager shaped). */
class FakeCentral implements CentralAdapter {
  started = false;
  scanning = false;
  discoverCb: ((info: { id: string; rssi: number; tag: Uint8Array | null }) => void) | null = null;
  notifyCb: ((ev: { id: string; value: Uint8Array }) => void) | null = null;
  disconnectCb: ((id: string) => void) | null = null;
  connects: string[] = [];
  disconnects: string[] = [];
  notificationsStarted: string[] = [];
  writes: { id: string; char: string; chunk: Uint8Array }[] = [];
  mtu = 512;
  failConnect = new Set<string>();
  identHex: string = PEER_HEX;

  async start(): Promise<void> {
    this.started = true;
  }
  async scan(): Promise<void> {
    this.scanning = true;
  }
  async stopScan(): Promise<void> {
    this.scanning = false;
  }
  onDiscover(cb: (info: { id: string; rssi: number; tag: Uint8Array | null }) => void): () => void {
    this.discoverCb = cb;
    return () => {
      this.discoverCb = null;
    };
  }
  async connect(id: string): Promise<void> {
    if (this.failConnect.has(id)) throw new Error('connect refused');
    this.connects.push(id);
  }
  async disconnect(id: string): Promise<void> {
    this.disconnects.push(id);
  }
  async retrieveServices(): Promise<void> {}
  async requestMtu(): Promise<number> {
    return this.mtu;
  }
  async read(): Promise<Uint8Array> {
    return ascii(this.identHex);
  }
  async write(id: string, _svc: string, char: string, chunk: Uint8Array): Promise<void> {
    this.writes.push({ id, char, chunk });
  }
  async startNotification(id: string): Promise<void> {
    this.notificationsStarted.push(id);
  }
  onNotification(cb: (ev: { id: string; value: Uint8Array }) => void): () => void {
    this.notifyCb = cb;
    return () => {
      this.notifyCb = null;
    };
  }
  onDisconnect(cb: (id: string) => void): () => void {
    this.disconnectCb = cb;
    return () => {
      this.disconnectCb = null;
    };
  }

  /** Reassemble what was written to a characteristic into datagrams. */
  writtenDatagrams(char: string): Uint8Array[] {
    const r = new DatagramReassembler();
    const out: Uint8Array[] = [];
    for (const w of this.writes) {
      if (w.char === char) out.push(...r.push(w.chunk));
    }
    return out;
  }
}

/** Fake peripheral-role adapter (multi-ble-peripheral shaped). */
class FakePeripheral implements PeripheralAdapter {
  advertising = false;
  destroyed = false;
  advTag: Uint8Array | null = null;
  advIdent: string | null = null;
  writeCb: ((ev: { device: string; value: Uint8Array }) => void) | null = null;
  notified: Uint8Array[] = [];

  async startAdvertising(tag: Uint8Array, identHex: string): Promise<void> {
    this.advTag = tag;
    this.advIdent = identHex;
    this.advertising = true;
  }
  async stopAdvertising(): Promise<void> {
    this.advertising = false;
  }
  onWrite(cb: (ev: { device: string; value: Uint8Array }) => void): () => void {
    this.writeCb = cb;
    return () => {
      this.writeCb = null;
    };
  }
  async notify(chunk: Uint8Array): Promise<void> {
    this.notified.push(chunk);
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.advertising = false;
  }

  notifiedDatagrams(): Uint8Array[] {
    const r = new DatagramReassembler();
    const out: Uint8Array[] = [];
    for (const c of this.notified) out.push(...r.push(c));
    return out;
  }
}

function makeDeps(overrides?: Partial<BleNativeDeps>): { deps: BleNativeDeps; central: FakeCentral; peripheral: FakePeripheral } {
  const central = new FakeCentral();
  const peripheral = new FakePeripheral();
  const deps: BleNativeDeps = {
    central,
    createPeripheral: async () => peripheral,
    requestPermissions: async () => true,
    ...overrides,
  };
  return { deps, central, peripheral };
}

describe('GattBlePort lifecycle', () => {
  test('advertise is idempotent and records tag + identity', async () => {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.advertise(OWN_HEX); // no-op
    expect(peripheral.advertising).toBe(true);
    expect(peripheral.advIdent).toBe(OWN_HEX);
    expect(peripheral.advTag).not.toBeNull();
    expect(toHex(peripheral.advTag!)).toBe(toHex(peerTagOf(OWN_PUB)));
    await port.stopAdvertise();
    expect(peripheral.advertising).toBe(false);
    expect(peripheral.destroyed).toBe(true);
  });

  test('advertise rejects bad peerId without touching the radio', async () => {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await expect(port.advertise('not-hex')).rejects.toThrow();
    expect(peripheral.advertising).toBe(false);
  });

  test('advertise fails closed when permissions are denied', async () => {
    const { deps, peripheral } = makeDeps({ requestPermissions: async () => false });
    const port = new GattBlePort(deps);
    await expect(port.advertise(OWN_HEX)).rejects.toThrow(/permissions/);
    expect(peripheral.advertising).toBe(false);
  });

  test('advertise fails closed when the peripheral role is unavailable', async () => {
    const { deps } = makeDeps({ createPeripheral: null });
    const port = new GattBlePort(deps);
    await expect(port.advertise(OWN_HEX)).rejects.toThrow(/peripheral role unavailable/);
  });

  test('scan without central resolves to an inert unsubscribe', async () => {
    const { deps } = makeDeps({ central: null });
    const port = new GattBlePort(deps);
    let calls = 0;
    const unsub = await port.scan(() => {
      calls++;
    });
    unsub();
    expect(calls).toBe(0);
  });

  test('close() is idempotent and tears everything down', async () => {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    const unsub = await port.scan(() => {});
    await port.close();
    await port.close();
    unsub(); // safe after close
    expect(central.scanning).toBe(false);
    expect(peripheral.destroyed).toBe(true);
    expect(port.peerCount).toBe(0);
  });
});

describe('discovery + central connect flow', () => {
  test('smaller own tag auto-connects; hello + notify follow', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX); // own tag 0x0a.. < peer 0x0b..
    const seen: string[] = [];
    await port.scan((peer) => seen.push(peer.peerId));

    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);

    expect(seen).toEqual([`tag:${toHex(PEER_TAG)}`]);
    expect(central.connects).toEqual(['ble-1']);
    expect(central.notificationsStarted).toEqual(['ble-1']);
    expect(port.peerCount).toBe(1);

    // The hello went out on the RX characteristic: reassemble and verify.
    const hellos = central
      .writtenDatagrams('b44060bc-7918-4e95-aabd-fe08327ad228')
      .filter((dg) => dg[0] === DATAGRAM_HELLO);
    expect(hellos).toHaveLength(1);
    const hello = parseHello(hellos[0].slice(1));
    expect(hello).not.toBeNull();
    expect(toHex(hello!.publicKey)).toBe(OWN_HEX);
    await port.close();
  });

  test('larger own tag does not auto-connect (waits for inbound)', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX); // own tag 0x0a.. > peer 0x09..
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-9', rssi: -70, tag: peerTagOf(SMALLER_PUB) });
    await tick(50);
    expect(central.connects).toEqual([]);
    expect(port.peerCount).toBe(0);
  });

  test('non-mesh advertisements are ignored', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    let calls = 0;
    await port.scan(() => {
      calls++;
    });
    central.discoverCb!({ id: 'x', rssi: -50, tag: null });
    central.discoverCb!({ id: 'y', rssi: -50, tag: new Uint8Array(4) });
    await tick();
    expect(calls).toBe(0);
    expect(central.connects).toEqual([]);
  });

  test('connect failures do not wedge the port', async () => {
    const { deps, central } = makeDeps();
    central.failConnect.add('ble-1');
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(0); // failed conn was cleaned up
    // A later peer can still connect.
    central.failConnect.clear();
    central.discoverCb!({ id: 'ble-2', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(1);
  });
});

describe('send/receive over the central role', () => {
  const MESH_RX = 'b44060bc-7918-4e95-aabd-fe08327ad228';

  async function connectedPort() {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    return { port, central, peripheral };
  }

  test('hello is written to RX and notification subscribed', async () => {
    const { central } = await connectedPort();
    const hellos = central
      .writtenDatagrams(MESH_RX)
      .filter((dg) => dg[0] === DATAGRAM_HELLO);
    expect(hellos).toHaveLength(1);
    const hello = parseHello(hellos[0].slice(1));
    expect(hello).not.toBeNull();
    expect(toHex(hello!.publicKey)).toBe(OWN_HEX);
    expect(hello!.centralMtu).toBe(512);
    expect(central.notificationsStarted).toEqual(['ble-1']);
  });

  test('send chunks frames to (mtu - 3) ATT PDUs', async () => {
    const { port, central } = await connectedPort();
    const frame = new Uint8Array(1200).map((_, i) => i & 0xff);
    const before = central.writes.length;
    await port.send(PEER_HEX, frame);
    const newWrites = central.writes.slice(before);
    // datagram = 2 (len) + 1 (kind) + 1200; chunk size 509 -> 3 chunks
    expect(newWrites).toHaveLength(3);
    expect(newWrites.every((w) => w.chunk.length <= 512 - ATT_OVERHEAD)).toBe(true);
    expect(newWrites.every((w) => w.char === MESH_RX)).toBe(true);
    // Reassemble: exactly one FRAME datagram with the original bytes.
    const r = new DatagramReassembler();
    const dgs: Uint8Array[] = [];
    for (const w of newWrites) dgs.push(...r.push(w.chunk));
    expect(dgs).toHaveLength(1);
    expect(dgs[0][0]).toBe(DATAGRAM_FRAME);
    expect(dgs[0].slice(1)).toEqual(frame);
  });

  test('send to unknown peer throws (fail closed)', async () => {
    const { port } = await connectedPort();
    await expect(port.send('deadbeef', new Uint8Array([1]))).rejects.toThrow(/unknown peer/);
  });

  test('inbound TX notifications reassemble into frames', async () => {
    const { port, central } = await connectedPort();
    const received: { peerId: string; bytes: Uint8Array }[] = [];
    port.onReceive((peerId, bytes) => received.push({ peerId, bytes }));
    const frame = new Uint8Array([9, 8, 7, 6]);
    const dg = encodeDatagram(DATAGRAM_FRAME, frame);
    for (const chunk of chunkBytes(dg, 20)) {
      central.notifyCb!({ id: 'ble-1', value: chunk });
    }
    expect(received).toEqual([{ peerId: PEER_HEX, bytes: frame }]);
  });

  test('central disconnect drops the conn', async () => {
    const { port, central } = await connectedPort();
    expect(port.peerCount).toBe(1);
    central.disconnectCb!('ble-1');
    expect(port.peerCount).toBe(0);
    await expect(port.send(PEER_HEX, new Uint8Array([1]))).rejects.toThrow(/unknown peer/);
  });

  test('frameSizeFor returns the protocol wire-frame max', async () => {
    const { port } = await connectedPort();
    expect(port.frameSizeFor(PEER_HEX)).toBe(469);
    expect(port.frameSizeFor('nobody')).toBe(469);
  });
});

describe('peripheral role: inbound writes + notify send', () => {
  async function advertisedPort() {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    return { port, peripheral };
  }

  function feedChunks(peripheral: FakePeripheral, device: string, dg: Uint8Array, chunkSize = ATT_DEFAULT_MTU - ATT_OVERHEAD): void {
    for (const chunk of chunkBytes(dg, chunkSize)) {
      peripheral.writeCb!({ device, value: chunk });
    }
  }

  test('hello write resolves the central identity (rekey mac: -> peerId)', async () => {
    const { port, peripheral } = await advertisedPort();
    const seen: string[] = [];
    await port.scan((peer) => seen.push(peer.peerId));
    const received: { peerId: string; bytes: Uint8Array }[] = [];
    port.onReceive((peerId, bytes) => received.push({ peerId, bytes }));

    feedChunks(peripheral, 'AA:BB:CC:DD:EE:01', encodeHello(PEER_PUB, 247));
    expect(port.peerCount).toBe(1);
    expect(seen).toContain(PEER_HEX);

    // A frame from the same device is now attributed to the full peerId.
    const frame = new Uint8Array([1, 2, 3]);
    feedChunks(peripheral, 'AA:BB:CC:DD:EE:01', encodeDatagram(DATAGRAM_FRAME, frame));
    expect(received).toEqual([{ peerId: PEER_HEX, bytes: frame }]);
  });

  test('frame before hello is attributed to the provisional mac id', async () => {
    const { port, peripheral } = await advertisedPort();
    const received: { peerId: string; bytes: Uint8Array }[] = [];
    port.onReceive((peerId, bytes) => received.push({ peerId, bytes }));
    feedChunks(peripheral, 'AA:BB:CC:DD:EE:02', encodeDatagram(DATAGRAM_FRAME, new Uint8Array([5])));
    expect(received).toHaveLength(1);
    expect(received[0].peerId).toBe('mac:AA:BB:CC:DD:EE:02');
  });

  test('malformed hello and unknown kinds are dropped', async () => {
    const { port, peripheral } = await advertisedPort();
    const received: unknown[] = [];
    port.onReceive((...args) => received.push(args));
    // truncated hello
    feedChunks(peripheral, 'AA:BB:CC:DD:EE:03', encodeDatagram(DATAGRAM_HELLO, new Uint8Array([1])));
    // unknown kind
    feedChunks(peripheral, 'AA:BB:CC:DD:EE:03', encodeDatagram(0x7f, new Uint8Array([1])));
    expect(received).toHaveLength(0);
  });

  test('send over peripheral role notifies (broadcast to subscribed)', async () => {
    const { port, peripheral } = await advertisedPort();
    feedChunks(peripheral, 'AA:BB:CC:DD:EE:01', encodeHello(PEER_PUB, 247));
    const frame = new Uint8Array(100).map((_, i) => i & 0xff);
    await port.send(PEER_HEX, frame);
    // mtu 247 -> chunk size 244; datagram 103 bytes -> 1 chunk
    const dgs = peripheral.notifiedDatagrams();
    expect(dgs).toHaveLength(1);
    expect(dgs[0][0]).toBe(DATAGRAM_FRAME);
    expect(dgs[0].slice(1)).toEqual(frame);
    // every notify chunk fits the link MTU
    expect(peripheral.notified.every((c) => c.length <= 247 - ATT_OVERHEAD)).toBe(true);
  });

  test('disconnect forgets peripheral-role conns', async () => {
    const { port, peripheral } = await advertisedPort();
    feedChunks(peripheral, 'AA:BB:CC:DD:EE:01', encodeHello(PEER_PUB, 247));
    expect(port.peerCount).toBe(1);
    await port.disconnect(PEER_HEX);
    expect(port.peerCount).toBe(0);
  });
});

describe('fail-closed null adapters', () => {
  test('every method fails closed, nothing throws synchronously', async () => {
    const port = new GattBlePort({
      central: null,
      createPeripheral: null,
      requestPermissions: async () => false,
    });
    await expect(port.advertise(OWN_HEX)).rejects.toThrow();
    await port.stopAdvertise(); // no-op
    const unsub = await port.scan(() => {});
    unsub();
    await expect(port.connect('tag:abcd')).rejects.toThrow();
    await port.disconnect('tag:abcd'); // no-op
    await expect(port.send('tag:abcd', new Uint8Array([1]))).rejects.toThrow();
    expect(port.frameSizeFor('tag:abcd')).toBe(469);
    let fired = false;
    const off = port.onReceive(() => {
      fired = true;
    });
    off();
    await port.close();
    expect(fired).toBe(false);
  });
});

describe('defaultBleDeps adapter delegation', () => {
  jest.mock('react-native-ble-manager', () => {
    const mgr = {
      start: jest.fn(async () => {}),
      scan: jest.fn(async () => {}),
      stopScan: jest.fn(async () => {}),
      connect: jest.fn(async () => {}),
      disconnect: jest.fn(async () => {}),
      retrieveServices: jest.fn(async () => {}),
      requestMTU: jest.fn(async () => 256),
      read: jest.fn(async () => [104, 105]),
      write: jest.fn(async () => {}),
      startNotification: jest.fn(async () => {}),
    };
    return { __esModule: true, default: mgr };
  });

  test('central adapter delegates to the native singleton', async () => {
    const deps = defaultBleDeps(async () => true);
    expect(deps.central).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mgr = require('react-native-ble-manager').default;
    await deps.central!.start();
    expect(mgr.start).toHaveBeenCalledWith({ showAlert: false });
    await deps.central!.scan();
    expect(mgr.scan).toHaveBeenCalledWith({});
    const mtu = await deps.central!.requestMtu('dev', 512);
    expect(mtu).toBe(256);
    expect(mgr.requestMTU).toHaveBeenCalledWith('dev', 512);
    await deps.central!.write('dev', 'svc', 'char', new Uint8Array([1, 2, 3]));
    expect(mgr.write).toHaveBeenCalledWith('dev', 'svc', 'char', [1, 2, 3], 3);
    const read = await deps.central!.read('dev', 'svc', 'char');
    expect([...read]).toEqual([104, 105]);
  });

  test('discover events parse the manufacturer tag', async () => {
    const deps = defaultBleDeps(async () => true);
    const seen: { id: string; rssi: number; tag: Uint8Array | null }[] = [];
    const off = deps.central!.onDiscover((info) => seen.push(info));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeEventEmitter } = require('react-native');
    const emitter = NativeEventEmitter.instances[NativeEventEmitter.instances.length - 1];
    emitter.emit('BleManagerDiscoverPeripheral', {
      id: 'aa:bb',
      rssi: -72,
      advertising: { manufacturerData: { 65535: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } },
    });
    emitter.emit('BleManagerDiscoverPeripheral', { id: 'cc:dd', rssi: -80, advertising: {} });
    expect(seen).toHaveLength(2);
    expect(seen[0].id).toBe('aa:bb');
    expect(seen[0].rssi).toBe(-72);
    expect([...seen[0].tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seen[1].tag).toBeNull();
    off();
  });

  test('peripheral factory is null-safe when the module is broken', async () => {
    const deps = defaultBleDeps(async () => true);
    // The real multi-ble-peripheral module loads, but its native module is
    // absent in jest, so constructing throws -> factory rejects.
    await expect(deps.createPeripheral!()).rejects.toThrow();
  });
});
