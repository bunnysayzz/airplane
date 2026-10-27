// SPDX-License-Identifier: Apache-2.0
// Real BLE GATT TransportPort for Android (the offline mesh itself).
//
// Roles: every phone is BOTH central and peripheral.
//   - Central (react-native-ble-manager 12.6.0): scan, connect, GATT client.
//     Writes frames to the peer's RX characteristic; receives the peer's
//     frames via notifications on its TX characteristic.
//   - Peripheral (react-native-multi-ble-peripheral 0.1.8): advertise +
//     GATT server. Receives frames as writes to our RX characteristic;
//     sends frames via TX notifications (broadcast to all subscribed
//     centrals - see limitation below).
//
// Connection rule: on discovering a peer tag, the phone whose own tag is
// lexicographically smaller (or equal) initiates the central connection.
// Deterministic, so one connection exists per pair in the common case.
//
// Identity: advertise tag = first 8 bytes of the Ed25519 pubkey (discovery
// hint). Full peerId (64-char hex pubkey) is resolved after connect - the
// central reads our IDENT characteristic, and writes a hello datagram so
// the peripheral side learns the central's identity + ATT MTU.
//
// Port-layer framing (below the protocol fragment layer): every send() frame
// is wrapped as u16be(len) || kind || payload and chunked to (link MTU - 3)
// ATT PDUs; the receiver reassembles per remote. See ble/profile.ts.
//
// Defensive by design (like NetInfo in transport.ts): the native libraries
// are lazy-required; when missing/broken or permissions are denied, every
// method fails closed (descriptive Error or inert no-op) and NEVER crashes
// the app. The transport manager catches and runs Nostr-only.
//
// RADIO-UNVERIFIED: implemented against the libraries' published sources
// and unit tests with fake adapters. No two physical devices exist in this
// environment, so no over-the-air frame has ever flowed through this code.
// Multi-phone interop stays an open item for Tuba's two-phone test.
//
// Known limitations (honest):
// - TX notify() broadcasts to ALL subscribed centrals; send() to one
//   peripheral-role peer also reaches the others. The mesh dedupes by event
//   ID (SeenCache), so this wastes bandwidth, not correctness.
// - Peripheral-role inbound writes are attributed by central BT address;
//   before the hello arrives the peer id is provisional (`mac:<addr>`).
// - Scan has no hardware filter in v1 (see profile.ts); software-filtered.
// - react-native-multi-ble-peripheral is a v0.x single-maintainer library;
//   the peripheral half is the highest-risk dependency in this file.

import type { PeerInfo, TransportPort } from '@airplane/protocol';
import { FRAG_WIRE_MAX, fromHex, toHex } from '@airplane/protocol';
import {
  recordAdvertiseFailure,
  recordAdvertiseStopped,
  recordAdvertiseSuccess,
  recordFragmentsReceived,
  recordFragmentsSent,
  recordIncompleteFragmentSet,
  recordPacketReceived,
  recordPacketSent,
  recordPeerConnected,
  recordPeerDisconnected,
  recordPeerResolved,
  recordPeerSeen,
  recordScanFailure,
  recordScanStarted,
  recordScanStopped,
} from '../diagnostics';
import { Buffer } from 'buffer';
import {
  ADVERTISE_COMPANY_ID,
  ATT_DEFAULT_MTU,
  ATT_OVERHEAD,
  ATT_REQUEST_MTU,
  DATAGRAM_FRAME,
  DATAGRAM_HELLO,
  MAX_BLE_PEERS,
  MESH_IDENT_CHAR_UUID,
  MESH_RX_CHAR_UUID,
  MESH_SERVICE_UUID,
  MESH_TX_CHAR_UUID,
  DatagramReassembler,
  chunkBytes,
  compareTags,
  encodeDatagram,
  encodeHello,
  parseHello,
  peerTagOf,
} from './profile';

/** Central-role native surface (react-native-ble-manager shaped). */
export interface CentralAdapter {
  start(): Promise<void>;
  scan(): Promise<void>;
  stopScan(): Promise<void>;
  onDiscover(cb: (info: { id: string; rssi: number; tag: Uint8Array | null }) => void): () => void;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  retrieveServices(id: string): Promise<void>;
  requestMtu(id: string, mtu: number): Promise<number>;
  read(id: string, serviceUuid: string, charUuid: string): Promise<Uint8Array>;
  write(id: string, serviceUuid: string, charUuid: string, chunk: Uint8Array): Promise<void>;
  startNotification(id: string, serviceUuid: string, charUuid: string): Promise<void>;
  onNotification(cb: (ev: { id: string; value: Uint8Array }) => void): () => void;
  onDisconnect(cb: (id: string) => void): () => void;
}

