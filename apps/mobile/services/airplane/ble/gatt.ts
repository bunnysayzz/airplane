// SPDX-License-Identifier: Apache-2.0
// Real BLE GATT TransportPort for Android (the offline mesh itself).
//
// Roles: every phone is BOTH central and peripheral.
//   - Central (react-native-ble-manager 12.6.0): scan, connect, GATT client.
//     Reads the peer IDENT, writes a hello datagram, and subscribes to
//     the peer TX characteristic, so peer notifies arrive as central
//     notifications through the codegen emitter (works on new-arch
//     builds).
//   - Peripheral (react-native-multi-ble-peripheral 0.1.8): advertise +
//     GATT server. Sends frames via TX notifications (broadcast to all
//     subscribed centrals - see limitation below).
//
// Connection rule: on discovering a peer tag, BOTH sides initiate the
// central connection, giving crossed central links. The old tie-break
// (only the smaller tag connects) stranded the larger-tag side: it
// never attempted a connection, and the peripheral side could not
// register the inbound link anyway, because the peripheral library
// reports inbound writes through the legacy bridge event emitter,
// which does not deliver on new-arch builds (same failure class as
// the old ble-manager legacy discovery subscription). A central write
// to the peer RX therefore "succeeds" at the radio while the peer app
// layer never sees it, so send() notifies on our own TX instead and
// the peer central receives it; the mesh dedupes by event ID on
// non-target peers.
//
// Identity: advertise tag = first 8 bytes of the Ed25519 pubkey (discovery
// hint). Full peerId (64-char hex pubkey) is resolved after connect - the
// central reads our IDENT characteristic. The hello datagram is still
// written (kept for runtimes where peripheral write events do arrive),
// but on current builds the peripheral side never learns the central
// identity from it, so no send path may depend on inbound writes.
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
// FIELD-PROVEN 2026-11-03 (two-phone run, v0.1.15): discovery, central
// connect, IDENT read, and TX subscription all work over the air, but
// the peripheral side never sees an inbound write: the larger-tag phone
// logged hundreds of sightings and zero peer-connected lines while the
// smaller-tag phone sent frames "over BLE" that never arrived. That run
// is why send() uses TX notify and why both sides connect.
//
// Known limitations (honest):
// - TX notify() broadcasts to ALL subscribed centrals; send() to one
//   peer also reaches the others. The mesh dedupes by event ID
//   (SeenCache), so this wastes bandwidth, not correctness.
// - A notify resolves successfully even with no subscriber yet, so a
//   post published in the first seconds after discovery, before the
//   peer central subscribes to our TX, can be lost on BLE without an
//   error. The phone check for this design waits for a peer-connected
//   line on both phones before posting.
// - Peripheral-role inbound writes never arrive on new-arch builds
//   (legacy bridge emitter, see above), so peripheral-role conns only
//   exist in tests or on runtimes where that emitter works.
// - BLE transport: no retry backoff at all for connect or send (no
//   timeout or backoff timer exists in this layer as of this writing).
//   Retry behaviour for the other transports, stated so no reader has to
//   guess: Nostr reconnect doubles from 5 s to a 60 s cap with jitter
//   (see packages/transport/src/nostr.ts); DM outbox retries on
//   [0, 1, 5, 30, 120] s capped at 5 attempts (see
//   packages/transport/src/dm.ts); WorldSync ticks on a fixed 60 s timer
//   with no backoff (see services/airplane/transport.ts).
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
  recordBleDrop,
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
  recordScanSightings,
  recordScanStarted,
  recordScanStopped,
  recordServiceEvent,
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
  /**
   * Clear the native GATT service cache for a peer (ble-manager 12.6.0
   * refreshCache, Android BluetoothGatt.refresh). Absent on older
   * shapes; the IDENT retry treats it as unavailable and proceeds
   * with re-discovery alone.
   */
  refreshCache?(id: string): Promise<boolean>;
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
/**
 * Sightings-driven connect cooldown after a transient connect failure:
 * first failure cools the peer for 10 seconds, doubling per further
 * failure up to 60 seconds. A sighting during cooldown starts no
 * connect and logs nothing: the v0.1.23 storm was sightings at
 * sub-second cadence each starting a connect against a peer whose
 * GATT server was transiently gone, 35 ident retry lines in about a
 * minute, every one an IDENT not-found. The v0.1.24 gate armed only
 * on IDENT failures, and the same storm shape returned on 2026-11-05
 * for the connect-timeout class (19 timeouts, one every 10 s for
 * over 3 minutes, peer sighted 1338 times in 4 minutes), so the gate
 * now arms on every transient-unavailability class (see
 * TRANSIENT_CONNECT_FAILURES). Deterministic failures (tag mismatch,
 * malformed IDENT, peer limit, connect refused) keep immediate
 * sighting retries, preserving the established bleId-reuse contract
 * that a fixed peer reconnects on its next sighting. The single
 * scheduled 2 second retry stays exempt as the one prompt retry;
 * after it is spent, sightings stay quiet until the cooldown expires
 * or a fresh episode starts.
 */
