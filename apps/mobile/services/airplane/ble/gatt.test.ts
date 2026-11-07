// SPDX-License-Identifier: Apache-2.0
// GattBlePort tests with fake native adapters (no radio, no native modules).
// Covers: advertise/scan lifecycle, crossed auto-connect (both sides
// initiate), identity exchange both directions, MTU-aware ATT chunking,
// datagram reassembly, provisional peer ids, disconnect/close, and
// fail-closed null adapters.
// A final block verifies the real adapter delegation with jest.mock factories.

import { toHex } from '@airplane/protocol';
import {
  GattBlePort,
  defaultBleDeps,
  describeAdvertiseError,
  withBleTimeout,
  extractTag,
  type BleNativeDeps,
  type CentralAdapter,
  type PeripheralAdapter,
} from './gatt';
import {
  ATT_DEFAULT_MTU,
  ATT_OVERHEAD,
  DATAGRAM_FRAME,
  DATAGRAM_HELLO,
  DATAGRAM_ACK,
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
  connectAttempts: string[] = [];
  disconnects: string[] = [];
  refreshCacheCalls: string[] = [];
  /** Fail the native GATT cache refresh (throws). */
  failRefreshCache = false;
  notificationsStarted: string[] = [];
  writes: { id: string; char: string; chunk: Uint8Array }[] = [];
  writesWithoutResponse: { id: string; char: string; chunk: Uint8Array }[] = [];
  mtu = 512;
  failConnect = new Set<string>();
  /** Error thrown by connect() for ids in failConnect (default: 'connect refused'). */
  failConnectError: Error | null = null;
  failStart = false;
  failWrite = false;
  stateCb: ((state: string) => void) | null = null;
  adapterState = 'on';
  listenerRegistrations = 0;
  identHex: string = PEER_HEX;

  async start(): Promise<void> {
    if (this.failStart) throw new Error('central start refused');
    this.started = true;
  }
  scanCalls = 0;
  stopScanCalls = 0;
  async scan(): Promise<void> {
    this.scanCalls += 1;
    this.scanning = true;
  }
  async stopScan(): Promise<void> {
    this.stopScanCalls += 1;
    this.scanning = false;
  }
  onDiscover(cb: (info: { id: string; rssi: number; tag: Uint8Array | null }) => void): () => void {
    this.listenerRegistrations++;
    this.discoverCb = cb;
    return () => {
      this.discoverCb = null;
    };
  }
  async connect(id: string): Promise<void> {
    this.connectAttempts.push(id);
    if (this.failConnect.has(id)) throw this.failConnectError ?? new Error('connect refused');
    this.connects.push(id);
  }
  async disconnect(id: string): Promise<void> {
    this.disconnects.push(id);
  }
  async retrieveServices(): Promise<void> {}
  async refreshCache(id: string): Promise<boolean> {
    this.refreshCacheCalls.push(id);
    if (this.failRefreshCache) throw new Error('refresh refused');
    return true;
  }
  async requestMtu(): Promise<number> {
    return this.mtu;
  }
  failReadOnce = false;
  failReadAlways = false;
  async read(): Promise<Uint8Array> {
    if (this.failReadAlways) {
      throw new Error('Characteristic 9e849f21-2e3b-42d4-b3b7-4e9a0ead3116 not found');
    }
    if (this.failReadOnce) {
      this.failReadOnce = false;
      throw new Error('Characteristic 9e849f21-2e3b-42d4-b3b7-4e9a0ead3116 not found');
    }
    return ascii(this.identHex);
  }
  async write(id: string, _svc: string, char: string, chunk: Uint8Array): Promise<void> {
    if (this.failWrite) throw new Error('write refused');
    this.writes.push({ id, char, chunk });
  }
  async writeWithoutResponse(id: string, _svc: string, char: string, chunk: Uint8Array): Promise<void> {
    this.writesWithoutResponse.push({ id, char, chunk });
  }
  async startNotification(id: string): Promise<void> {
    this.notificationsStarted.push(id);
  }
  onNotification(cb: (ev: { id: string; value: Uint8Array }) => void): () => void {
    this.listenerRegistrations++;
    this.notifyCb = cb;
    return () => {
      this.notifyCb = null;
    };
  }
  onDisconnect(cb: (id: string) => void): () => void {
    this.listenerRegistrations++;
    this.disconnectCb = cb;
    return () => {
      this.disconnectCb = null;
    };
  }
  onState(cb: (state: string) => void): () => void {
    this.stateCb = cb;
    return () => {
      this.stateCb = null;
    };
  }
  async checkState(): Promise<string | null> {
    return this.adapterState;
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
  errorCb: ((err: unknown) => void) | null = null;
  notified: Uint8Array[] = [];

  async startAdvertising(tag: Uint8Array, identHex: string): Promise<void> {
    this.advTag = tag;
    this.advIdent = identHex;
    this.advertising = true;
  }
  failStop = false;
  async stopAdvertising(): Promise<void> {
    if (this.failStop) throw new Error('stop refused');
    this.advertising = false;
  }
  onWrite(cb: (ev: { device: string; value: Uint8Array }) => void): () => void {
    this.writeCb = cb;
    return () => {
      this.writeCb = null;
    };
  }
  onError(cb: (err: unknown) => void): () => void {
    this.errorCb = cb;
    return () => {
      this.errorCb = null;
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

  test('advertise failure from a null native error is described, not "null"', async () => {
    expect(describeAdvertiseError(null)).toMatch(/native error was empty/);
    expect(describeAdvertiseError(null)).not.toMatch(/^null$/);
    const { deps, peripheral } = makeDeps({
      createPeripheral: async () => ({
        startAdvertising: async () => {
          // Native layer rejecting with null (the R2 device symptom).
          throw null as unknown as Error;
        },
        stopAdvertising: async () => {},
        onWrite: () => () => {},
        notify: async () => {},
        destroy: async () => {
          peripheral.destroyed = true;
        },
      }),
    });
    const port = new GattBlePort(deps);
    await expect(port.advertise(OWN_HEX)).rejects.toThrow(/native error was empty/);
    expect(peripheral.destroyed).toBe(true);
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

    // Tag first, then the full peerId once the central side resolves IDENT
    // (the scan channel re-fire; previously only the tag ever arrived).
    expect(seen).toEqual([`tag:${toHex(PEER_TAG)}`, PEER_HEX]);
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

  test('larger own tag also auto-connects (crossed links, no tie-break)', async () => {
    const { deps, central } = makeDeps();
    central.identHex = toHex(SMALLER_PUB);
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX); // own tag 0x0a.. > peer 0x09..
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-9', rssi: -70, tag: peerTagOf(SMALLER_PUB) });
    await tick(50);
    // The old tie-break left the larger-tag side waiting for an inbound
    // hello that never arrives on new-arch builds (peripheral write
    // events do not deliver), so it never connected. Both sides now
    // initiate, giving crossed central links.
    expect(central.connects).toEqual(['ble-9']);
    expect(port.peerCount).toBe(1);
    await port.close();
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
    await port.close();
  });
});

describe('connectedPeerIds (publish targets)', () => {
  test('empty before connect, full peerId after central connect', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    expect(port.connectedPeerIds()).toEqual([]);
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    await port.close();
  });

  test('pre-hello peripheral conns are excluded; hello rekey includes them', async () => {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    // Frame before hello: conn exists under a provisional mac: id.
    for (const chunk of chunkBytes(encodeDatagram(DATAGRAM_FRAME, new Uint8Array([5])), ATT_DEFAULT_MTU - ATT_OVERHEAD)) {
      peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:02', value: chunk });
    }
    expect(port.peerCount).toBe(1);
    expect(port.connectedPeerIds()).toEqual([]);
    // Hello resolves the identity -> included.
    for (const chunk of chunkBytes(encodeHello(PEER_PUB, 247), ATT_DEFAULT_MTU - ATT_OVERHEAD)) {
      peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:02', value: chunk });
    }
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    await port.close();
  });

  test('same peer over both roles dedupes to one id', async () => {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    // Same peer's inbound hello (peripheral role) must not add a second id.
    for (const chunk of chunkBytes(encodeHello(PEER_PUB, 247), ATT_DEFAULT_MTU - ATT_OVERHEAD)) {
      peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:01', value: chunk });
    }
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    await port.close();
  });
});

describe('extractTag (native discover shapes)', () => {
  const base64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
  test('real Android native shape: lowercase hex key "ffff"', () => {
    const tag = extractTag({ advertising: { manufacturerData: { ffff: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } } });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('decimal key fallback (legacy shape)', () => {
    const tag = extractTag({ advertising: { manufacturerData: { 65535: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } } });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('base64 data fallback when bytes absent', () => {
    const tag = extractTag({ advertising: { manufacturerData: { ffff: { data: base64([1, 2, 3, 4, 5, 6, 7, 8]) } } } });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('missing / wrong-length / absent manufacturerData -> null', () => {
    expect(extractTag({ advertising: { manufacturerData: { ffff: { bytes: [1, 2, 3] } } } })).toBeNull();
    expect(extractTag({ advertising: {} })).toBeNull();
    expect(extractTag({})).toBeNull();
    expect(extractTag(null)).toBeNull();
  });
  // Raw scan record: flags field plus a 0xFF field (company 0xFFFF
  // little endian, 8-byte tag). Field length counts type plus payload.
  const meshRecord = [0x02, 0x01, 0x06, 0x0b, 0xff, 0xff, 0xff, 1, 2, 3, 4, 5, 6, 7, 8];
  test('rawData bytes: 0xFFFF manufacturer field yields the tag', () => {
    const tag = extractTag({ advertising: { rawData: { bytes: meshRecord } } });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('rawData base64 only (no bytes array) yields the tag', () => {
    const tag = extractTag({ advertising: { rawData: { data: base64(meshRecord) } } });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('rawData: different company id is skipped, later 0xFFFF field wins', () => {
    const other = [0x02, 0x01, 0x06, 0x0b, 0xff, 0x4c, 0x00, 9, 9, 9, 9, 9, 9, 9, 9];
    const tag = extractTag({ advertising: { rawData: { bytes: [...other, ...meshRecord.slice(3)] } } });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(extractTag({ advertising: { rawData: { bytes: other } } })).toBeNull();
  });
  test('rawData: truncated record, no 0xFF field, long payload -> null', () => {
    expect(extractTag({ advertising: { rawData: { bytes: [0x02, 0x01, 0x06, 0x0b, 0xff, 0xff] } } })).toBeNull();
    expect(extractTag({ advertising: { rawData: { bytes: [0x02, 0x01, 0x06, 0x03, 0x03, 0xaa, 0xbb] } } })).toBeNull();
    const longPayload = [0x02, 0x01, 0x06, 0x0d, 0xff, 0xff, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(extractTag({ advertising: { rawData: { bytes: longPayload } } })).toBeNull();
    expect(extractTag({ advertising: { rawData: { bytes: [300] } } })).toBeNull();
  });
  test('rawData without a tag falls back to the manufacturerData map', () => {
    const tag = extractTag({
      advertising: {
        rawData: { bytes: [0x02, 0x01, 0x06] },
        manufacturerData: { ffff: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } },
      },
    });
    expect([...tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('send over notify, receive over central notifications', () => {
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

  test('send notifies on our TX (no central writes for frames)', async () => {
    const { port, central, peripheral } = await connectedPort();
    const frame = new Uint8Array(1200).map((_, i) => i & 0xff);
    // Frames go out as TX notifies, never as central writes: a write to
    // the peer RX is never delivered to the peer app layer on new-arch
    // builds, so a "sent" write was a silent loss (proven 2026-11-03).
    // No readiness gate: a connected peer is a send target.
    await port.send(PEER_HEX, frame);
    // datagram = 2 (len) + 1 (kind) + 1200; chunk size 509 -> 3 chunks.
    expect(peripheral.notified).toHaveLength(3);
    expect(peripheral.notified.every((c) => c.length <= 512 - ATT_OVERHEAD)).toBe(true);
    // Reassemble: exactly one FRAME datagram with the original bytes.
    const dgs = peripheral.notifiedDatagrams();
    expect(dgs).toHaveLength(1);
    expect(dgs[0][0]).toBe(DATAGRAM_FRAME);
    expect(dgs[0].slice(1)).toEqual(frame);
    // No frame chunk went out as a central write: writes hold the hello only.
    expect(central.writesWithoutResponse).toHaveLength(0);
    const frameWrites = central.writtenDatagrams(MESH_RX).filter((dg) => dg[0] === DATAGRAM_FRAME);
    expect(frameWrites).toHaveLength(0);
    await port.close();
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
    // No readiness gate: the peripheral hello resolves the peer, and
    // the send notifies at once.
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
    expect(mgr.scan).toHaveBeenCalledWith({ serviceUUIDs: [], seconds: 0, allowDuplicates: false, scanMode: 2 });
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

  test('discover events parse the real native hex key (ffff)', async () => {
    const deps = defaultBleDeps(async () => true);
    const seen: { id: string; rssi: number; tag: Uint8Array | null }[] = [];
    const off = deps.central!.onDiscover((info) => seen.push(info));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeEventEmitter } = require('react-native');
    const emitter = NativeEventEmitter.instances[NativeEventEmitter.instances.length - 1];
    emitter.emit('BleManagerDiscoverPeripheral', {
      id: 'ee:ff',
      rssi: -65,
      advertising: { manufacturerData: { ffff: { bytes: [9, 8, 7, 6, 5, 4, 3, 2] } } },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('ee:ff');
    expect([...seen[0].tag!]).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    off();
  });

  test('peripheral factory is null-safe when the module is broken', async () => {
    const deps = defaultBleDeps(async () => true);
    // The real multi-ble-peripheral module loads, but its native module is
    // absent in jest, so constructing throws -> factory rejects.
    await expect(deps.createPeripheral!()).rejects.toThrow();
  });
});

describe('withBleTimeout (audit P1-13)', () => {
  test('passes a settling value through', async () => {
    await expect(withBleTimeout(Promise.resolve(7), 1000, 'test stage')).resolves.toBe(7);
  });

  test('rejects with a stage-tagged error when the native call never settles', async () => {
    await expect(withBleTimeout(new Promise(() => {}), 10, 'central connect')).rejects.toThrow(
      /central connect timed out/,
    );
  });

  test('passes a native rejection through unchanged', async () => {
    await expect(withBleTimeout(Promise.reject(new Error('native boom')), 1000, 'test stage')).rejects.toThrow(
      'native boom',
    );
  });
});

describe('ensureCentral failure cleanup (audit P1-15)', () => {
  test('a start failure is recorded, leaks no subscriber, and a retry registers listeners once', async () => {
    const { deps, central } = makeDeps();
    central.failStart = true;
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await expect(port.scan(() => {})).rejects.toThrow(/central start refused/);
    // No listener survives the failed bring-up, and no scan subscriber leaked.
    expect(central.discoverCb).toBeNull();
    expect(central.notifyCb).toBeNull();
    expect(central.disconnectCb).toBeNull();
    const { getDiagnosticsSnapshot, resetDiagnosticsForTests } = await import('../diagnostics');
    expect(getDiagnosticsSnapshot().scanning.lastFailure).toMatch(/central start refused/);
    resetDiagnosticsForTests();
    // Retry after the radio recovers: exactly one listener set, one connect.
    central.failStart = false;
    const seen: string[] = [];
    await port.scan((peer) => seen.push(peer.peerId));
    expect(central.listenerRegistrations).toBe(3);
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connects).toEqual(['ble-1']);
    expect(seen).toEqual([`tag:${toHex(PEER_TAG)}`, PEER_HEX]);
    await port.close();
  });
});

describe('connectCentral cleanup + IDENT tag binding (audit P1-16)', () => {
  test('a hello-write failure after registration drops the conn, it does not stay connected', async () => {
    const { deps, central } = makeDeps();
    central.failWrite = true;
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(0);
    expect(port.connectedPeerIds()).toEqual([]);
    expect(central.disconnects).toContain('ble-1');
    // The bleId is free again: a later discovery can connect.
    central.failWrite = false;
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(1);
    await port.close();
  });

  test('an IDENT pubkey whose tag differs from the advertised tag fails the connect', async () => {
    const { deps, central } = makeDeps();
    const mismatchPub = new Uint8Array(32).fill(0x0c);
    central.identHex = toHex(mismatchPub);
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(0);
    expect(port.connectedPeerIds()).toEqual([]);
    // With the matching IDENT the same bleId connects.
    central.identHex = PEER_HEX;
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(1);
    await port.close();
  });
});

describe('in-flight guards (audit P1-20)', () => {
  test('concurrent advertise calls share one in-flight promise, no second advertiser', async () => {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    const otherPub = new Uint8Array(32).fill(0x0d);
    await Promise.all([port.advertise(OWN_HEX), port.advertise(toHex(otherPub))]);
    expect(peripheral.advIdent).toBe(OWN_HEX);
    await port.stopAdvertise();
  });

  test('concurrent connects to the same bleId run one handshake', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    // Two discoveries of the same bleId in one tick: the second must not
    // start a second native connect while the first handshake is pending.
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connects).toEqual(['ble-1']);
    expect(port.peerCount).toBe(1);
    await port.close();
  });

  test('peer limit counts pending handshakes, not just registered conns', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    // MAX_BLE_PEERS is 8: fill it with 8 connected peers, then a 9th
    // discovery must not start a connect.
    for (let i = 0; i < 8; i++) {
      const pub = new Uint8Array(32).fill(0x10 + i);
      const tag = peerTagOf(pub);
      // Each peer tag must sort above our own tag (0x0a) to auto-connect,
      // and IDENT must match the tag: point ident at this peer.
      central.identHex = toHex(pub);
      central.discoverCb!({ id: `ble-${i}`, rssi: -60, tag });
      await tick(20);
    }
    expect(port.peerCount).toBe(8);
    const connectsBefore = central.connects.length;
    const pub9 = new Uint8Array(32).fill(0x30);
    central.identHex = toHex(pub9);
    central.discoverCb!({ id: 'ble-9', rssi: -60, tag: peerTagOf(pub9) });
    await tick(30);
    expect(central.connects.length).toBe(connectsBefore);
    await port.close();
  });
});

describe('auto-connect bounded retry (audit P1-19)', () => {
  test('a failed auto-connect is recorded and retried exactly once', async () => {
    const { deps, central } = makeDeps();
    central.failConnect.add('ble-1');
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(
      lines.some((l) => l.includes(`connect failed auto-connect tag:${toHex(PEER_TAG)}`)),
    ).toBe(true);
    expect(lines.some((l) => l.includes('ble-1'))).toBe(false);
    expect(port.peerCount).toBe(0);
    // The single retry fires after about 2s and fails again (still refused).
    await new Promise((r) => setTimeout(r, 2200));
    expect(central.connectAttempts).toEqual(['ble-1', 'ble-1']);
    // No further retries: another window passes with no new attempt.
    await new Promise((r) => setTimeout(r, 2200));
    expect(central.connectAttempts).toEqual(['ble-1', 'ble-1']);
    resetDiagnosticsForTests();
    await port.close();
  });

  test('the retry succeeds when the transient failure clears', async () => {
    const { deps, central } = makeDeps();
    central.failConnect.add('ble-1');
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.peerCount).toBe(0);
    central.failConnect.clear();
    await new Promise((r) => setTimeout(r, 2200));
    expect(port.peerCount).toBe(1);
    await port.close();
  });

  test('an IDENT not-found read retries discovery once and connects', async () => {
    const { deps, central } = makeDeps();
    central.failReadOnce = true;
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    // The retry now waits a 300 ms settle before the second read, so
    // a 50 ms tick is too short; and a retry that succeeds must leave
    // no failed line behind, only the later peer connected line. The
    // retry first clears the native GATT cache, and logs its outcome.
    await new Promise((r) => setTimeout(r, 600));
    expect(port.peerCount).toBe(1);
    expect(central.refreshCacheCalls).toEqual(['ble-1']);
    expect(lines.some((l) => l.includes('ble ident retry tag') && l.includes('read2 ok'))).toBe(true);
    expect(lines.some((l) => l.includes('peer connect failed'))).toBe(false);
    expect(lines.some((l) => l.includes('ble-1'))).toBe(false);
    resetDiagnosticsForTests();
    await port.close();
  });

  test('repeated sightings during a persistent IDENT outage fail, arm the cooldown, and leave no provisional link', async () => {
    const { deps, central } = makeDeps();
    central.failReadAlways = true;
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    // Storm cadence: the same peer sighted five times in quick
    // succession while its GATT server is gone.
    for (let i = 0; i < 5; i++) {
      central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    }
    // The retry waits a 300 ms settle before the second read; past
    // that, exactly one attempt has run and the link is gone, not
    // provisional: the second read failed too, so the attempt throws
    // "ident retry failed", the caller logs one failure line and arms
    // the sighting cooldown, and no peer is registered. The v0.1.32
    // provisional link (kept on a second failure, promoted by an
    // inbound hello) is gone with the ready gate it served.
    await new Promise((r) => setTimeout(r, 600));
    expect(central.connectAttempts).toEqual(['ble-1']);
    expect(central.refreshCacheCalls).toEqual(['ble-1']);
    expect(port.peerCount).toBe(0);
    expect(port.connectedPeerIds()).toEqual([]);
    expect(lines.some((l) => l.includes('ble ident retry tag') && l.includes('read2 not-found'))).toBe(true);
    expect(lines.some((l) => l.includes('connect failed auto-connect tag:'))).toBe(true);
    expect(lines.some((l) => l.includes('link provisional'))).toBe(false);
    resetDiagnosticsForTests();
    await port.close();
  });
});

describe('v0.1.32 IDENT provisional link: per-tag dedup + disconnect guard', () => {
  test('two BLE addresses for one tag start one central connect', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    // RPA rotation: the same peer sighted under a second BLE address
    // while the first handshake is in flight. The per-bleId set
    // cannot dedup this; the per-tag set must, or the second
    // discovery returns an incomplete service table and the IDENT
    // read fails (v0.1.31: two attempts 9 s apart for one tag).
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    central.discoverCb!({ id: 'ble-2', rssi: -61, tag: PEER_TAG });
    expect(central.connectAttempts).toEqual(['ble-1']);
    await tick(50);
    expect(port.peerCount).toBe(1);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    await port.close();
  });

  test('a failed central connect does not disconnect a live peripheral link for the same address', async () => {
    const { deps, central, peripheral } = makeDeps();
    // First IDENT read fails (not found), so the retry waits out its
    // 300 ms settle; the retry read then returns a malformed IDENT,
    // which throws before any registration. While the retry is
    // settling, the peer connects to our peripheral side under the
    // same address: the failed central attempt must not tear that
    // live link down (v0.1.31: disconnects following IDENT failures
    // by seconds).
    central.failReadOnce = true;
    central.identHex = 'zzzz';
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    for (const chunk of chunkBytes(encodeDatagram(DATAGRAM_FRAME, new Uint8Array([5])), ATT_DEFAULT_MTU - ATT_OVERHEAD)) {
      peripheral.writeCb!({ device: 'ble-1', value: chunk });
    }
    expect(port.peerCount).toBe(1);
    // Past the 300 ms settle: the retry read returned the malformed
    // IDENT and the central attempt failed, but the peripheral link
    // for the same address is untouched.
    await new Promise((r) => setTimeout(r, 400));
    expect(central.disconnects).not.toContain('ble-1');
    expect(port.peerCount).toBe(1);
    await port.close();
  });
});

describe('connect-timeout cooldown (2026-11-05 field evidence)', () => {
  test('repeated sightings during a connect-timeout outage stay quiet after the first failure and one retry', async () => {
    const { deps, central } = makeDeps();
    central.failConnect.add('ble-1');
    central.failConnectError = new Error('ble: central connect timed out after 10000ms');
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    // Storm cadence: the same peer sighted five times in quick
    // succession while every connect hangs until the 10 s deadline.
    for (let i = 0; i < 5; i++) {
      central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    }
    // Past the 2 s scheduled retry: first attempt + one retry, then
    // the cooldown gates every later sighting.
    await new Promise((r) => setTimeout(r, 3200));
    expect(central.connectAttempts.length).toBe(2);
    const failures = lines.filter((l) => l.includes('peer connect failed'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('auto-connect');
    expect(failures[0]).toContain('central connect timed out after 10000ms');
    expect(failures[1]).toContain('auto-connect retry failed');
    // Further sightings inside the cooldown start no new attempt.
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts.length).toBe(2);
    resetDiagnosticsForTests();
    await port.close();
  });

  test('a device-disconnected failure arms the cooldown the same way', async () => {
    const { deps, central } = makeDeps();
    central.failConnect.add('ble-1');
    central.failConnectError = new Error('ble: connect failed: Device disconnected');
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    for (let i = 0; i < 3; i++) {
      central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    }
    await new Promise((r) => setTimeout(r, 3200));
    expect(central.connectAttempts.length).toBe(2);
    const failures = lines.filter((l) => l.includes('peer connect failed'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('Device disconnected');
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts.length).toBe(2);
    resetDiagnosticsForTests();
    await port.close();
  });

  test('a connectGatt-null failure arms the cooldown the same way', async () => {
    const { deps, central } = makeDeps();
    central.failConnect.add('ble-1');
    central.failConnectError = new Error('Connection failed to start: connectGatt returned null');
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    for (let i = 0; i < 3; i++) {
      central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    }
    await new Promise((r) => setTimeout(r, 3200));
    expect(central.connectAttempts.length).toBe(2);
    const failures = lines.filter((l) => l.includes('peer connect failed'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('connectGatt returned null');
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts.length).toBe(2);
    resetDiagnosticsForTests();
    await port.close();
  });

  test('a tag-mismatch failure does not arm the cooldown', async () => {
    const { deps, central } = makeDeps();
    // The peer answers IDENT with a key whose tag differs from the
    // advertised tag: a deterministic mismatch, not an outage.
    central.identHex = toHex(SMALLER_PUB);
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts.length).toBe(1);
    expect(port.peerCount).toBe(0);
    // The single retry fires after about 2s and fails the same way.
    await new Promise((r) => setTimeout(r, 2200));
    expect(central.connectAttempts.length).toBe(2);
    // No cooldown was armed, so a fresh sighting starts a new attempt.
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts.length).toBe(3);
    await port.close();
  });
});

describe('adapter-state subscription (audit P1-14)', () => {
  test('native state events reach port subscribers and checkAdapterState reports the state', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    const states: string[] = [];
    port.onAdapterState((state) => states.push(state));
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    expect(await port.checkAdapterState()).toBe('on');
    central.stateCb!('off');
    central.stateCb!('on');
    central.stateCb!('unsupported'); // ignored: only on/off are forwarded
    expect(states).toEqual(['off', 'on']);
    await port.close();
  });
});

describe('ensureCentral permission check (audit P1-18)', () => {
  test('scan with revoked grants records a permission-tagged failure and throws', async () => {
    const { deps } = makeDeps({ checkPermissions: async () => false });
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await expect(port.scan(() => {})).rejects.toThrow(/permissions not granted/);
    const { getDiagnosticsSnapshot, resetDiagnosticsForTests } = await import('../diagnostics');
    expect(getDiagnosticsSnapshot().scanning.lastFailure).toMatch(/permissions not granted/);
    resetDiagnosticsForTests();
    await port.close();
  });

  test('scan proceeds when the check passes', async () => {
    const { deps, central } = makeDeps({ checkPermissions: async () => true });
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    expect(central.started).toBe(true);
    await port.close();
  });
});

describe('discovered peer pruning and cap (audit F-P2-1)', () => {
  test('stale entries are pruned before connect, so a long-gone peer is not dialled', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    // 61s later a new sighting triggers the prune of the stale entry.
    nowSpy.mockReturnValue(1_000_000 + 61_000);
    const otherPub = new Uint8Array(32).fill(0x0c);
    central.discoverCb!({ id: 'ble-2', rssi: -60, tag: peerTagOf(otherPub) });
    await tick(50);
    // Still at the second sighting's time: the first entry was pruned on
    // discover, the second is fresh, so only the first is unknown.
    await expect(port.connect(`tag:${toHex(PEER_TAG)}`)).rejects.toThrow(/unknown peer/);
    nowSpy.mockRestore();
    await port.close();
  });

  test('the map caps at 100 entries, evicting the stalest first', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    // 101 distinct tags that sort below our own tag, so none auto-connect.
    for (let i = 0; i < 101; i++) {
      const pub = new Uint8Array(32);
      pub[0] = 0x01;
      pub[1] = i & 0xff;
      central.discoverCb!({ id: `ble-${i}`, rssi: -60, tag: peerTagOf(pub) });
    }
    const firstPub = new Uint8Array(32);
    firstPub[0] = 0x01;
    firstPub[1] = 0;
    await expect(port.connect(`tag:${toHex(peerTagOf(firstPub))}`)).rejects.toThrow(/unknown peer/);
    const lastPub = new Uint8Array(32);
    lastPub[0] = 0x01;
    lastPub[1] = 100;
    // The newest entry survives: connect attempts it, so the error is
    // the IDENT mismatch (default fake IDENT), not unknown-peer.
    await expect(port.connect(`tag:${toHex(peerTagOf(lastPub))}`)).rejects.not.toThrow(/unknown peer/);
    await port.close();
  });
});

describe('scan failure callback (audit F-P2-5)', () => {
  test('ensureCentral failure notifies the transport callback with the failure code', async () => {
    const codes: string[] = [];
    const { deps, central } = makeDeps({ onScanFailure: (code) => codes.push(code) });
    central.failStart = true;
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await expect(port.scan(() => {})).rejects.toThrow();
    expect(codes).toEqual(['central start refused']);
    await port.close();
  });
});

describe('persistent peripheral error listener (audit F-P2-6)', () => {
  test('a later peripheral error records an advertise failure and clears the handle for Retry', async () => {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    expect(peripheral.advertising).toBe(true);
    peripheral.errorCb!(new Error('gatt server died'));
    const { getDiagnosticsSnapshot, resetDiagnosticsForTests } = await import('../diagnostics');
    expect(getDiagnosticsSnapshot().advertising.state).toBe('stopped');
    expect(getDiagnosticsSnapshot().advertising.lastFailure).toMatch(/peripheral error after ready/);
    resetDiagnosticsForTests();
    // The handle is cleared, so a fresh advertise recreates the adapter
    // instead of returning early for the dead one.
    await port.advertise(OWN_HEX);
    expect(peripheral.advIdent).toBe(OWN_HEX);
    await port.close();
  });
});

describe('stopAdvertise failure ordering (audit F-P2-7)', () => {
  test('a failed stop keeps the handle and never throws; a later stop retries', async () => {
    const { deps, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    peripheral.failStop = true;
    await port.stopAdvertise(); // never throws, despite the native failure
    // The handle is kept: advertising a different peer must refuse rather
    // than overwrite the kept handle and orphan the old advertiser.
    const otherPub = new Uint8Array(32).fill(0x0d);
    await expect(port.advertise(toHex(otherPub))).rejects.toThrow(/could not be stopped/);
    // Once the native stop recovers, a later stop succeeds and destroys.
    peripheral.failStop = false;
    await port.stopAdvertise();
    expect(peripheral.destroyed).toBe(true);
    await port.close();
  });
});

describe('notify send for frame chunks (supersedes audit F-P2-9)', () => {
  test('send notifies frames; hello keeps with-response writes', async () => {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    const helloWrites = central.writes.length;
    const frame = new Uint8Array(100).map((_, i) => i & 0xff);
    await port.send(PEER_HEX, frame);
    // Hello went out with-response; the frame went out as TX notifies.
    // F-P2-9 assumed central writes are delivered; the 2026-11-03 field
    // run proved they are not on new-arch builds, so writes are no
    // longer used for frames at all.
    expect(central.writes.length).toBe(helloWrites);
    expect(central.writesWithoutResponse).toHaveLength(0);
    // The TX carries the frame only: no hello notify (v0.1.33 removed).
    const dgs = peripheral.notifiedDatagrams();
    expect(dgs).toHaveLength(1);
    expect(dgs[0][0]).toBe(DATAGRAM_FRAME);
    await port.close();
  });
});

describe('crossed links: both directions over notify', () => {
  test('two ports exchange frames over TX notify (radio hop simulated)', async () => {
    // Port A (own 0x0a..) and port B (own 0x0b..): each discovers the
    // other and connects as central, giving crossed links. Frames then
    // travel A TX notify -> B central notification and back. The radio
    // hop itself is the native layer: feeding A notified chunks into B
    // notifyCb stands in for it, and asserts the port layer produces
    // notifies on send and reassembles notifies on receive.
    const depsA = makeDeps();
    const depsB = makeDeps();
    depsA.central.identHex = PEER_HEX;
    depsB.central.identHex = OWN_HEX;
    const portA = new GattBlePort(depsA.deps);
    const portB = new GattBlePort(depsB.deps);
    await portA.advertise(OWN_HEX);
    await portB.advertise(PEER_HEX);
    await portA.scan(() => {});
    await portB.scan(() => {});
    // A discovers B (tag 0x0b..) and B discovers A (tag 0x0a..): both
    // initiate, tie-break or not.
    depsA.central.discoverCb!({ id: 'ble-b', rssi: -50, tag: PEER_TAG });
    depsB.central.discoverCb!({ id: 'ble-a', rssi: -50, tag: peerTagOf(OWN_PUB) });
    await tick(50);
    expect(portA.connectedPeerIds()).toEqual([PEER_HEX]);
    expect(portB.connectedPeerIds()).toEqual([OWN_HEX]);
    // Both peers hello each other's peripheral, completing the
    // handshake on both sides (v0.1.31 readiness gate): a central-only
    // link is not a send target.
    for (const chunk of chunkBytes(encodeHello(PEER_PUB, 247), ATT_DEFAULT_MTU - ATT_OVERHEAD)) {
      depsA.peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:01', value: chunk });
    }
    for (const chunk of chunkBytes(encodeHello(OWN_PUB, 247), ATT_DEFAULT_MTU - ATT_OVERHEAD)) {
      depsB.peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:02', value: chunk });
    }
    // A -> B: A notifies, B central receives.
    const receivedB: { peerId: string; bytes: Uint8Array }[] = [];
    portB.onReceive((peerId, bytes) => receivedB.push({ peerId, bytes }));
    const frameAB = new Uint8Array([1, 2, 3, 4]);
    await portA.send(PEER_HEX, frameAB);
    expect(depsA.central.writesWithoutResponse).toHaveLength(0);
    for (const chunk of depsA.peripheral.notified) {
      depsB.central.notifyCb!({ id: 'ble-a', value: chunk });
    }
    expect(receivedB).toEqual([{ peerId: OWN_HEX, bytes: frameAB }]);
    // B -> A: reverse direction over the same crossed links.
    const receivedA: { peerId: string; bytes: Uint8Array }[] = [];
    portA.onReceive((peerId, bytes) => receivedA.push({ peerId, bytes }));
    const frameBA = new Uint8Array([9, 8]);
    await portB.send(OWN_HEX, frameBA);
    expect(depsB.central.writesWithoutResponse).toHaveLength(0);
    for (const chunk of depsB.peripheral.notified) {
      depsA.central.notifyCb!({ id: 'ble-b', value: chunk });
    }
    expect(receivedA).toEqual([{ peerId: PEER_HEX, bytes: frameBA }]);
    await portA.close();
    await portB.close();
  });

  test('central send without an advertiser throws (no silent write)', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    // Advertiser down: the central conn survives (see stopAdvertise),
    // but there is no TX to notify on, so send must fail loudly rather
    // than fall back to a write nobody receives.
    await port.stopAdvertise();
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    await expect(port.send(PEER_HEX, new Uint8Array([1]))).rejects.toThrow(/peripheral role unavailable/);
    await port.close();
  });
});

describe('close cleanup (audit F-P3-1)', () => {
  test('close records scan stopped only when scanning was active', async () => {
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    const { deps } = makeDeps();
    const neverScanned = new GattBlePort(deps);
    await neverScanned.close();
    expect(lines.some((l) => l === 'scan stopped')).toBe(false);
    const scanned = new GattBlePort(deps);
    await scanned.advertise(OWN_HEX);
    await scanned.scan(() => {});
    await scanned.close();
    expect(lines.some((l) => l === 'scan stopped')).toBe(true);
    resetDiagnosticsForTests();
  });
});

describe('scan-before-advertise self filtering (audit F-P3-2)', () => {
  test('scanning before advertising surfaces our own advertisement as a peer (documented latent order requirement)', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    // No advertise() call: ownTag is null, so the self filter cannot run.
    const seen: string[] = [];
    await port.scan((peer) => seen.push(peer.peerId));
    central.discoverCb!({ id: 'ble-self', rssi: -50, tag: peerTagOf(OWN_PUB) });
    await tick(20);
    // The app flow always advertises first, so this never happens live;
    // the test pins that the filter depends on advertise having run.
    expect(seen).toEqual([`tag:${toHex(peerTagOf(OWN_PUB))}`]);
    await port.close();
  });
});

describe('advertisement length (audit F-P3-3)', () => {
  test('advertise records 15 bytes: 12-byte manufacturer field plus 3-byte Flags', async () => {
    const { deps } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    const { getDiagnosticsSnapshot, resetDiagnosticsForTests } = await import('../diagnostics');
    expect(getDiagnosticsSnapshot().advertising.advertisementLengthBytes).toBe(15);
    resetDiagnosticsForTests();
    await port.close();
  });
});

describe('BLE drop logging (audit F-P3-5)', () => {
  test('a peripheral write dropped at the peer limit logs one throttled line', async () => {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    for (let i = 0; i < 8; i++) {
      const pub = new Uint8Array(32).fill(0x10 + i);
      central.identHex = toHex(pub);
      central.discoverCb!({ id: `ble-${i}`, rssi: -60, tag: peerTagOf(pub) });
      await tick(20);
    }
    expect(port.peerCount).toBe(8);
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind, detail) => lines.push(`${kind} ${detail}`));
    peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:99', value: new Uint8Array([1, 2, 3]) });
    peripheral.writeCb!({ device: 'AA:BB:CC:DD:EE:98', value: new Uint8Array([1, 2, 3]) });
    // Throttled: two drops in one minute produce exactly one line.
    expect(lines.filter((l) => l.startsWith('ble-drop peer-limit'))).toHaveLength(1);
    resetDiagnosticsForTests();
    await port.close();
  });
});

describe('mesh-scan fix: codegen event subscription', () => {
  // The delegation mock above has no codegen methods, so the legacy
  // path stays covered there. These tests add the codegen methods to
  // the same mocked singleton and remove them afterwards.
  test('discover uses the codegen method when present, not the legacy emitter', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mgr = require('react-native-ble-manager').default;
    let captured: ((p: unknown) => void) | null = null;
    mgr.onDiscoverPeripheral = jest.fn((cb: (p: unknown) => void) => {
      captured = cb;
      return { remove: jest.fn() };
    });
    try {
      const deps = defaultBleDeps(async () => true);
      const seen: { id: string; rssi: number; tag: Uint8Array | null }[] = [];
      const off = deps.central!.onDiscover((info) => seen.push(info));
      // The legacy emitter must not receive the subscription.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { NativeEventEmitter } = require('react-native');
      const emitter = NativeEventEmitter.instances[NativeEventEmitter.instances.length - 1];
      emitter.emit('BleManagerDiscoverPeripheral', {
        id: 'aa:bb',
        rssi: -72,
        advertising: { manufacturerData: { ffff: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } },
      });
      expect(seen).toHaveLength(0);
      captured!({
        id: 'aa:bb',
        rssi: -72,
        advertising: { manufacturerData: { ffff: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].id).toBe('aa:bb');
      expect(seen[0].rssi).toBe(-72);
      expect([...seen[0].tag!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      off();
    } finally {
      delete mgr.onDiscoverPeripheral;
    }
  });

  test('notify and disconnect use the codegen methods when present', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mgr = require('react-native-ble-manager').default;
    let notifyCb: ((e: { peripheral?: unknown; value?: unknown }) => void) | null = null;
    let disconnectCb: ((e: { peripheral?: unknown }) => void) | null = null;
    mgr.onDidUpdateValueForCharacteristic = jest.fn((cb) => {
      notifyCb = cb;
      return { remove: jest.fn() };
    });
    mgr.onDisconnectPeripheral = jest.fn((cb) => {
      disconnectCb = cb;
      return { remove: jest.fn() };
    });
    try {
      const deps = defaultBleDeps(async () => true);
      const notified: { id: string; value: Uint8Array }[] = [];
      const disconnected: string[] = [];
      const offN = deps.central!.onNotification((ev) => notified.push(ev));
      const offD = deps.central!.onDisconnect((id) => disconnected.push(id));
      notifyCb!({ peripheral: 'dev1', value: [1, 2, 3] });
      expect(notified).toHaveLength(1);
      expect(notified[0].id).toBe('dev1');
      expect([...notified[0].value]).toEqual([1, 2, 3]);
      disconnectCb!({ peripheral: 'dev2' });
      expect(disconnected).toEqual(['dev2']);
      offN();
      offD();
    } finally {
      delete mgr.onDidUpdateValueForCharacteristic;
      delete mgr.onDisconnectPeripheral;
    }
  });

  test('scan sightings flush a summary line after the window elapses', async () => {
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind: string, detail: string) => lines.push(`${kind}:${detail}`));
    const nowSpy = jest.spyOn(Date, 'now');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mgr = require('react-native-ble-manager').default;
    let captured: ((p: unknown) => void) | null = null;
    mgr.onDiscoverPeripheral = jest.fn((cb: (p: unknown) => void) => {
      captured = cb;
      return { remove: jest.fn() };
    });
    try {
      const deps = defaultBleDeps(async () => true);
      const off = deps.central!.onDiscover(() => {});
      let now = 1_000_000;
      nowSpy.mockImplementation(() => now);
      captured!({ id: 'aa', rssi: -70, advertising: { manufacturerData: { ffff: { bytes: [1, 2, 3, 4, 5, 6, 7, 8] } } } });
      captured!({ id: 'bb', rssi: -71, advertising: {} });
      captured!({ id: 'cc', rssi: -72, advertising: { manufacturerData: { '1234': { bytes: [9, 9] } } } });
      expect(lines.filter((l) => l.includes('sightings'))).toHaveLength(0);
      now += 61_000;
      captured!({ id: 'dd', rssi: -73, advertising: {} });
      const sight = lines.filter((l) => l.includes('sightings'));
      expect(sight).toHaveLength(1);
      expect(sight[0]).toContain('total=4');
      expect(sight[0]).toContain('mesh=1');
      expect(sight[0]).toContain('nonmesh=3');
      expect(sight[0]).toContain('1234:2x1');
      off();
    } finally {
      delete mgr.onDiscoverPeripheral;
      nowSpy.mockRestore();
      setDiagnosticsLogSink(null);
      resetDiagnosticsForTests();
    }
  });

  test('scan sightings from rawData show mesh counts and real md classes', async () => {
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind: string, detail: string) => lines.push(`${kind}:${detail}`));
    const nowSpy = jest.spyOn(Date, 'now');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mgr = require('react-native-ble-manager').default;
    let captured: ((p: unknown) => void) | null = null;
    mgr.onDiscoverPeripheral = jest.fn((cb: (p: unknown) => void) => {
      captured = cb;
      return { remove: jest.fn() };
    });
    try {
      const deps = defaultBleDeps(async () => true);
      const off = deps.central!.onDiscover(() => {});
      let now = 2_000_000;
      nowSpy.mockImplementation(() => now);
      const meshRecord = [0x02, 0x01, 0x06, 0x0b, 0xff, 0xff, 0xff, 1, 2, 3, 4, 5, 6, 7, 8];
      const appleRecord = [0x02, 0x01, 0x06, 0x0b, 0xff, 0x4c, 0x00, 9, 9, 9, 9, 9, 9, 9, 9];
      const nordicRecord = [0x02, 0x01, 0x06, 0x07, 0xff, 0x59, 0x00, 7, 7, 7, 7];
      captured!({ id: 'aa', rssi: -70, advertising: { rawData: { bytes: meshRecord } } });
      captured!({ id: 'bb', rssi: -71, advertising: { rawData: { bytes: appleRecord } } });
      expect(lines.filter((l) => l.includes('sightings'))).toHaveLength(0);
      now += 61_000;
      captured!({ id: 'cc', rssi: -72, advertising: { rawData: { bytes: nordicRecord } } });
      const sight = lines.filter((l) => l.includes('sightings'));
      expect(sight).toHaveLength(1);
      expect(sight[0]).toContain('total=3');
      expect(sight[0]).toContain('mesh=1');
      expect(sight[0]).toContain('nonmesh=2');
      expect(sight[0]).toContain('004c:8x1');
      expect(sight[0]).toContain('0059:4x1');
      off();
    } finally {
      delete mgr.onDiscoverPeripheral;
      nowSpy.mockRestore();
      setDiagnosticsLogSink(null);
      resetDiagnosticsForTests();
    }
  });
});

describe('mesh-scan fix: adapter pre-check', () => {
  test('scan skips the native call when the adapter reports off', async () => {
    const { deps, central } = makeDeps();
    central.adapterState = 'off';
    const port = new GattBlePort(deps);
    await expect(port.scan(() => {})).rejects.toThrow('adapter not on, scan skipped');
    expect(central.scanning).toBe(false);
    await port.close();
  });
});

describe('BLE ACK frame + liveness watchdog (v0.1.36)', () => {
  const EVENT_ID = new Uint8Array(32).fill(0x42);
  const TIMEOUT_ERR = new Error('ble: central connect timed out after 10000ms');

  /** Connect the fake peer, then drop the central link (peer stays sighted + known). */
  async function connectThenDisconnect(
    deps: BleNativeDeps,
    central: FakeCentral,
    port: GattBlePort,
  ): Promise<void> {
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    central.disconnectCb!('ble-1');
    await tick(20);
    expect(port.connectedPeerIds()).toEqual([]);
  }

  test('sightedPeerIds lists a resolved peer after disconnect, empty before it is known', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    expect(port.sightedPeerIds()).toEqual([]);
    // Discovered but never connected: the tag is known, the identity is not.
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    expect(port.sightedPeerIds()).toEqual([PEER_HEX]);
    // After the link drops the peer stays sighted and addressable:
    // the identity is remembered past the connection, and the
    // advertisement is still fresh.
    central.disconnectCb!('ble-1');
    await tick(20);
    expect(port.connectedPeerIds()).toEqual([]);
    expect(port.sightedPeerIds()).toEqual([PEER_HEX]);
    await port.close();
  });

  test('liveness watchdog reconnects a sighted peer with no connection (defect 1)', async () => {
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind: string, detail: string) => lines.push(`${kind}:${detail}`));
    try {
      const { deps, central } = makeDeps();
      const port = new GattBlePort(deps);
      await connectThenDisconnect(deps, central, port);
      expect(central.connectAttempts).toEqual(['ble-1']);
      // No new sighting arrives: the sighting path has nothing to
      // fire on, which is exactly the .35 hole. The watchdog is the
      // only attempter, and it reconnects.
      port.runBleLivenessWatchdog();
      await tick(50);
      expect(central.connectAttempts).toEqual(['ble-1', 'ble-1']);
      expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
      expect(lines.some((l) => l.includes('ble liveness watchdog'))).toBe(true);
      await port.close();
    } finally {
      setDiagnosticsLogSink(null);
      resetDiagnosticsForTests();
    }
  });

  test('liveness watchdog stays quiet when connected, and when the cooldown is active', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    // Connected: nothing to do.
    port.runBleLivenessWatchdog();
    await tick(20);
    expect(central.connectAttempts).toEqual(['ble-1']);
    // Disconnect, then fail the next connect: the cooldown arms.
    central.disconnectCb!('ble-1');
    await tick(20);
    central.failConnect.add('ble-1');
    central.failConnectError = TIMEOUT_ERR;
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts).toEqual(['ble-1', 'ble-1']);
    expect(port.peerCount).toBe(0);
    // Cooldown active (10 s): the watchdog must not storm.
    port.runBleLivenessWatchdog();
    await tick(20);
    expect(central.connectAttempts).toEqual(['ble-1', 'ble-1']);
    await port.close();
  });

  test('fresh-bleId retry: after rotation the retry uses the new address, never the stale one', async () => {
    const { deps, central } = makeDeps();
    const port = new GattBlePort(deps);
    await connectThenDisconnect(deps, central, port);
    central.failConnect.add('ble-1');
    central.failConnect.add('ble-2');
    central.failConnectError = TIMEOUT_ERR;
    // First failure on the old address: one retry is scheduled.
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts).toEqual(['ble-1', 'ble-1']);
    // Address rotation: the same tag is now heard on ble-2. The
    // sighting path attempts the fresh address at once.
    central.discoverCb!({ id: 'ble-2', rssi: -58, tag: PEER_TAG });
    await tick(50);
    expect(central.connectAttempts).toEqual(['ble-1', 'ble-1', 'ble-2']);
    // The scheduled retry fires ~2 s after the first failure. It
    // must re-resolve to ble-2 (the current address), not close over
    // the stale ble-1: ble-1 is attempted exactly twice in total
    // (the good connect plus the one failure), never again.
    await tick(2200);
    expect(central.connectAttempts.filter((id) => id === 'ble-1')).toHaveLength(2);
    expect(central.connectAttempts.filter((id) => id === 'ble-2').length).toBeGreaterThanOrEqual(2);
    expect(port.peerCount).toBe(0);
    await port.close();
  });

  test('radio reset fires once after three timeouts, then attempts resume', async () => {
    const { setDiagnosticsLogSink, resetDiagnosticsForTests } = await import('../diagnostics');
    const lines: string[] = [];
    setDiagnosticsLogSink((kind: string, detail: string) => lines.push(`${kind}:${detail}`));
    try {
      const { deps, central } = makeDeps();
      const port = new GattBlePort(deps);
      await connectThenDisconnect(deps, central, port);
      central.failConnect.add('ble-1');
      central.failConnect.add('ble-2');
      central.failConnectError = TIMEOUT_ERR;
      // Timeout 1 (sighting path, ble-1) and timeout 2 (sighting
      // path after rotation to ble-2): the streak is per tag, so
      // rotation does not reset it.
      central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
      await tick(50);
      central.discoverCb!({ id: 'ble-2', rssi: -58, tag: PEER_TAG });
      await tick(50);
      // Timeout 3 comes from the scheduled retry (~2 s after the
      // first failure), which re-resolves to the fresh ble-2.
      await tick(2200);
      expect(central.connectAttempts.filter((id) => id === 'ble-1')).toHaveLength(2);
      expect(central.connectAttempts.filter((id) => id === 'ble-2').length).toBeGreaterThanOrEqual(2);
      // The watchdog fires the reset even while the cooldown is
      // active (the reset is a one-time radio recovery, not a
      // connect attempt): the scan restarts, exactly once.
      expect(central.scanCalls).toBe(1);
      port.runBleLivenessWatchdog();
      await tick(50);
      expect(central.scanCalls).toBe(2);
      expect(central.stopScanCalls).toBe(1);
      expect(central.scanning).toBe(true);
      expect(lines.some((l) => l.includes('ble radio reset'))).toBe(true);
      // A second watchdog tick does not reset again (once per episode).
      port.runBleLivenessWatchdog();
      await tick(50);
      expect(central.scanCalls).toBe(2);
      expect(central.stopScanCalls).toBe(1);
      expect(port.peerCount).toBe(0);
      await port.close();
    } finally {
      setDiagnosticsLogSink(null);
      resetDiagnosticsForTests();
    }
  });

  test('blind notify reaches a sighted peer with no connection, chunked at the remembered MTU', async () => {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await connectThenDisconnect(deps, central, port);
    // The peer is sighted but unconnected; the remembered MTU is 512
    // (negotiated at connect), so a 600-byte frame chunks at 509
    // bytes: 2 chunks, not the ~31 the ATT default of 23 would give.
    const frame = new Uint8Array(600).fill(0x55);
    await port.notifyUnconnected(PEER_HEX, frame);
    expect(peripheral.notified).toHaveLength(2);
    const datagrams = peripheral.notifiedDatagrams();
    expect(datagrams).toHaveLength(1);
    expect(datagrams[0][0]).toBe(DATAGRAM_FRAME);
    expect(datagrams[0].slice(1)).toEqual(frame);
    // Unknown peer: fail closed.
    await expect(port.notifyUnconnected('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', frame)).rejects.toThrow(
      /unknown peer/,
    );
    await port.close();
  });

  test('ack frame: sendAck notifies the event id, inbound ack reaches subscribers, malformed acks drop', async () => {
    const { deps, central, peripheral } = makeDeps();
    const port = new GattBlePort(deps);
    await port.advertise(OWN_HEX);
    await port.scan(() => {});
    central.discoverCb!({ id: 'ble-1', rssi: -60, tag: PEER_TAG });
    await tick(50);
    expect(port.connectedPeerIds()).toEqual([PEER_HEX]);
    const acks: { peerId: string; eventId: Uint8Array }[] = [];
    const unsub = port.onAck((peerId, eventId) => acks.push({ peerId, eventId }));
    // Outbound: the ack notifies as a datagram on our TX.
    await port.sendAck(PEER_HEX, EVENT_ID);
    const sent = peripheral.notifiedDatagrams();
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe(DATAGRAM_ACK);
    expect(sent[0].slice(1)).toEqual(EVENT_ID);
    // Inbound: an ack frame arriving as a TX notification reaches subscribers.
    central.notifyCb!({ id: 'ble-1', value: encodeDatagram(DATAGRAM_ACK, EVENT_ID) });
    expect(acks).toHaveLength(1);
    expect(acks[0].peerId).toBe(PEER_HEX);
    expect(acks[0].eventId).toEqual(EVENT_ID);
    // Malformed ack (31 bytes, not 32) is dropped silently.
    central.notifyCb!({ id: 'ble-1', value: encodeDatagram(DATAGRAM_ACK, new Uint8Array(31).fill(1)) });
    expect(acks).toHaveLength(1);
    // Unsubscribe stops delivery.
    unsub();
    central.notifyCb!({ id: 'ble-1', value: encodeDatagram(DATAGRAM_ACK, EVENT_ID) });
    expect(acks).toHaveLength(1);
    // sendAck to an unknown peer throws.
    await expect(port.sendAck('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', EVENT_ID)).rejects.toThrow(
      /unknown peer/,
    );
    await port.close();
  });
});