/** Peripheral-role native surface (react-native-multi-ble-peripheral shaped). */
export interface PeripheralAdapter {
  startAdvertising(tag: Uint8Array, identHex: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  onWrite(cb: (ev: { device: string; value: Uint8Array }) => void): () => void;
  notify(chunk: Uint8Array): Promise<void>;
  destroy(): Promise<void>;
}

/** Injected native dependencies. Null = that role is unavailable (fail closed). */
export interface BleNativeDeps {
  central: CentralAdapter | null;
  createPeripheral: (() => Promise<PeripheralAdapter>) | null;
  requestPermissions: () => Promise<boolean>;
}

type Role = 'central' | 'peripheral';

interface PeerConn {
  role: Role;
  /** ble-manager peripheral id (central) or central BT address (peripheral). */
  bleId: string;
  tag: Uint8Array | null;
  peerId: string | null;
  /** ATT MTU for this link; chunk size = mtu - 3. */
  mtu: number;
  inbound: DatagramReassembler;
  /** True while an ATT chunk arrived without completing a datagram. */
  partialOpen: boolean;
}

const PROVISIONAL_TAG_PREFIX = 'tag:';
const PROVISIONAL_MAC_PREFIX = 'mac:';
const HEX64_RE = /^[0-9a-f]{64}$/;

function provisionalTagKey(tag: Uint8Array): string {
  return `${PROVISIONAL_TAG_PREFIX}${toHex(tag)}`;
}

function isProvisionalKey(key: string): boolean {
  return key.startsWith(PROVISIONAL_TAG_PREFIX) || key.startsWith(PROVISIONAL_MAC_PREFIX);
}

/**
 * Describe an advertise failure for diagnostics. Native peripheral errors
 * can arrive as null, undefined, or an Error with an empty message (the
 * R2 run's "null BluetoothGattServer addService" case); those must not
 * be recorded verbatim, or diagnostics shows a meaningless "null".
 */
export function describeAdvertiseError(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return `ble: advertise failed: ${err.message}`;
  if (typeof err === 'string' && err.trim() !== '' && err !== 'null' && err !== 'undefined') {
    return `ble: advertise failed: ${err}`;
  }
  return 'ble: advertise failed: native error was empty (null/undefined) - check Bluetooth on, peripheral support, and the Diagnostics retry';
}

export class GattBlePort implements TransportPort {
  private ownPeerId: string | null = null;
  private ownTag: Uint8Array | null = null;
  private readonly conns = new Map<string, PeerConn>();
  private readonly bleIndex = new Map<string, string>(); // bleId -> conn key
  private readonly discovered = new Map<string, { bleId: string; tag: Uint8Array; rssi: number }>();
  private readonly receivers = new Set<(peerId: string, bytes: Uint8Array) => void>();
  private readonly scanSubs = new Set<(peer: PeerInfo) => void>();
  private scanUnsub: (() => void) | null = null;
  private centralStarted = false;
  private peripheral: PeripheralAdapter | null = null;
  private readonly peripheralUnsubs: (() => void)[] = [];
  private centralUnsubs: (() => void)[] = [];

  constructor(private readonly deps: BleNativeDeps) {}

  // ---------------------------------------------------------------- advertise