export const AUTO_CONNECT_COOLDOWN_BASE_MS = 10_000;
export const AUTO_CONNECT_COOLDOWN_MAX_MS = 60_000;
/**
 * Connect-stage failure messages that mean the peer's GATT endpoint
 * is transiently unavailable, so the sighting cooldown arms on them
 * (see noteConnectFailure). Field evidence 2026-11-05, v0.1.24
 * two-phone session: 19 consecutive "central connect timed out
 * after 10000ms" failures, one every 10 s for over 3 minutes, while
 * the peer was sighted 1338 times in 4 minutes, then "connectGatt
 * returned null" twice as the wedged native connects poisoned the
 * stack. Any stage timeout matches, not only the connect stage: a
 * retrieveServices, IDENT read, hello-write, or notification
 * timeout means the same unusable link. Deterministic failures stay
 * outside the gate (see the cooldown comment above).
 */
const TRANSIENT_CONNECT_FAILURES: RegExp[] = [
  /ident retry failed/i,
  /timed out after \d+ms/i,
  /device disconnected/i,
  /disconnected by BleManager/i,
  /connectGatt returned null/i,
];
/** Settle delay before the IDENT re-read after fresh discovery. */
export const IDENT_RETRY_SETTLE_MS = 300;
/**
 * Settle after a peripheral hello before a peer counts as ready
 * without a completed central handshake: the peer writes hello and
 * then subscribes to our TX, and the subscribe follows within
 * milliseconds, but a send in that gap notifies with no subscriber
 * and is lost while counting as sent (v0.1.30 B drain at 03:28:05).
 * The 2 s mesh poll normally absorbs this; the settle covers a live
 * publish that lands in the same instant as the hello.
 */
export const READY_SETTLE_MS = 300;

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

/** Last log time per drop class, so a flood of drops logs at most one line per minute per class. */
const lastDropLogAtMs = new Map<string, number>();
const DROP_LOG_WINDOW_MS = 60_000;

