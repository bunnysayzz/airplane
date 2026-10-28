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
  recordConnectFailure,
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
  /**
   * Without-response write (ble-manager 12.6.0 writeWithoutResponse,
   * verified in the installed package source). Used for RX frame chunks
   * in send(), where no per-chunk acknowledgement is needed; hello
   * writes keep with-response writes. Absent on older shapes.
   */
  writeWithoutResponse?(id: string, serviceUuid: string, charUuid: string, chunk: Uint8Array): Promise<void>;
  startNotification(id: string, serviceUuid: string, charUuid: string): Promise<void>;
  onNotification(cb: (ev: { id: string; value: Uint8Array }) => void): () => void;
  onDisconnect(cb: (id: string) => void): () => void;
  /**
   * Adapter-state events, when the native library exposes them
   * (react-native-ble-manager 12.6.0: onDidUpdateState, states 'on' /
   * 'off' / 'unsupported' / 'unauthorized'). Absent on older shapes; the
   * transport then falls back to AppState-active re-validation.
   */
  onState?(cb: (state: string) => void): () => void;
  /** Current adapter state via checkState, or null when unavailable. */
  checkState?(): Promise<string | null>;
}

/** Peripheral-role native surface (react-native-multi-ble-peripheral shaped). */
export interface PeripheralAdapter {
  startAdvertising(tag: Uint8Array, identHex: string): Promise<void>;
  stopAdvertising(): Promise<void>;
  onWrite(cb: (ev: { device: string; value: Uint8Array }) => void): () => void;
  notify(chunk: Uint8Array): Promise<void>;
  destroy(): Promise<void>;
  /**
   * Persistent error listener, attached after ready resolves. The
   * creation-time once('error') is consumed at startup, so without this
   * a later GATT server failure is invisible and advertisingState stays
   * started. Absent on fakes and older shapes.
   */
  onError?(cb: (err: unknown) => void): () => void;
}