  /**
   * Start advertising our peerId. Idempotent for the same peerId.
   * Throws a descriptive Error when the radio is unavailable (permissions
   * denied, peripheral lib missing/broken) - the caller runs Nostr-only.
   */
  async advertise(peerId: string): Promise<void> {
    if (!HEX64_RE.test(peerId)) throw new Error('ble: advertise needs a 64-char hex peerId');
    if (this.peripheral && this.ownPeerId === peerId) return;
    await this.stopAdvertise();
    const granted = await this.deps.requestPermissions().catch(() => false);
    if (!granted) {
      recordAdvertiseFailure('bluetooth permissions not granted');
      throw new Error('ble: bluetooth permissions not granted');
    }
    const factory = this.deps.createPeripheral;
    if (!factory) {
      recordAdvertiseFailure('peripheral role unavailable (native module missing)');
      throw new Error('ble: peripheral role unavailable (native module missing)');
    }
    const tag = peerTagOf(fromHex(peerId));
    let adapter: PeripheralAdapter | null = null;
    try {
      adapter = await factory();
      await adapter.startAdvertising(tag, peerId);
    } catch (err) {
      await adapter?.destroy().catch(() => {});
      // R3: the R2 device run surfaced this failure as a bare "null"
      // (a native BluetoothGattServer error with no message). A null
      // rejection must never reach diagnostics as "null": describe it,
      // record it, and throw an Error carrying the description, so the
      // next device run shows which stage failed instead of a blank.
      const message = describeAdvertiseError(err);
      recordAdvertiseFailure(message);
      throw new Error(message);
    }
    // Advertisement length on the air: AD header (2 bytes) + company id
    // (2 bytes) + 8-byte tag = 12 bytes, inside the 31-byte legacy budget.
    recordAdvertiseSuccess(2 + 2 + tag.length);
    this.peripheral = adapter;
    this.ownPeerId = peerId;
    this.ownTag = peerTagOf(fromHex(peerId));
    this.peripheralUnsubs.push(
      adapter.onWrite(({ device, value }) => this.onPeripheralWrite(device, value)),
    );
  }

  async stopAdvertise(): Promise<void> {
    for (const u of this.peripheralUnsubs.splice(0)) {
      try {
        u();
      } catch {
        // ignore
      }
    }
    const p = this.peripheral;
    this.peripheral = null;
    this.ownPeerId = null;
    this.ownTag = null;
    if (p) {
      await p.stopAdvertising().catch(() => {});
      await p.destroy().catch(() => {});
    }
    recordAdvertiseStopped();
    // Forget peripheral-role conns (their radio is gone); central-role conns
    // survive - the GATT client is independent of our advertiser.
    for (const [key, conn] of [...this.conns]) {
      if (conn.role === 'peripheral') this.dropConn(key);
    }
  }

  // --------------------------------------------------------------------- scan

  /**
   * Start scanning; onPeer fires for each discovered mesh peer (provisional
   * `tag:<hex>` id until the full peerId resolves, then again with it).
   * Resolves to an unsubscribe function. Inert no-op when central is
   * unavailable.
   */
  async scan(onPeer: (peer: PeerInfo) => void): Promise<() => void> {
    this.scanSubs.add(onPeer);
    if (!this.scanUnsub) {
      await this.ensureCentral();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.scanSubs.delete(onPeer);
      if (this.scanSubs.size === 0) {
        const u = this.scanUnsub;
        this.scanUnsub = null;
        void this.deps.central?.stopScan().catch(() => {});
        recordScanStopped();
        u?.();
      }
    };
  }

  private async ensureCentral(): Promise<void> {
    const central = this.deps.central;
    if (!central) return; // scan stays inert; unsub still works
    if (!this.centralStarted) {
      await central.start();
      this.centralStarted = true;
      this.centralUnsubs.push(
        central.onDiscover((info) => this.onDiscover(info)),
        central.onNotification(({ id, value }) => this.onCentralNotify(id, value)),
        central.onDisconnect((id) => this.onCentralDisconnect(id)),
      );
    }
    try {
      await central.scan();
    } catch (err) {
      recordScanFailure(err instanceof Error ? err.message : String(err));
      throw err;
    }
    recordScanStarted();
    this.scanUnsub = () => {
      for (const u of this.centralUnsubs.splice(0)) {
        try {
          u();
        } catch {
          // ignore
        }
      }
      this.centralStarted = false;
    };
  }

  private onDiscover(info: { id: string; rssi: number; tag: Uint8Array | null }): void {
    const { id, rssi, tag } = info;
    if (!id || !tag || tag.length !== 8) return; // not a mesh peer
    if (this.ownTag && toHex(tag) === toHex(this.ownTag)) return; // self
    const key = provisionalTagKey(tag);
    const known = this.discovered.get(key);
    this.discovered.set(key, { bleId: id, tag, rssi });
    recordPeerSeen(key, rssi, toHex(tag));
    if (!known) {
      for (const cb of this.scanSubs) {
        try {
          cb({ peerId: key, rssi });
        } catch {
          // subscriber errors must not break discovery
        }
      }
    }
    if (this.conns.size >= MAX_BLE_PEERS) return;
    if (this.bleIndex.has(id)) return; // already connecting/connected
    // Tie-break: smaller (or equal) tag initiates the central connection.
    if (this.ownTag && compareTags(this.ownTag, tag) <= 0) {
      void this.connectCentral(id, tag).catch(() => {
        // connect failures are routine (peer walked away); stay silent
      });
    }
  }