/** Log one throttled diagnostics line per drop class per minute. */
function logBleDropThrottled(kind: string, detail: string): void {
  const nowMs = Date.now();
  const last = lastDropLogAtMs.get(kind) ?? 0;
  if (nowMs - last < DROP_LOG_WINDOW_MS) return;
  lastDropLogAtMs.set(kind, nowMs);
  recordBleDrop(kind, detail);
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
  /**
   * Tags (8 hex) with a central handshake in flight. The per-bleId set
   * above cannot dedup a peer seen under a second BLE address (RPA
   * rotation): two central connects then race for one peer, and the
   * second discovery can return an incomplete service table, which is
   * the intermittent IDENT not-found in the field (v0.1.31: two
   * attempts 9 s apart for one tag, one succeeding, one failing).
   * A registered central conn for the tag counts the same way.
   */
  private readonly pendingCentralTags = new Set<string>();
  /** One scheduled auto-connect retry per bleId (single retry, about 2s). */
  private readonly autoConnectRetries = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sighting-connect cooldown per bleId (epoch ms until quiet ends). */
  private readonly connectCooldownUntil = new Map<string, number>();
  /** Consecutive auto-connect failures per bleId (drives the backoff). */
  private readonly connectCooldownFailures = new Map<string, number>();
  /**
   * Send readiness per peerId (full hex). `central` means our central
   * handshake to the peer completed (we subscribed to its TX);
   * `peripheral` means the peer's hello arrived on our peripheral
   * side (it connected to us and subscribes to our TX next).
   * A peer is ready to receive only when its hello arrived AND
   * (our central completed OR the settle elapsed): the hello proves
   * the peer is connecting to us, the settle covers the hello to
   * subscribe gap. Kept apart from the conns map because the
   * peripheral conn entry is dropped when a central conn for the same
   * peer registers, while the peer stays subscribed to our TX.
   */
  private readonly peerReady = new Map<
    string,
    { central: boolean; peripheral: boolean; peripheralHelloAtMs: number }
  >();
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
    // Advertisement length on the air: the manufacturer AD field is
    // AD header (2 bytes) + company id (2 bytes) + 8-byte tag = 12
    // bytes, but a legacy packet also carries the 3-byte Android Flags
    // AD field, so the true minimum packet is 15 bytes, still inside the
    // 31-byte legacy budget. Previously diagnostics reported 12, which
    // understated the packet.
    recordAdvertiseSuccess(2 + 2 + tag.length + 3);
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
    // Our TX is gone with the advertiser: nobody can be subscribed to
    // it anymore, so every peer's peripheral-side readiness is void
    // until it re-hellos after the next advertise. Central readiness
    // survives: we can still receive from peers we subscribed to.
    for (const entry of this.peerReady.values()) entry.peripheral = false;
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
      // Adapter pre-check (mesh-scan fix): the native scan call never
      // calls back when the adapter is not enabled at scan time, so a
      // scan issued then hangs until the 10s timeout and tears the
      // radio down. Check first and fail fast with a clear stage
      // instead of hanging. A null or unknown state means the check
      // is unavailable, so proceed to the scan as before.
      if (central.checkState) {
        const adapterState = await central.checkState().catch(() => null);
        if (typeof adapterState === 'string' && adapterState !== 'on') {
          throw new Error('ble: adapter not on, scan skipped');
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
      const evicted = this.discovered.get(stalest);
      this.discovered.delete(stalest);
      if (evicted) this.clearConnectCooldown(evicted.bleId);
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
    // Cooldown gate: a peer that just failed stays quiet on further
    // sightings until the backoff expires. No line here: the failure
    // that started the cooldown already logged one, and a line per
    // gated sighting would be the storm all over again.
    const cooledUntil = this.connectCooldownUntil.get(id);
    if (cooledUntil !== undefined && Date.now() < cooledUntil) return;
    // Both sides initiate: the old smaller-tag tie-break left the
    // larger-tag side with no connection and no way to get one, because
    // the inbound link it waited for never registers (peripheral write
    // events do not arrive on new-arch builds). Crossed central links
    // give each side a TX subscription on the other, which is what
    // send() notifies on. Still bounded by the peer limit above and by
    // the connecting/connected dedup above.
    void this.connectCentral(id, tag).catch((err) => {
      // Auto-connect failures used to be swallowed with an empty catch
      // and, with allowDuplicates false, the peer was never retried for
      // the session. Record a stage-tagged failure, start the
      // sighting cooldown, and schedule exactly one bounded retry.
      // The tag, never the BLE address, identifies the peer in the
      // line: a raw address in the log file is a privacy leak (P0-2),
      // and the tag is what every other peer line already uses.
      recordConnectFailure(
        `auto-connect tag:${toHex(tag)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.noteConnectFailure(id, err);
      this.scheduleAutoConnectRetry(id, tag);
    });
  }

  /**
   * Record one transient connect failure for a bleId and start (or
   * extend) its sighting cooldown: base delay doubling per consecutive
   * failure, capped. Only the transient-unavailability classes arm
   * the gate (see TRANSIENT_CONNECT_FAILURES); deterministic failures
   * do not. A successful connect or a disconnect clears the counters
   * (see registerConn and dropConn), so the backoff spans one
   * disconnect episode, not the whole session.
   */
  private noteConnectFailure(bleId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!TRANSIENT_CONNECT_FAILURES.some((re) => re.test(message))) return;
    const failures = (this.connectCooldownFailures.get(bleId) ?? 0) + 1;
    this.connectCooldownFailures.set(bleId, failures);
    const delay = Math.min(
      AUTO_CONNECT_COOLDOWN_BASE_MS * 2 ** (failures - 1),
      AUTO_CONNECT_COOLDOWN_MAX_MS,
    );
    this.connectCooldownUntil.set(bleId, Date.now() + delay);
  }

  /** Clear the sighting cooldown for a bleId (fresh episode). */
  private clearConnectCooldown(bleId: string): void {
    this.connectCooldownUntil.delete(bleId);
    this.connectCooldownFailures.delete(bleId);
  }

  /**
   * Schedule the single bounded auto-connect retry for a bleId (about 2s
   * out). No retry is scheduled when one is already pending or the peer
   * limit is hit; the timer is cancelled on disconnect (see dropConn) and
   * on close, and the retry never schedules a further retry. The retry
   * is exempt from the sighting cooldown (it is the one prompt retry),
   * but its own failure extends the cooldown, so later sightings stay
   * quiet after the retry is spent.
   */
  private scheduleAutoConnectRetry(bleId: string, tag: Uint8Array): void {
    if (this.autoConnectRetries.has(bleId)) return;
    if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) return;
    const timer = setTimeout(() => {
      this.autoConnectRetries.delete(bleId);
      if (this.bleIndex.has(bleId) || this.pendingConnects.has(bleId)) return;
      if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) return;
      void this.connectCentral(bleId, tag).catch((err) => {
        // Single retry spent. Its outcome is logged now: a spent retry
        // used to stay silent, so a peer that never connected left
        // only the first failure line and no trace of the retry.
        recordConnectFailure(
          `auto-connect retry failed tag:${toHex(tag)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.noteConnectFailure(bleId, err);
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
      if (nowMs - entry.lastSeenMs > DISCOVERED_STALE_MS) {
        this.discovered.delete(key);
        this.clearConnectCooldown(entry.bleId);
      }
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
    // Per-tag dedup (see pendingCentralTags): a second BLE address for
    // the same peer must not start a second central handshake while
    // one is in flight or a central conn already covers the tag. A
    // peripheral conn does not suppress it: the central link carries
    // our TX subscription, which the peripheral link cannot.
    const tagHex = toHex(tag);
    if (this.pendingCentralTags.has(tagHex)) return;
    for (const conn of this.conns.values()) {
      if (conn.role === 'central' && conn.tag && toHex(conn.tag) === tagHex) return;
    }
    // The peer-limit check counts reservations, not just registered conns:
    // two handshakes that both passed a conns-only check could together
    // exceed the limit. The reservation is made before the first await.
    if (this.conns.size + this.pendingConnects.size >= MAX_BLE_PEERS) throw new Error('ble: peer limit reached');
    this.pendingConnects.add(bleId);
    this.pendingCentralTags.add(tagHex);
    try {
      await this.connectCentralInner(central, bleId, tag);
    } finally {
      this.pendingConnects.delete(bleId);
      this.pendingCentralTags.delete(tagHex);
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
      // IDENT read: the peer identity for the central link. The read
      // is flaky on Android: right after service discovery, some stacks
      // report the characteristic as not found even though the service
      // is there, and the retry then fails identically because Android
      // caches the service table per device and a second
      // discoverServices returns the cached table. On a not-found error
      // only, clear the native GATT cache (refreshCache), re-run
      // discovery, wait a brief settle so the peer GATT table is
      // actually ready, and read once more. One line per retry episode
      // records the stage outcome with timings, so the next device run
      // can tell a stale cache apart from a genuinely missing
      // characteristic. When the second read also fails, the link is
      // NOT torn down: it is kept as a provisional tag-keyed conn and
      // the inbound hello resolves the identity (the hello carries the
      // full pubkey), so a flaky IDENT read no longer leaves the peer
      // unready. The old code threw "ident retry failed" here, which
      // the caller logged as a connect failure, armed the cooldown,
      // and disconnected the native link (v0.1.31: three such failures
      // in 4.5 minutes, BLE carrying nothing all window).
      const identStartMs = Date.now();
      let identRaw: Uint8Array | null = null;
      try {
        identRaw = await withBleTimeout(central.read(bleId, MESH_SERVICE_UUID, MESH_IDENT_CHAR_UUID), BLE_TIMEOUT_MS.read, 'ident read');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found/i.test(message)) throw error;
        const refresh = await this.refreshGattCache(central, bleId);
        await withBleTimeout(central.retrieveServices(bleId), BLE_TIMEOUT_MS.retrieveServices, 'retrieveServices');
        await new Promise((resolve) => setTimeout(resolve, IDENT_RETRY_SETTLE_MS));
        try {
          identRaw = await withBleTimeout(central.read(bleId, MESH_SERVICE_UUID, MESH_IDENT_CHAR_UUID), BLE_TIMEOUT_MS.read, 'ident read');
          recordServiceEvent(
            `ble ident retry tag ${toHex(tag).slice(0, 8)} refreshCache ${refresh} read2 ok ${Date.now() - identStartMs}ms`,
          );
        } catch {
          recordServiceEvent(
            `ble ident retry tag ${toHex(tag).slice(0, 8)} refreshCache ${refresh} read2 not-found ${Date.now() - identStartMs}ms link provisional`,
          );
          // Fall through with identRaw null: provisional path below.
        }
      }
      let peerId: string | null = null;
      if (identRaw !== null) {
        const decoded = new TextDecoder().decode(identRaw);
        if (!HEX64_RE.test(decoded)) throw new Error('ble: peer IDENT malformed');
        // Bind the claimed identity to the discovery hint: the IDENT pubkey
        // must carry the advertised tag, or this is a different peer (or a
        // spoofed IDENT) and the connect must fail, not register.
        if (toHex(peerTagOf(fromHex(decoded))) !== toHex(tag)) {
          throw new Error('ble: peer IDENT does not match advertised tag');
        }
        peerId = decoded;
      }
      // Register before the hello so any inbound traffic is attributed.
      // Keyed by the full peerId when IDENT resolved it; otherwise by
      // the provisional tag key, so send()/disconnect() resolve by
      // peerId once the hello rekeys it (see promoteProvisionalCentral).
      // A provisional peer counts in peerCount but not in
      // connectedPeerIds, and send() still refuses it until the hello
      // resolves the identity.
      if (peerId !== null) {
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
      } else {
        const provisionalKey = provisionalTagKey(tag);
        this.registerConn(provisionalKey, {
          role: 'central',
          bleId,
          tag,
          peerId: null,
          mtu,
          inbound: new DatagramReassembler(),
          partialOpen: false,
        });
        registeredKey = provisionalKey;
      }
      // Announce ourselves: the peripheral side learns our identity + MTU.
      const hello = encodeHello(fromHex(ownPeerId), mtu);
      for (const chunk of chunkBytes(hello, mtu - ATT_OVERHEAD)) {
        await withBleTimeout(central.write(bleId, MESH_SERVICE_UUID, MESH_RX_CHAR_UUID, chunk), BLE_TIMEOUT_MS.write, 'hello write');
      }
      await withBleTimeout(central.startNotification(bleId, MESH_SERVICE_UUID, MESH_TX_CHAR_UUID), BLE_TIMEOUT_MS.startNotification, 'startNotification');
      // Subscribed to the peer TX characteristic: CCCD is on for this link.
      // Identified peers only: a provisional peer is announced when its
      // hello rekeys it (see dispatchDatagram), not here.
      if (peerId !== null) {
        recordPeerConnected(peerId, mtu, true);
        this.markPeerCentralReady(peerId);
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
      }
    } catch (err) {
      // Never tear down another attempt's live link: two central
      // connects for one peer can share a bleId, and the failed
      // attempt's unconditional disconnect used to kill the good link
      // (v0.1.31: disconnects following IDENT failures by seconds).
      // Disconnect only when no registered conn uses this bleId, or
      // the registered conn is this attempt's own.
      const liveKey = this.bleIndex.get(bleId);
      if (liveKey === undefined || liveKey === registeredKey) {
        await central.disconnect(bleId).catch(() => {});
      }
      // Previously the native disconnect ran but the registration stayed:
      // a dead peer kept counting as connected and publish fan-out kept
      // targeting it, with no disconnected event. Drop it when this call
      // registered it; the native disconnect above is kept.
      if (registeredKey !== null) this.dropConn(registeredKey);
      throw err instanceof Error ? err : new Error(`ble: connect failed: ${String(err)}`);
    }
  }

  /**
   * Clear the native GATT service cache for a peer (Android stale-table
   * fix). Best-effort: 'unavailable' when the adapter has no
   * refreshCache, 'failed' when the call throws or reports false.
   */
  private async refreshGattCache(
    central: NonNullable<BleNativeDeps['central']>,
    bleId: string,
  ): Promise<'ok' | 'unavailable' | 'failed'> {
    if (typeof central.refreshCache !== 'function') return 'unavailable';
    try {
      const cleared = await withBleTimeout(central.refreshCache(bleId), BLE_TIMEOUT_MS.retrieveServices, 'refreshCache');
      return cleared ? 'ok' : 'failed';
    } catch {
      return 'failed';
    }
  }

  /**
   * Promote a provisional central conn to the full peerId when the
   * peer's hello identifies it. Called from the hello path before the
   * peripheral conn is rekeyed, so the clash check there drops the
   * peripheral duplicate instead of the central link that carries our
   * TX subscription. Marks the central handshake complete: the
   * subscription to the peer TX was made during connect.
   */
  private promoteProvisionalCentral(peerId: string): void {
    let tag: Uint8Array;
    try {
      tag = peerTagOf(fromHex(peerId));
    } catch {
      return;
    }
    const tagHex = toHex(tag);
    for (const conn of this.conns.values()) {
      if (conn.role === 'central' && conn.peerId === null && conn.tag && toHex(conn.tag) === tagHex) {
        this.rekeyConn(conn, peerId);
        this.markPeerCentralReady(peerId);
        return;
      }
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
    // A down advertiser is checked first: without it there is no TX
    // to notify on, so the error must name the radio, not the peer.
    // The readiness gate below only applies when a TX exists.
    const peripheral = this.peripheral;
    if (!peripheral) throw new Error('ble: peripheral role unavailable');
    // Readiness gate (v0.1.31): a notify resolves even with no central
    // subscribed to our TX, so sending to a peer whose handshake has
    // not finished counts as sent while landing nowhere. The caller
    // (broadcast, DM mesh) treats this throw as not-sent and queues or
    // falls back instead of logging a phantom handoff.
    if (!this.isPeerReady(peerId, Date.now())) {
      throw new Error(`ble: peer not ready ${peerId.slice(0, 8)}`);
    }
    const datagram = encodeDatagram(DATAGRAM_FRAME, frame);
    const chunkSize = Math.max(conn.mtu - ATT_OVERHEAD, 1);
    // Send on our own TX characteristic, whatever the conn role. A
    // central write to the peer RX is never delivered to the peer app
    // layer on new-arch builds: the peripheral library reports inbound
    // writes through the legacy bridge emitter, which does not deliver,
    // so a write that "succeeds" is a silent loss (proven 2026-11-03:
    // one phone logged BLE sends the other never received). TX notify
    // reaches the peer central, which receives it through the codegen
    // notification emitter. The conn still gates the send (unknown peer
    // throws) and sizes the chunks; the peer must have completed its
    // central connect to us (and so subscribed to our TX) for the
    // notify to land. NOTE: notify() broadcasts to ALL subscribed
    // centrals (library limitation); non-target peers drop the frames
    // at the mesh layer via event-ID dedup. Bandwidth-inefficient, not
    // incorrect. Failing closed when our advertiser is down is honest:
    // without it there is no TX to notify on (checked above).
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
      if (this.conns.size >= MAX_BLE_PEERS) {
        logBleDropThrottled('peer-limit', `dropped write from ${device} at peer limit`);
        return; // drop, bounded
      }
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
      // The peer connected to our peripheral and will subscribe to our
      // TX next: mark peripheral readiness before rekeying, so the
      // central-clash drop below (which drops this peripheral entry
      // when a central conn already covers the peer) cannot lose it.
      this.markPeerPeripheralHello(peerId);
      // A provisional central link for this peer (IDENT read failed,
      // link kept tag-keyed) is promoted to the full peerId first, so
      // the clash check in rekeyConn below drops the peripheral
      // duplicate instead of the central link that carries our TX
      // subscription.
      this.promoteProvisionalCentral(peerId);
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
    // A connected peer starts a fresh episode: past failures no
    // longer gate its next sightings after a later disconnect.
    this.clearConnectCooldown(conn.bleId);
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
    // A disconnect starts a fresh episode: the next sightings after
    // it are not gated by failures from the previous episode.
    this.clearConnectCooldown(conn.bleId);
    recordPeerDisconnected(key);
    this.conns.delete(key);
    if (this.bleIndex.get(conn.bleId) === key) this.bleIndex.delete(conn.bleId);
    // Forget readiness only when the peer is fully gone: the central
    // and peripheral links are separate connections, and one can drop
    // while the other still carries the peer (a central drop does not
    // mean the peer unsubscribed from our TX).
    const peerId = conn.peerId ?? (HEX64_RE.test(key) ? key : null);
    if (peerId !== null) {
      let stillPresent = false;
      for (const c of this.conns.values()) {
        if (c.peerId === peerId) {
          stillPresent = true;
          break;
        }
      }
      if (!stillPresent) this.peerReady.delete(peerId);
    }
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
    this.pendingCentralTags.clear();
    this.discovered.clear();
    await this.stopAdvertise();
  }

  /** Connected peer count (for tests/diagnostics). */
  get peerCount(): number {
    return this.conns.size;
  }

  /** Central handshake to this peer completed: we subscribed to its TX. */
  private markPeerCentralReady(peerId: string): void {
    const entry = this.peerReady.get(peerId) ?? {
      central: false,
      peripheral: false,
      peripheralHelloAtMs: 0,
    };
    entry.central = true;
    this.peerReady.set(peerId, entry);
  }

  /** A hello arrived on our peripheral side: the peer connected to us. */
  private markPeerPeripheralHello(peerId: string): void {
    const entry = this.peerReady.get(peerId) ?? {
      central: false,
      peripheral: false,
      peripheralHelloAtMs: 0,
    };
    entry.peripheral = true;
    entry.peripheralHelloAtMs = Date.now();
    this.peerReady.set(peerId, entry);
  }

  /**
   * True when a notify to this peer has a subscriber: the peer's hello
   * arrived on our peripheral side (it connected to us and subscribes
   * to our TX next) and either our central handshake completed or the
   * hello-to-subscribe settle elapsed. The central completion alone
   * does not prove the peer subscribed to OUR TX, and the hello alone
   * does not prove the subscribe already happened; both halves plus
   * the settle close the v0.1.30 drain-before-connect gap.
   */
  private isPeerReady(peerId: string, nowMs: number): boolean {
    const entry = this.peerReady.get(peerId);
    if (!entry || !entry.peripheral) return false;
    if (entry.central) return true;
    return nowMs - entry.peripheralHelloAtMs >= READY_SETTLE_MS;
  }

  /**
   * Full peerIds that are ready to RECEIVE a frame right now (see
   * isPeerReady). This is the set publish, drain, DM mesh, and flood
   * forward target: connectedPeerIds also lists peers whose handshake
   * is still in flight, and a notify to one of those resolves while
   * landing nowhere.
   */
  readyPeerIds(): string[] {
    const nowMs = Date.now();
    const ids: string[] = [];
    for (const peerId of this.peerReady.keys()) {
      if (this.isPeerReady(peerId, nowMs)) ids.push(peerId);
    }
    return ids;
  }

  /**
   * Full peerIds of established connections (deduped). Provisional ids
   * (tag:/mac: keys) are excluded: only peers whose full identity has been
   * resolved are listed. This is the mesh-pill count, NOT the publish
   * set: a peer whose handshake is still in flight is connected but
   * not ready to receive, so publish, drain, and DM mesh target
   * readyPeerIds instead.
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

/** Read the full scan record bytes from a discover event, if present. */
function rawRecordBytes(peripheral: unknown): Uint8Array | null {
  try {
    const raw = (peripheral as { advertising?: { rawData?: { bytes?: unknown; data?: unknown } } })
      ?.advertising?.rawData;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.bytes instanceof Uint8Array) return raw.bytes;
    if (Array.isArray(raw.bytes)) {
      const nums = raw.bytes as unknown[];
      if (
        nums.length > 0 &&
        nums.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255)
      ) {
        return new Uint8Array(nums as number[]);
      }
    }
    if (typeof raw.data === 'string' && raw.data.length > 0) {
      const decoded = Buffer.from(raw.data, 'base64');
      if (decoded.length > 0) return new Uint8Array(decoded);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Walk BLE AD structures in a raw scan record and collect manufacturer
 * specific data fields. Each field is [length, type, payload...] where
 * length counts the type byte plus payload. Returns one entry per 0xFF
 * field: the company id (little endian) and the payload after it.
 * Truncated or malformed input yields no entries, never throws.
 */
function manufacturerFields(record: Uint8Array): { companyId: number; payload: Uint8Array }[] {
  const out: { companyId: number; payload: Uint8Array }[] = [];
  try {
    let i = 0;
    while (i < record.length) {
      const fieldLen = record[i];
      if (fieldLen === 0) break;
      if (i + fieldLen >= record.length) break;
      const type = record[i + 1];
      if (type === 0xff) {
        const payload = record.slice(i + 2, i + 1 + fieldLen);
        if (payload.length >= 2) {
          const companyId = payload[0] | (payload[1] << 8);
          out.push({ companyId, payload: payload.slice(2) });
        }
      }
      i += 1 + fieldLen;
    }
  } catch {
    // ignore, return what was collected
  }
  return out;
}

/** Find our 8-byte mesh tag in a raw scan record, if present. */
function tagFromRawRecord(record: Uint8Array): Uint8Array | null {
  for (const field of manufacturerFields(record)) {
    if (field.companyId === ADVERTISE_COMPANY_ID && field.payload.length === 8) {
      return new Uint8Array(field.payload);
    }
  }
  return null;
}

/** Extract the 8-byte mesh tag from a ble-manager discover event. */
export function extractTag(peripheral: unknown): Uint8Array | null {
  try {
    // Parse the raw scan record first. On the codegen event path the
    // native manufacturerData map does not arrive as the keyed map the
    // lookup below expects (the codegen spec declares that field as an
    // array), so the map lookup finds nothing even while peers advertise
    // nearby. The raw record is declared as a single object in the spec
    // and survives, and it always carries the full advertisement.
    const record = rawRecordBytes(peripheral);
    if (record) {
      const tag = tagFromRawRecord(record);
      if (tag) return tag;
    }
    const p = peripheral as {
      advertising?: { manufacturerData?: Record<string, { bytes?: number[]; data?: string }> };
    };
    const md = p?.advertising?.manufacturerData;
    if (!md) return null;
    // Legacy and non-codegen shapes key manufacturerData by lowercase hex
    // ("%04x"), NOT by decimal company id: 0xFFFF arrives as "ffff".
    // Try the native hex key first, then decimal/numeric for robustness.
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
    // Scan sighting instrumentation (mesh-scan fix): every discover
    // event is counted, mesh-tagged or not, so the next device run can
    // tell "scanner delivered nothing" apart from "scanner delivered
    // packets but no mesh tag". Counts and company ids only, never
    // device ids, names, or RSSI. Flushed as one diagnostics line per
    // 60s window while sightings arrive.
    let sightTotal = 0;
    let sightMesh = 0;
    let sightNonMesh = 0;
    // Gap 109: distinct peripheral ids in the window, so the flushed
    // line can report unique counts alongside event totals. One
    // advertiser repeating does not inflate the unique count.
    const sightUnique = new Set<string>();
    const sightMeshUnique = new Set<string>();
    const sightMd = new Map<string, number>();
    let sightWindowStartMs = 0;
    const SIGHTING_WINDOW_MS = 60_000;
    function manufacturerSummary(p: unknown): string[] {
      try {
        const out: string[] = [];
        const seen = new Set<string>();
        const push = (s: string): void => {
          if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
          }
        };
        // Raw record first: real manufacturer classes from AD structures,
        // so sighting lines show what the scanner actually delivered even
        // when the keyed manufacturerData map does not survive the event.
        const record = rawRecordBytes(p);
        if (record) {
          for (const field of manufacturerFields(record)) {
            push(`${field.companyId.toString(16).padStart(4, '0')}:${field.payload.length}`);
          }
        }
        const md = (p as { advertising?: { manufacturerData?: Record<string, { bytes?: unknown; data?: unknown }> } })?.advertising
          ?.manufacturerData;
        if (md && typeof md === 'object') {
          for (const [key, entry] of Object.entries(md).slice(0, 5)) {
            let len = -1;
            if (Array.isArray((entry as { bytes?: unknown })?.bytes)) len = ((entry as { bytes: unknown[] }).bytes).length;
            else if (typeof (entry as { data?: unknown })?.data === 'string') {
              try {
                len = Buffer.from((entry as { data: string }).data, 'base64').length;
              } catch {
                len = -1;
              }
            }
            push(`${key}:${len}`);
          }
        }
        return out;
      } catch {
        return [];
      }
    }
    function noteSighting(p: unknown, tag: Uint8Array | null, peripheralId: string): void {
      sightTotal++;
      sightUnique.add(peripheralId);
      if (tag) {
        sightMesh++;
        sightMeshUnique.add(peripheralId);
      } else {
        sightNonMesh++;
        for (const s of manufacturerSummary(p)) sightMd.set(s, (sightMd.get(s) ?? 0) + 1);
      }
      const now = Date.now();
      if (sightWindowStartMs === 0) {
        sightWindowStartMs = now;
        return;
      }
      if (now - sightWindowStartMs >= SIGHTING_WINDOW_MS && sightTotal > 0) {
        // Gap 109: the flushed line labels the window it actually
        // covered (elapsed ms since window start), so two phones'
        // lines can be aligned by rate, not by raw totals alone.
        recordScanSightings(
          sightTotal,
          sightMesh,
          sightNonMesh,
          [...sightMd.entries()].map(([k, c]) => `${k}x${c}`).join(','),
          now - sightWindowStartMs,
          sightUnique.size,
          sightMeshUnique.size,
        );
        sightTotal = 0;
        sightMesh = 0;
        sightNonMesh = 0;
        sightUnique.clear();
        sightMeshUnique.clear();
        sightMd.clear();
        sightWindowStartMs = now;
      }
    }
    function mapDiscover(p: unknown): { id: string; rssi: number; tag: Uint8Array | null } {
      const tag = extractTag(p);
      const peripheralId = String((p as { id?: unknown })?.id ?? '');
      noteSighting(p, tag, peripheralId);
      return {
        id: peripheralId,
        rssi: typeof (p as { rssi?: unknown })?.rssi === 'number' ? ((p as { rssi: number }).rssi as number) : 0,
        tag,
      };
    }
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
        // ble-manager 12.6.0 supports only the new architecture
        // (README: "RN 0.76+ only the new architecture is supported"),
        // so its discover events flow through the codegen event
        // emitter (mgr.onDiscoverPeripheral), not through the legacy
        // NativeEventEmitter. The legacy subscription silently
        // received nothing on new-arch builds, which is why scanning
        // stayed up for minutes with zero peers on every device even
        // while other phones advertised. Prefer the codegen method;
        // keep the legacy emitter only as a fallback for older
        // library shapes.
        const mgrAny = mgr as unknown as {
          onDiscoverPeripheral?: (cb: (p: unknown) => void) => { remove: () => void };
        };
        if (typeof mgrAny.onDiscoverPeripheral === 'function') {
          const sub = mgrAny.onDiscoverPeripheral((p: unknown) => cb(mapDiscover(p)));
          return () => {
            try {
              sub.remove();
            } catch {
              // ignore
            }
          };
        }
        const sub = emitter.addListener('BleManagerDiscoverPeripheral', (p: unknown) => cb(mapDiscover(p)));
        return () => sub.remove();
      },
      connect: (id) => mgr.connect(id),
      disconnect: (id) => mgr.disconnect(id),
      retrieveServices: (id) => mgr.retrieveServices(id),
      // ble-manager 12.6.0 refreshCache clears the Android GATT cache;
      // absent on older shapes, so the IDENT retry treats it as
      // unavailable and proceeds with re-discovery alone.
      ...(typeof mgr.refreshCache === 'function'
        ? { refreshCache: (id: string) => mgr.refreshCache(id) }
        : {}),
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
        // Same new-architecture rule as onDiscover above: prefer the
        // codegen event method, legacy emitter only as a fallback.
        const mgrAny = mgr as unknown as {
          onDidUpdateValueForCharacteristic?: (cb: (e: { peripheral?: unknown; value?: unknown }) => void) => {
            remove: () => void;
          };
        };
        const mapNotify = (e: { peripheral?: unknown; value?: unknown }): void => {
          const raw = e?.value;
          let bytes: Uint8Array | null = null;
          if (Array.isArray(raw)) bytes = new Uint8Array(raw as number[]);
          else if (typeof raw === 'string') {
            bytes = base64ToBytes(raw);
          }
          if (bytes) cb({ id: String(e?.peripheral ?? ''), value: bytes });
        };
        if (typeof mgrAny.onDidUpdateValueForCharacteristic === 'function') {
          const sub = mgrAny.onDidUpdateValueForCharacteristic((e) => mapNotify(e));
          return () => {
            try {
              sub.remove();
            } catch {
              // ignore
            }
          };
        }
        const sub = emitter.addListener('BleManagerDidUpdateValueForCharacteristic', (e: unknown) => {
          mapNotify(e as { peripheral?: unknown; value?: unknown });
        });
        return () => sub.remove();
      },
      onDisconnect: (cb) => {
        // Same new-architecture rule as onDiscover above: prefer the
        // codegen event method, legacy emitter only as a fallback.
        const mgrAny = mgr as unknown as {
          onDisconnectPeripheral?: (cb: (e: { peripheral?: unknown }) => void) => { remove: () => void };
        };
        if (typeof mgrAny.onDisconnectPeripheral === 'function') {
          const sub = mgrAny.onDisconnectPeripheral((e) => {
            if (e?.peripheral) cb(String(e.peripheral));
          });
          return () => {
            try {
              sub.remove();
            } catch {
              // ignore
            }
          };
        }
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
          else logBleDropThrottled('malformed-write', 'dropped write event with unexpected shape');
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