/** Injected native dependencies. Null = that role is unavailable (fail closed). */
export interface BleNativeDeps {
  central: CentralAdapter | null;
  createPeripheral: (() => Promise<PeripheralAdapter>) | null;
  requestPermissions: () => Promise<boolean>;
  /**
   * Non-prompting permission check (checkBlePermissions). Absent in older
   * callers and tests: ensureCentral then skips the check rather than
   * prompting from a scan. Distinct from requestPermissions, which fires
   * the OS dialog and must only run from a user action.
   */
  checkPermissions?: () => Promise<boolean>;
  /**
   * Mid-session scan-failure callback for the transport: the port records
   * the failure, the transport reclassifies the radio state by re-checking
   * permissions at that moment. Absent in tests and older callers.
   */
  onScanFailure?: (code: string) => void;
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
/**
 * Per-operation native deadlines (ms). No BLE operation has a native
 * guarantee to settle: a radio that is off or wedged can leave a promise
 * pending forever, which used to hang advertise, connect, send, and
 * transport startup with no fallback. Every native await in this file
 * goes through withBleTimeout; on timeout the caller cleans up (disconnect,
 * drop the registered conn) and throws, so the transport falls back to
 * Nostr-only. No new dependency.
 */
/** Single auto-connect retry delay (ms). One retry only, never a loop. */
export const AUTO_CONNECT_RETRY_MS = 2000;

/** Discovered peers older than this are stale (pruned on discover and before connect). */
export const DISCOVERED_STALE_MS = 60_000;
/** Discovered peer map cap: past this, the stalest entry is evicted. */
export const DISCOVERED_MAX = 100;

export const BLE_TIMEOUT_MS = {
  ready: 10_000,
  start: 10_000,
  scan: 10_000,
  connect: 10_000,
  retrieveServices: 10_000,
  requestMtu: 10_000,
  read: 10_000,
  write: 5_000,
  startNotification: 10_000,
  advertise: 15_000,
  notify: 5_000,
} as const;

/**
 * Race a native promise against a deadline. Rejects with a stage-tagged
 * error on timeout. A late native rejection after the race settles is
 * swallowed by the attached no-op handler so it is never unhandled.
 */
export function withBleTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`ble: ${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  void promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

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
  private readonly discovered = new Map<string, { bleId: string; tag: Uint8Array; rssi: number; lastSeenMs: number }>();
  private readonly receivers = new Set<(peerId: string, bytes: Uint8Array) => void>();
  private readonly scanSubs = new Set<(peer: PeerInfo) => void>();
  private scanUnsub: (() => void) | null = null;
  private centralStarted = false;
  /** In-flight advertise promise: a second concurrent advertise returns this instead of starting a second advertiser. */
  private advertisePromise: Promise<void> | null = null;
  /** bleIds with a handshake in flight: reserved before the first await, freed in finally. */
  private readonly pendingConnects = new Set<string>();
  /** One scheduled auto-connect retry per bleId (single retry, about 2s). */
  private readonly autoConnectRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private peripheral: PeripheralAdapter | null = null;
  private readonly peripheralUnsubs: (() => void)[] = [];
  private centralUnsubs: (() => void)[] = [];
  private readonly adapterStateSubs = new Set<(state: 'on' | 'off') => void>();
  private adapterStateUnsub: (() => void) | null = null;

  constructor(private readonly deps: BleNativeDeps) {}

  // ---------------------------------------------------------------- advertise

  /**
   * Start advertising our peerId. Idempotent for the same peerId.
   * Throws a descriptive Error when the radio is unavailable (permissions
   * denied, peripheral lib missing/broken) - the caller runs Nostr-only.
   */
  async advertise(peerId: string): Promise<void> {
    // In-flight guard: two concurrent calls used to both pass the
    // idempotent check, both create adapters, and the second assignment
    // leaked the first advertiser (still advertising, never destroyed).
    if (this.advertisePromise) return this.advertisePromise;
    const p = this.advertiseInner(peerId);
    this.advertisePromise = p;
    try {
      await p;
    } finally {
      if (this.advertisePromise === p) this.advertisePromise = null;
    }
  }

  private async advertiseInner(peerId: string): Promise<void> {
    if (!HEX64_RE.test(peerId)) throw new Error('ble: advertise needs a 64-char hex peerId');
    if (this.peripheral && this.ownPeerId === peerId) return;
    await this.stopAdvertise();
    // stopAdvertise keeps the handle when the native stop fails so a later
    // stop can retry it; a new advertise must not overwrite that handle
    // and orphan the old advertiser. Fail instead and let Retry retry.
    if (this.peripheral) throw new Error('ble: previous advertiser could not be stopped');
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
      adapter = await withBleTimeout(factory(), BLE_TIMEOUT_MS.ready, 'peripheral ready');
      await withBleTimeout(adapter.startAdvertising(tag, peerId), BLE_TIMEOUT_MS.advertise, 'advertise');
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
    // Persistent error listener: a later GATT server failure records a
    // stage-tagged advertise failure and clears the peripheral handle, so
    // the next Retry recreates the adapter instead of hitting the
    // idempotent early return for a held-but-dead peripheral.
    if (adapter.onError) {
      const offError = adapter.onError(() => {
        if (this.peripheral === adapter) {
          this.peripheral = null;
          this.ownPeerId = null;
          this.ownTag = null;
        }
        recordAdvertiseFailure('ble: advertise failed: peripheral error after ready');
      });
      this.peripheralUnsubs.push(offError);
    }
  }

  async stopAdvertise(): Promise<void> {
    const p = this.peripheral;
    if (p) {
      // Await stop and destroy FIRST: previously the handle was cleared
      // before the awaits and both failures were swallowed, so a failed
      // stop left an orphan advertiser running while JS state said
      // stopped. Failures are recorded without throwing (the never-throws
      // contract for callers is kept) and the handle is kept, so a later
      // stopAdvertise can retry the stop instead of orphaning it.
      let failed = false;
      try {
        await p.stopAdvertising();
      } catch (err) {
        failed = true;
        recordAdvertiseFailure(`ble: stopAdvertising failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await p.destroy();
      } catch (err) {
        failed = true;
        recordAdvertiseFailure(`ble: peripheral destroy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (failed) return;
    }
    for (const u of this.peripheralUnsubs.splice(0)) {
      try {
        u();
      } catch {
        // ignore
      }
    }
    this.peripheral = null;
    this.ownPeerId = null;
    this.ownTag = null;
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
   *
   * Order requirement: advertise() must run before scan(). The self
   * filter in onDiscover needs ownTag, which is only set by advertise;
   * scanning first surfaces our own advertisement as a nearby peer
   * (latent in the app flow, which always advertises first). No
   * behaviour change is made here: this comment plus the
   * scan-before-advertise test pin the requirement.
   */
  async scan(onPeer: (peer: PeerInfo) => void): Promise<() => void> {
    // The subscriber joins only after ensureCentral succeeds: previously it
    // was added first, so a failed bring-up leaked it in scanSubs forever
    // and the caller never received the unsubscribe function.
    if (!this.scanUnsub) {
      await this.ensureCentral();
    }
    this.scanSubs.add(onPeer);
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

  /**
   * Subscribe to adapter-state changes ('on' / 'off'). The port forwards
   * native state events; the transport decides what a transition means
   * (powered-off reclassifies the radio, powered-on re-runs bring-up).
   */
  onAdapterState(cb: (state: 'on' | 'off') => void): () => void {
    this.adapterStateSubs.add(cb);
    return () => {
      this.adapterStateSubs.delete(cb);
    };
  }

  /** Current adapter state when the central library exposes checkState, else null. Never throws. */
  async checkAdapterState(): Promise<string | null> {
    try {
      return (await this.deps.central?.checkState?.()) ?? null;
    } catch {
      return null;
    }
  }

  private async ensureCentral(): Promise<void> {
    const central = this.deps.central;
    if (!central) return; // scan stays inert; unsub still works
    // Start, listener registration, and scan live in one try: previously
    // the start flag and listeners were set before the fallible step, so
    // a start failure was never recorded and the next scan registered a
    // second set of listeners (discovery and notify callbacks fired twice).
    // On any failure the just-registered listeners are removed, the flag
    // is reset, and the failure is recorded, so a retry starts clean.
    const registeredInThisCall: (() => void)[] = [];
    try {
      // Scan never checked permissions before: a scan attempted with
      // revoked grants surfaced only as a native failure, never as a
      // permission-blocked radio. Check first and record a
      // permission-tagged scan failure on denial.
      if (this.deps.checkPermissions) {
        const granted = await this.deps.checkPermissions().catch(() => false);
        if (!granted) throw new Error('ble: bluetooth permissions not granted');
      }
      if (!this.centralStarted) {
        await withBleTimeout(central.start(), BLE_TIMEOUT_MS.start, 'central start');
        registeredInThisCall.push(
          central.onDiscover((info) => this.onDiscover(info)),
          central.onNotification(({ id, value }) => this.onCentralNotify(id, value)),
          central.onDisconnect((id) => this.onCentralDisconnect(id)),
        );
        this.centralUnsubs.push(...registeredInThisCall);
        this.centralStarted = true;
        if (central.onState && !this.adapterStateUnsub) {
          this.adapterStateUnsub = central.onState((state) => {
            const normalized = state === 'on' ? 'on' : state === 'off' ? 'off' : null;
            if (!normalized) return;
            for (const cb of this.adapterStateSubs) {
              try {
                cb(normalized);
              } catch {
                // subscriber errors must not break state handling
              }
            }
          });
        }
      }
      await withBleTimeout(central.scan(), BLE_TIMEOUT_MS.scan, 'central scan');
    } catch (err) {
      // Remove every central listener (just-registered plus any held from
      // an earlier bring-up) so a retry can never double-register.
      for (const u of [...new Set([...registeredInThisCall, ...this.centralUnsubs])]) uSafe(u);
      this.centralUnsubs = [];
      this.centralStarted = false;
      uSafe(this.adapterStateUnsub);
      this.adapterStateUnsub = null;
      const code = err instanceof Error ? err.message : String(err);
      recordScanFailure(code);
      this.deps.onScanFailure?.(code);
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
      uSafe(this.adapterStateUnsub);
      this.adapterStateUnsub = null;
    };
  }

  private onDiscover(info: { id: string; rssi: number; tag: Uint8Array | null }): void {
    const { id, rssi, tag } = info;
    if (!id || !tag || tag.length !== 8) return; // not a mesh peer
    if (this.ownTag && toHex(tag) === toHex(this.ownTag)) return; // self
    const key = provisionalTagKey(tag);
    const known = this.discovered.get(key);
    this.pruneDiscovered();
    this.discovered.set(key, { bleId: id, tag, rssi, lastSeenMs: Date.now() });
    while (this.discovered.size > DISCOVERED_MAX) {
      // Evict the stalest entry (never the one just seen).
      let stalest: string | null = null;
      let stalestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.discovered) {
        if (k !== key && v.lastSeenMs < stalestAt) {
          stalestAt = v.lastSeenMs;
          stalest = k;
        }
      }
      if (stalest === null) break;
      this.discovered.delete(stalest);
    }
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
    if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) return;
    if (this.bleIndex.has(id) || this.pendingConnects.has(id)) return; // already connecting/connected
    // Tie-break: smaller (or equal) tag initiates the central connection.
    if (this.ownTag && compareTags(this.ownTag, tag) <= 0) {
      void this.connectCentral(id, tag).catch((err) => {
        // Auto-connect failures used to be swallowed with an empty catch
        // and, with allowDuplicates false, the peer was never retried for
        // the session. Record a stage-tagged failure and schedule exactly
        // one bounded retry; the retry itself stays silent on failure.
        recordConnectFailure(`auto-connect ${id}: ${err instanceof Error ? err.message : String(err)}`);
        this.scheduleAutoConnectRetry(id, tag);
      });
    }
  }

  /**
   * Schedule the single bounded auto-connect retry for a bleId (about 2s
   * out). No retry is scheduled when one is already pending or the peer
   * limit is hit; the timer is cancelled on disconnect (see dropConn) and
   * on close, and the retry never schedules a further retry.
   */
  private scheduleAutoConnectRetry(bleId: string, tag: Uint8Array): void {
    if (this.autoConnectRetries.has(bleId)) return;
    if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) return;
    const timer = setTimeout(() => {
      this.autoConnectRetries.delete(bleId);
      if (this.bleIndex.has(bleId) || this.pendingConnects.has(bleId)) return;
      if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) return;
      void this.connectCentral(bleId, tag).catch(() => {
        // Single retry spent; a further failure stays silent.
      });
    }, AUTO_CONNECT_RETRY_MS);
    this.autoConnectRetries.set(bleId, timer);
  }

  private cancelAutoConnectRetry(bleId: string): void {
    const timer = this.autoConnectRetries.get(bleId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.autoConnectRetries.delete(bleId);
    }
  }

  // ------------------------------------------------------------------ connect

  /** Drop discovered entries not seen within the stale window. */
  private pruneDiscovered(nowMs: number = Date.now()): void {
    for (const [key, entry] of this.discovered) {
      if (nowMs - entry.lastSeenMs > DISCOVERED_STALE_MS) this.discovered.delete(key);
    }
  }

  /** Connect to a discovered peer (provisional `tag:<hex>` id or full peerId). */
  async connect(peerId: string): Promise<void> {
    if (this.conns.has(peerId)) return;
    for (const conn of this.conns.values()) {
      if (conn.peerId === peerId) return;
    }
    this.pruneDiscovered();
    const disc = this.discovered.get(peerId);
    if (!disc) throw new Error(`ble: unknown peer ${peerId}`);
    if (!this.deps.central) throw new Error('ble: central role unavailable');
    await this.connectCentral(disc.bleId, disc.tag);
  }

  private async connectCentral(bleId: string, tag: Uint8Array): Promise<void> {
    const central = this.deps.central;
    if (!central) throw new Error('ble: central role unavailable');
    if (this.bleIndex.has(bleId)) return;
    if (this.pendingConnects.has(bleId)) return;
    if (!this.ownPeerId) throw new Error('ble: advertise() must run before connect');
    // The peer-limit check counts reservations, not just registered conns:
    // two handshakes that both passed a conns-only check could together
    // exceed the limit. The reservation is made before the first await.
    if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) throw new Error('ble: peer limit reached');
    this.pendingConnects.add(bleId);
    try {
      await this.connectCentralInner(central, bleId, tag);
    } finally {
      this.pendingConnects.delete(bleId);
    }
  }

  private async connectCentralInner(central: NonNullable<BleNativeDeps['central']>, bleId: string, tag: Uint8Array): Promise<void> {
    // Re-checked here because the outer guard narrowed it before the await
    // boundary; the inner method must not trust that narrowing.
    const ownPeerId = this.ownPeerId;
    if (!ownPeerId) throw new Error('ble: advertise() must run before connect');
    await withBleTimeout(central.connect(bleId), BLE_TIMEOUT_MS.connect, 'central connect');
    // Set only once a connection is registered in this call, so the catch
    // below drops exactly the stale registration this call created.
    let registeredKey: string | null = null;
    try {
      await withBleTimeout(central.retrieveServices(bleId), BLE_TIMEOUT_MS.retrieveServices, 'retrieveServices');
      let mtu = ATT_DEFAULT_MTU;
      try {
        const negotiated = await withBleTimeout(central.requestMtu(bleId, ATT_REQUEST_MTU), BLE_TIMEOUT_MS.requestMtu, 'requestMtu');
        if (Number.isInteger(negotiated) && negotiated >= ATT_DEFAULT_MTU) mtu = negotiated;
      } catch {
        // keep default 23
      }
      const identRaw = await withBleTimeout(central.read(bleId, MESH_SERVICE_UUID, MESH_IDENT_CHAR_UUID), BLE_TIMEOUT_MS.read, 'ident read');
      const peerId = new TextDecoder().decode(identRaw);
      if (!HEX64_RE.test(peerId)) throw new Error('ble: peer IDENT malformed');
      // Bind the claimed identity to the discovery hint: the IDENT pubkey
      // must carry the advertised tag, or this is a different peer (or a
      // spoofed IDENT) and the connect must fail, not register.
      if (toHex(peerTagOf(fromHex(peerId))) !== toHex(tag)) {
        throw new Error('ble: peer IDENT does not match advertised tag');
      }
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
      registeredKey = peerId;
      // Announce ourselves: the peripheral side learns our identity + MTU.
      const hello = encodeHello(fromHex(ownPeerId), mtu);
      for (const chunk of chunkBytes(hello, mtu - ATT_OVERHEAD)) {
        await withBleTimeout(central.write(bleId, MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, chunk), BLE_TIMEOUT_MS.write, 'hello write');
      }
      await withBleTimeout(central.startNotification(bleId, MESH_SERVICE_UUID, MESH_TX_CHAR_UUID), BLE_TIMEOUT_MS.startNotification, 'startNotification');
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
      // Previously the native disconnect ran but the registration stayed:
      // a dead peer kept counting as connected and publish fan-out kept
      // targeting it, with no disconnected event. Drop it when this call
      // registered it; the native disconnect above is kept.
      if (registeredKey !== null) this.dropConn(registeredKey);
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
        // RX declares WRITE_NO_RESPONSE: frame chunks go without-response
        // (no per-chunk round trip), falling back to with-response writes
        // when the native shape lacks the method.
        if (central.writeWithoutResponse) {
          await withBleTimeout(
            central.writeWithoutResponse(conn.bleId, MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, chunk),
            BLE_TIMEOUT_MS.write,
            'frame write',
          );
        } else {
          await withBleTimeout(central.write(conn.bleId, MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, chunk), BLE_TIMEOUT_MS.write, 'frame write');
        }
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
      await withBleTimeout(peripheral.notify(chunk), BLE_TIMEOUT_MS.notify, 'notify');
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
    // Per-datagram expiry: a stalled partial buffer is dropped here
    // before the new chunk is appended, so a corrupt length prefix
    // cannot wedge the stream for this connection.
    if (conn.inbound.expireIfStale(Date.now())) conn.partialOpen = false;
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
    this.cancelAutoConnectRetry(conn.bleId);
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
    // Clear receive subscribers too: previously a reused port object kept
    // firing stale receive callbacks into a dead transport after close.
    this.receivers.clear();
    // Record scan stopped only when scanning was actually active:
    // previously close logged a scan stop even for a port that never
    // scanned, polluting the scan lifecycle trail.
    if (unsub !== null || this.centralStarted) recordScanStopped();
    uSafe(unsub);
    await this.deps.central?.stopScan().catch(() => {});
    for (const u of this.centralUnsubs.splice(0)) uSafe(u);
    this.centralStarted = false;
    uSafe(this.adapterStateUnsub);
    this.adapterStateUnsub = null;
    for (const key of [...this.conns.keys()]) {
      const conn = this.conns.get(key);
      this.dropConn(key);
      if (conn?.role === 'central') {
        await this.deps.central?.disconnect(conn.bleId).catch(() => {});
      }
    }
    for (const timer of this.autoConnectRetries.values()) clearTimeout(timer);
    this.autoConnectRetries.clear();
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
      // Scan audit (ble-manager 12.6.0): scan takes ONE options object,
      // scan(scanningOptions). The Android native method is
      // scan(ReadableMap scanningOptions, Callback), so passing the
      // old positional form mgr.scan([], 0, false, { scanMode: 2 })
      // put an array where the bridge expects a Map and every scan
      // failed on device with "expected Map, got a array", which then
      // tore down advertise and the adapter. Correct form, with the
      // same intent as before: serviceUUIDs [] (UNFILTERED,
      // deliberately: the advertise packet carries manufacturer data
      // only, no service UUID, so a UUID filter would never match a
      // mesh peer; the JS layer filters by manufacturer data in
      // extractTag/onDiscover), seconds 0 (indefinite until
      // stopScan), allowDuplicates false (iOS only), scanMode 2
      // (Android SCAN_MODE_LOW_LATENCY). Battery trade-off, taken
      // deliberately: fast discovery is the mesh's core promise.
      scan: () => mgr.scan({ serviceUUIDs: [], seconds: 0, allowDuplicates: false, scanMode: 2 }),
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
      // ble-manager 12.6.0 writeWithoutResponse(id, service, char, data,
      // maxByteSize, queueSleepTime): pass the chunk length as
      // maxByteSize so the native layer does not re-chunk the frame chunk.
      writeWithoutResponse: (id, serviceUuid, charUuid, chunk) =>
        mgr.writeWithoutResponse(id, serviceUuid, charUuid, Array.from(chunk), chunk.length, 10),
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
      // Adapter state (ble-manager 12.6.0): the class API exposes
      // onDidUpdateState with { state: BleState } ('on' / 'off' /
      // 'unsupported' / ...). Prefer it; fall back to the legacy
      // 'BleManagerDidUpdateState' emitter event for older shapes.
      onState: (cb) => {
        const mgrAny = mgr as unknown as {
          onDidUpdateState?: (cb: (ev: { state?: unknown }) => void) => { remove: () => void };
          checkState?: () => Promise<unknown>;
        };
        if (typeof mgrAny.onDidUpdateState === 'function') {
          const sub = mgrAny.onDidUpdateState((ev) => cb(String(ev?.state ?? '')));
          return () => {
            try {
              sub.remove();
            } catch {
              // ignore
            }
          };
        }
        const sub = emitter.addListener('BleManagerDidUpdateState', (e: unknown) => {
          cb(String((e as { state?: unknown })?.state ?? ''));
        });
        return () => sub.remove();
      },
      checkState: async () => {
        const mgrAny = mgr as unknown as { checkState?: () => Promise<unknown> };
        if (typeof mgrAny.checkState !== 'function') return null;
        try {
          const state = await mgrAny.checkState();
          return typeof state === 'string' ? state : null;
        } catch {
          return null;
        }
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

/**
 * react-native-multi-ble-peripheral 0.1.8 startAdvertising contract, pinned
 * from the installed package source (lib/typescript/index.d.ts and
 * lib/commonjs/index.js), replacing the old unknown/unknown typing that
 * let a wrong shape through TypeScript unchecked. The JS layer takes
 * (servicesOrOpts, options): when options is undefined it forwards the
 * first argument as the options and null as the services, and the Android
 * native module only adds service UUIDs when the services map is non-null.
 * The app always calls it with (options object, undefined), so no service
 * UUID is added to the packet: the packet is manufacturer data only plus
 * the Android Flags field (see the 15-byte figure in advertiseInner).
 * Kept as a type pin, not a library replacement: the keep-vs-replace
 * decision still needs a measured on-air packet plus a device run.
 */
export interface PeripheralAdvertiseOptions {
  mode?: number;
  txPowerLevel?: number;
  connectable?: boolean;
  includeDeviceName?: boolean;
  includeTxPowerLevel?: boolean;
  manufacturerId?: number;
  manufacturerData?: Buffer;
}
export type PeripheralAdvertiseServices = Record<string, Buffer>;

function loadPeripheralFactory(): (() => Promise<PeripheralAdapter>) | null {
  let PeripheralClass: new () => {
    once(ev: string, cb: (arg?: unknown) => void): void;
    addService(uuid: string, primary: boolean): Promise<unknown>;
    addCharacteristic(svc: string, uuid: string, props: number, perms: number): Promise<unknown>;
    updateValue(svc: string, uuid: string, value: unknown): Promise<unknown>;
    startAdvertising(
      servicesOrOpts?: PeripheralAdvertiseServices | PeripheralAdvertiseOptions,
      options?: PeripheralAdvertiseOptions,
    ): Promise<unknown>;
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
    await withBleTimeout(
      new Promise<void>((resolve, reject) => {
        inst.once('ready', () => resolve());
        inst.once('error', (err: unknown) =>
          reject(new Error(describeAdvertiseError(err).replace('ble: advertise failed: ', 'ble: peripheral ready failed: '))),
        );
      }),
      BLE_TIMEOUT_MS.ready,
      'peripheral ready',
    );
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
            await withBleTimeout(run(), BLE_TIMEOUT_MS.advertise, `advertise ${stage}`);
          } catch (err) {
            throw new Error(`ble: advertise failed at ${stage}: ${describeAdvertiseError(err).replace('ble: advertise failed: ', '')}`);
          }
        }
        // Advertise manufacturer data only: the 128-bit service UUID is
        // not passed (services are null on this call path, see the type
        // pin above), so the library adds no service UUID or service
        // data. The manufacturer AD field itself is 12 bytes; the full
        // legacy packet is 15 bytes minimum once Android Flags are added
        // (see advertiseInner).
      },
      stopAdvertising: async () => {
        await inst.stopAdvertising();
      },
      onError: (cb) => {
        // eventemitter3: the instance emits 'error' beyond the once
        // creation gate (whose reject is a no-op once ready resolved).
        const handler = (err: unknown) => cb(err);
        (inst as unknown as { on(ev: string, cb: (arg: unknown) => void): void }).on('error', handler);
        return () => {
          (inst as unknown as { removeListener(ev: string, cb: unknown): void }).removeListener('error', handler);
        };
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
export function defaultBleDeps(
  requestPermissions: () => Promise<boolean>,
  checkPermissions?: () => Promise<boolean>,
): BleNativeDeps {
  return {
    central: loadCentralAdapter(),
    createPeripheral: loadPeripheralFactory(),
    requestPermissions,
    checkPermissions,
  };
}