  // ------------------------------------------------------------------ connect

  /** Connect to a discovered peer (provisional `tag:<hex>` id or full peerId). */
  async connect(peerId: string): Promise<void> {
    if (this.conns.has(peerId)) return;
    for (const conn of this.conns.values()) {
      if (conn.peerId === peerId) return;
    }
    const disc = this.discovered.get(peerId);
    if (!disc) throw new Error(`ble: unknown peer ${peerId}`);
    if (!this.deps.central) throw new Error('ble: central role unavailable');
    await this.connectCentral(disc.bleId, disc.tag);
  }

  private async connectCentral(bleId: string, tag: Uint8Array): Promise<void> {
    const central = this.deps.central;
    if (!central) throw new Error('ble: central role unavailable');
    if (this.bleIndex.has(bleId)) return;
    if (!this.ownPeerId) throw new Error('ble: advertise() must run before connect');
    if (this.conns.size >= MAX_BLE_PEERS) throw new Error('ble: peer limit reached');
    await central.connect(bleId);
    try {
      await central.retrieveServices(bleId);
      let mtu = ATT_DEFAULT_MTU;
      try {
        const negotiated = await central.requestMtu(bleId, ATT_REQUEST_MTU);
        if (Number.isInteger(negotiated) && negotiated >= ATT_DEFAULT_MTU) mtu = negotiated;
      } catch {
        // keep default 23
      }
      const identRaw = await central.read(bleId, MESH_SERVICE_UUID, MESH_IDENT_CHAR_UUID);
      const peerId = new TextDecoder().decode(identRaw);
      if (!HEX64_RE.test(peerId)) throw new Error('ble: peer IDENT malformed');
      // Register before the hello so any inbound traffic is attributed.
      // Keyed by the full peerId (known from IDENT) - not the provisional
      // tag key - so send()/disconnect() resolve by peerId.
      this.registerConn(peerId, {
        role: 'central',
        bleId,
        tag,
        peerId,
        mtu,
        inbound: new DatagramReassembler(),
        partialOpen: false,
      });
      // Announce ourselves: the peripheral side learns our identity + MTU.
      const hello = encodeHello(fromHex(this.ownPeerId), mtu);
      for (const chunk of chunkBytes(hello, mtu - ATT_OVERHEAD)) {
        await central.write(bleId, MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, chunk);
      }
      await central.startNotification(bleId, MESH_SERVICE_UUID, MESH_TX_CHAR_UUID);
      // Subscribed to the peer TX characteristic: CCCD is on for this link.
      recordPeerConnected(peerId, mtu, true);
      // Surface the resolved identity through the scan channel, matching
      // the peripheral-side hello path: subscribers see the full peerId,
      // not just the provisional tag key. (Previously the central side
      // never re-fired, so the scan channel only ever resolved identities
      // learned via inbound hellos.)
      for (const cb of this.scanSubs) {
        try {
          cb({ peerId });
        } catch {
          // subscriber errors must not break connect
        }
      }
    } catch (err) {
      await central.disconnect(bleId).catch(() => {});
      throw err instanceof Error ? err : new Error(`ble: connect failed: ${String(err)}`);
    }
  }

  async disconnect(peerId: string): Promise<void> {
    const conn = this.conns.get(peerId);
    if (!conn) return;
    const key = this.keyOf(conn);
    this.dropConn(key);
    if (conn.role === 'central') {
      await this.deps.central?.disconnect(conn.bleId).catch(() => {});
    }
    // Peripheral role: this library exposes no force-disconnect; forgetting
    // the mapping is the honest close. The central will time out or go away.
  }

  // --------------------------------------------------------------------- send

  /**
   * Send one raw frame (must fit frameSizeFor) to a connected peer.
   * Throws when the peer is unknown or the radio is gone - BleTransport
   * treats per-peer send failures as non-fatal.
   */
  async send(peerId: string, frame: Uint8Array): Promise<void> {
    const conn = this.conns.get(peerId);
    if (!conn) throw new Error(`ble: unknown peer ${peerId}`);
    const datagram = encodeDatagram(DATAGRAM_FRAME, frame);
    const chunkSize = Math.max(conn.mtu - ATT_OVERHEAD, 1);
    if (conn.role === 'central') {
      const central = this.deps.central;
      if (!central) throw new Error('ble: central role unavailable');
      for (const chunk of chunkBytes(datagram, chunkSize)) {
        await central.write(conn.bleId, MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, chunk);
        recordFragmentsSent(peerId, 1);
      }
      recordPacketSent(peerId);
      return;
    }
    const peripheral = this.peripheral;
    if (!peripheral) throw new Error('ble: peripheral role unavailable');
    // NOTE: notify() broadcasts to ALL subscribed centrals (library
    // limitation); non-target peers drop the frames at the mesh layer via
    // event-ID dedup. Bandwidth-inefficient, not incorrect.
    for (const chunk of chunkBytes(datagram, chunkSize)) {
      await peripheral.notify(chunk);
      recordFragmentsSent(peerId, 1);
    }
    recordPacketSent(peerId);
  }

  /** Max bytes send() accepts for this peer: the protocol wire-frame max. */
  frameSizeFor(_peerId: string): number {
    // The port chunks datagrams to the link MTU itself, so the protocol
    // frame size stays at the wire-spec maximum on every link.
    return FRAG_WIRE_MAX;
  }

  // ------------------------------------------------------------------ receive

  onReceive(cb: (peerId: string, bytes: Uint8Array) => void): () => void {
    this.receivers.add(cb);
    return () => {
      this.receivers.delete(cb);
    };
  }

  /** Feed one ATT chunk into a connection, tracking fragments and partial sets. */
  private feedChunk(conn: PeerConn, key: string, value: Uint8Array): void {
    const peerKey = conn.peerId ?? key;
    recordFragmentsReceived(peerKey, 1);
    const datagrams = conn.inbound.push(value);
    if (datagrams.length === 0) {
      if (!conn.partialOpen) {
        conn.partialOpen = true;
        recordIncompleteFragmentSet(peerKey);
      }
      return;
    }
    conn.partialOpen = false;
    for (const dg of datagrams) this.dispatchDatagram(conn, dg);
  }

  /** Central role: frames arriving as TX notifications from a peer. */
  private onCentralNotify(bleId: string, value: Uint8Array): void {
    const key = this.bleIndex.get(bleId);
    const conn = key ? this.conns.get(key) : undefined;
    if (!key || !conn) return;
    this.feedChunk(conn, key, value);
  }

  /** Peripheral role: a central wrote to our RX characteristic. */
  private onPeripheralWrite(device: string, value: Uint8Array): void {
    let key = this.bleIndex.get(device);
    let conn = key ? this.conns.get(key) : undefined;
    if (!conn) {
      if (this.conns.size >= MAX_BLE_PEERS) return; // drop, bounded
      key = `${PROVISIONAL_MAC_PREFIX}${device}`;
      conn = { role: 'peripheral', bleId: device, tag: null, peerId: null, mtu: ATT_DEFAULT_MTU, inbound: new DatagramReassembler(), partialOpen: false };
      this.registerConn(key, conn);
      // A central is writing to us, but the library does not report
      // whether it subscribed to our TX characteristic: CCCD stays unknown.
      recordPeerConnected(key, ATT_DEFAULT_MTU, null);
    }
    if (!key) return;
    this.feedChunk(conn, key, value);
  }

  private dispatchDatagram(conn: PeerConn, dg: Uint8Array): void {
    if (dg.length < 1) return;
    const kind = dg[0];
    const payload = dg.slice(1);
    if (kind === DATAGRAM_HELLO) {
      const hello = parseHello(payload);
      if (!hello) return;
      const peerId = toHex(hello.publicKey);
      conn.mtu = Math.min(Math.max(hello.centralMtu, ATT_DEFAULT_MTU), 517);
      this.rekeyConn(conn, peerId);
      // The peripheral side learns the central identity and MTU here.
      // CCCD stays unknown: the library does not report TX subscribers.
      recordPeerConnected(peerId, conn.mtu, null);
      // Surface the resolved identity through the scan channel.
      for (const cb of this.scanSubs) {
        try {
          cb({ peerId });
        } catch {
          // ignore
        }
      }
      return;
    }
    if (kind !== DATAGRAM_FRAME) return; // unknown kind - drop
    const peerKey = conn.peerId ?? this.keyOf(conn);
    recordPacketReceived(peerKey);
    for (const cb of this.receivers) {
      try {
        cb(peerKey, payload);
      } catch {
        // receiver errors must not break the port
      }
    }
  }

  private onCentralDisconnect(bleId: string): void {
    const key = this.bleIndex.get(bleId);
    if (key) this.dropConn(key);
  }

  // --------------------------------------------------------------- registry

  private keyOf(conn: PeerConn): string {
    for (const [key, c] of this.conns) {
      if (c === conn) return key;
    }
    return conn.peerId ?? (conn.tag ? provisionalTagKey(conn.tag) : `${PROVISIONAL_MAC_PREFIX}${conn.bleId}`);
  }

  private registerConn(key: string, conn: PeerConn): void {
    const existing = this.conns.get(key);
    if (existing && existing !== conn) this.dropConn(key);
    this.conns.set(key, conn);
    this.bleIndex.set(conn.bleId, key);
  }

  private rekeyConn(conn: PeerConn, peerId: string): void {
    const oldKey = this.keyOf(conn);
    if (!isProvisionalKey(oldKey)) return; // already keyed by full id
    recordPeerResolved(oldKey, peerId);
    const clash = this.conns.get(peerId);
    if (clash && clash !== conn && clash.role === 'central' && conn.role === 'peripheral') {
      // A central-role conn already covers this peer (targeted writes beat
      // broadcast notify); drop the peripheral-role duplicate entirely.
      this.dropConn(oldKey);
      return;
    }
    conn.peerId = peerId;
    this.conns.delete(oldKey);
    this.conns.set(peerId, conn);
    this.bleIndex.set(conn.bleId, peerId);
  }

  private dropConn(key: string): void {
    const conn = this.conns.get(key);
    if (!conn) return;
    recordPeerDisconnected(key);
    this.conns.delete(key);
    if (this.bleIndex.get(conn.bleId) === key) this.bleIndex.delete(conn.bleId);
  }

  // ------------------------------------------------------------------ close

  /** Full teardown: stop scan, drop all conns, stop advertising. */
  async close(): Promise<void> {
    const unsub = this.scanUnsub;
    this.scanUnsub = null;
    this.scanSubs.clear();
    recordScanStopped();
    uSafe(unsub);
    await this.deps.central?.stopScan().catch(() => {});
    for (const u of this.centralUnsubs.splice(0)) uSafe(u);
    this.centralStarted = false;
    for (const key of [...this.conns.keys()]) {
      const conn = this.conns.get(key);
      this.dropConn(key);
      if (conn?.role === 'central') {
        await this.deps.central?.disconnect(conn.bleId).catch(() => {});
      }
    }
    this.discovered.clear();
    await this.stopAdvertise();
  }

  /** Connected peer count (for tests/diagnostics). */
  get peerCount(): number {
    return this.conns.size;
  }

  /**
   * Full peerIds of established connections (deduped). Provisional ids
   * (tag:/mac: keys) are excluded: only peers whose full identity has been
   * resolved can receive frames, so this is exactly the set publish targets.
   */
  connectedPeerIds(): string[] {
    const ids = new Set<string>();
    for (const conn of this.conns.values()) {
      if (conn.peerId) ids.add(conn.peerId);
    }
    return [...ids];
  }
}

function uSafe(u: (() => void) | null | undefined): void {
  if (!u) return;
  try {
    u();
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Native library loading (lazy; never throws)
// ---------------------------------------------------------------------------

/** Extract the 8-byte mesh tag from a ble-manager discover event. */
export function extractTag(peripheral: unknown): Uint8Array | null {
  try {
    const p = peripheral as {
      advertising?: { manufacturerData?: Record<string, { bytes?: number[]; data?: string }> };
    };
    const md = p?.advertising?.manufacturerData;
    if (!md) return null;
    // ble-manager 12.6.0 on Android keys manufacturerData by lowercase hex
    // ("%04x"), NOT by decimal company id: 0xFFFF arrives as "ffff". A
    // decimal-only lookup silently drops every mesh peer (the two-phone
    // "0 nearby" failure: discovery never saw a single peer). Try the real
    // native hex key first, then decimal/numeric for robustness.
    const hexKey = ADVERTISE_COMPANY_ID.toString(16).padStart(4, '0');
    const entry = md[hexKey] ?? md[String(ADVERTISE_COMPANY_ID)] ?? md[ADVERTISE_COMPANY_ID];
    const bytes = entry?.bytes;
    if (Array.isArray(bytes) && bytes.length === 8) return new Uint8Array(bytes);
    // Fallback: some shapes carry only base64 data.
    if (typeof entry?.data === 'string') {
      const decoded = Buffer.from(entry.data, 'base64');
      if (decoded.length === 8) return new Uint8Array(decoded);
    }
    return null;
  } catch {
    return null;
  }
}

function loadCentralAdapter(): CentralAdapter | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-ble-manager');
    const mgr = mod?.default ?? mod;
    if (!mgr || typeof mgr.start !== 'function') return null;
    if (!rn?.NativeModules || typeof rn.NativeEventEmitter !== 'function') return null;
    const emitter = new rn.NativeEventEmitter(rn.NativeModules.BleManager);
    return {
      start: () => mgr.start({ showAlert: false }),
      // R3 scan audit: ble-manager's scan is POSITIONAL,
      // scan(serviceUUIDs, seconds, allowDuplicates, scanningOptions).
      // The old call mgr.scan({ scanMode: 2 }) passed the options object
      // as the serviceUUIDs argument, so LowLatency never applied and
      // discovery ran at the default LowPower pace. Correct form:
      // serviceUUIDs [] (UNFILTERED, deliberately: the advertise packet
      // carries manufacturer data only, no service UUID, so a UUID
      // filter would never match a mesh peer; the JS layer filters by
      // manufacturer data in extractTag/onDiscover), seconds 0
      // (indefinite until stopScan), allowDuplicates false (iOS only),
      // scanningOptions { scanMode: 2 } (Android SCAN_MODE_LOW_LATENCY).
      // Battery trade-off, taken deliberately: fast discovery is the
      // mesh's core promise.
      scan: () => mgr.scan([], 0, false, { scanMode: 2 }),
      stopScan: () => mgr.stopScan(),
      onDiscover: (cb) => {
        const sub = emitter.addListener('BleManagerDiscoverPeripheral', (p: unknown) =>
          cb({
            id: String((p as { id?: unknown })?.id ?? ''),
            rssi: typeof (p as { rssi?: unknown })?.rssi === 'number' ? ((p as { rssi: number }).rssi as number) : 0,
            tag: extractTag(p),
          }),
        );
        return () => sub.remove();
      },
      connect: (id) => mgr.connect(id),
      disconnect: (id) => mgr.disconnect(id),
      retrieveServices: (id) => mgr.retrieveServices(id),
      requestMtu: async (id, mtu) => {
        const v: unknown = await mgr.requestMTU(id, mtu);
        return typeof v === 'number' && Number.isInteger(v) && v >= ATT_DEFAULT_MTU ? v : ATT_DEFAULT_MTU;
      },
      read: async (id, serviceUuid, charUuid) => new Uint8Array((await mgr.read(id, serviceUuid, charUuid)) as number[]),
      write: (id, serviceUuid, charUuid, chunk) => mgr.write(id, serviceUuid, charUuid, Array.from(chunk), chunk.length),
      startNotification: (id, serviceUuid, charUuid) => mgr.startNotification(id, serviceUuid, charUuid),
      onNotification: (cb) => {
        const sub = emitter.addListener('BleManagerDidUpdateValueForCharacteristic', (e: unknown) => {
          const ev = e as { peripheral?: unknown; value?: unknown };
          const raw = ev?.value;
          let bytes: Uint8Array | null = null;
          if (Array.isArray(raw)) bytes = new Uint8Array(raw as number[]);
          else if (typeof raw === 'string') {
            bytes = base64ToBytes(raw);
          }
          if (bytes) cb({ id: String(ev?.peripheral ?? ''), value: bytes });
        });
        return () => sub.remove();
      },
      onDisconnect: (cb) => {
        const sub = emitter.addListener('BleManagerDisconnectPeripheral', (e: unknown) => {
          const periph = (e as { peripheral?: unknown })?.peripheral;
          if (periph) cb(String(periph));
        });
        return () => sub.remove();
      },
    };
  } catch {
    return null;
  }
}

function base64ToBytes(s: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(s, 'base64'));
  } catch {
    return null;
  }
}

function loadPeripheralFactory(): (() => Promise<PeripheralAdapter>) | null {
  let PeripheralClass: new () => {
    once(ev: string, cb: (arg?: unknown) => void): void;
    addService(uuid: string, primary: boolean): Promise<unknown>;
    addCharacteristic(svc: string, uuid: string, props: number, perms: number): Promise<unknown>;
    updateValue(svc: string, uuid: string, value: unknown): Promise<unknown>;
    startAdvertising(services: unknown, options: unknown): Promise<unknown>;
    stopAdvertising(): Promise<unknown>;
    on(ev: string, cb: (arg: never) => void): void;
    sendNotification(svc: string, uuid: string, value: unknown, confirm: boolean): Promise<unknown>;
    destroy(): Promise<unknown>;
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-multi-ble-peripheral');
    const cls = mod?.default ?? mod;
    if (typeof cls !== 'function') return null;
    PeripheralClass = cls;
  } catch {
    return null;
  }
  // GATT characteristic property/permission flags (Android values; the
  // library's own enums mirror these).
  const PROP_READ = 2;
  const PROP_WRITE_NO_RESPONSE = 4;
  const PROP_WRITE = 8;
  const PROP_NOTIFY = 16;
  const PERM_READ = 0x01;
  const PERM_WRITE = 0x10;
  return async (): Promise<PeripheralAdapter> => {
    const inst = new PeripheralClass(); // throws when the native module is not linked
    await new Promise<void>((resolve, reject) => {
      inst.once('ready', () => resolve());
      inst.once('error', (err: unknown) =>
        reject(new Error(describeAdvertiseError(err).replace('ble: advertise failed: ', 'ble: peripheral ready failed: '))),
      );
    });
    return {
      startAdvertising: async (tag, identHex) => {
        // R3: stage-tag every native step. The R2 run's failure was a
        // null BluetoothGattServer error with no stage attached, so the
        // next device run must show whether addService, a characteristic,
        // the IDENT value, or startAdvertising itself failed.
        const stages: [string, () => Promise<unknown>][] = [
          ['addService', () => inst.addService(MESH_SERVICE_UUID, true)],
          [
            'addCharacteristic RX',
            () => inst.addCharacteristic(MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, PROP_WRITE | PROP_WRITE_NO_RESPONSE, PERM_WRITE),
          ],
          [
            'addCharacteristic TX',
            () => inst.addCharacteristic(MESH_SERVICE_UUID, MESH_TX_CHAR_UUID, PROP_NOTIFY | PROP_READ, PERM_READ),
          ],
          [
            'addCharacteristic IDENT',
            () => inst.addCharacteristic(MESH_SERVICE_UUID, MESH_IDENT_CHAR_UUID, PROP_READ | PROP_WRITE, PERM_READ | PERM_WRITE),
          ],
          ['updateValue IDENT', () => inst.updateValue(MESH_SERVICE_UUID, MESH_IDENT_CHAR_UUID, Buffer.from(identHex, 'ascii'))],
          [
            'startAdvertising',
            () =>
              inst.startAdvertising(
                { connectable: true, includeDeviceName: false, manufacturerId: ADVERTISE_COMPANY_ID, manufacturerData: Buffer.from(tag) },
                undefined,
              ),
          ],
        ];
        for (const [stage, run] of stages) {
          try {
            await run();
          } catch (err) {
            throw new Error(`ble: advertise failed at ${stage}: ${describeAdvertiseError(err).replace('ble: advertise failed: ', '')}`);
          }
        }
        // Advertise manufacturer data only (12 bytes): the 128-bit service
        // UUID cannot share the 31-byte legacy packet with service data.
      },
      stopAdvertising: async () => {
        await inst.stopAdvertising();
      },
      onWrite: (cb) => {
        // NOTE: the lib's TS WriteEvent type is wrong; at runtime the event
        // carries {device, service, characteristic, offset, value(base64)}.
        const handler = (ev: never) => {
          const e = ev as unknown as { device?: unknown; value?: unknown };
          const raw = e?.value;
          let bytes: Uint8Array | null = null;
          if (typeof raw === 'string') bytes = base64ToBytes(raw);
          else if (Array.isArray(raw)) bytes = new Uint8Array(raw as number[]);
          if (bytes && typeof e?.device === 'string') cb({ device: e.device, value: bytes });
        };
        inst.on('write', handler);
        return () => {
          // eventemitter3 removal: the lib extends EventEmitter.
          (inst as unknown as { removeListener(ev: string, cb: unknown): void }).removeListener('write', handler);
        };
      },
      notify: async (chunk) => {
        await inst.sendNotification(MESH_SERVICE_UUID, MESH_TX_CHAR_UUID, Buffer.from(chunk), false);
      },
      destroy: async () => {
        await inst.destroy();
      },
    };
  };
}

/**
 * Default native dependencies: lazy-require both BLE libraries, never throw.
 * Null roles mean the port fails closed for that role.
 */
export function defaultBleDeps(requestPermissions: () => Promise<boolean>): BleNativeDeps {
  return {
    central: loadCentralAdapter(),
    createPeripheral: loadPeripheralFactory(),
    requestPermissions,
  };
}
