# Airplane - System Design (canonical)

> Synthesized 2026-10-10 by the architecture coordinator from the system-architect worker output.
> **v2 revision 2026-10-10** (worker 2: relay + identity): adds the RELAY subsystem (RELAY-1…5),
> the Nostr adapter spec (§6.7 / §7), the full `KeyStorePort` interface and identity model (§4.7),
> moderation data-model hooks (§5.1/§6.7), the fragment-header reconciliation note (Appendix A),
> and unified v2 constants (TTL 7, jitter 50–500 ms, 20 %/h foreground battery budget, MMKV v3.3.3).
> Mesh core (MESH-*/EVENT-*/STORE-*) is unchanged - RELAY never depends on MESH.
> Companion docs: [DIAGRAMS.md](DIAGRAMS.md) (same node IDs), [ARCHITECTURE.md](ARCHITECTURE.md) (index),
> [OSS_RESEARCH.md](OSS_RESEARCH.md) (dependency evidence), [OPERATIONS.md](OPERATIONS.md) (runtime/ADRs),
> [ROADMAP.md](ROADMAP.md) (phases). Values tagged **ASSUMPTION** need physical-device validation (P0).

---

**Status:** draft engineering reference · **Date:** 2026-10-10 · **Repo:** `enginoor/airplane` (empty)
**Stack (fixed by product spec):** React Native + Expo (dev build) · op-sqlite · MMKV · BLE GATT mesh ·
BitChat-style controlled flood (TTL/jitter/LRU dedup/fragmentation/LZ4) · Nostr-style signed immutable
events (per-device Ed25519, CBOR) · SQLite persistence · view receipts deduped by (key, post, 24h) ·
score = log(views)/age^gravity · foreground-first (iOS background BLE is OS-crippled) · sideload-first.

## 0. Reading conventions

- **ASSUMPTION** - a design decision I made where the product spec / research did not fix the value.
  Every one is a candidate for other workers (or Tuba) to change; changing it does not break the architecture.
- **per OSS research (verify)** - a library that sibling research surfaced but that I did not personally
  verify (API surface, 2026 maintenance state, Expo/RN compat). Treat as a lead, not a commitment.
- **certain** - a library/pattern I am confident exists and fits (still verify version pins at build time).
- **custom** - we build it; no OSS dependency.
- Verified protocol facts are cited inline (Bitchat README via web search; BLE spec MTU behavior).

---

## 1. Node ID registry (final - diagram worker consumes this)

Subsystems: **APP** app shell/entry/lifecycle · **UI** presentation · **FEED** ranking/views domain ·
**MESH** mesh networking · **RELAY** nostr relay uplink/downlink (v2) · **EVENT** event model/codec/crypto ops · **STORE** persistence ·
**CRYPTO** keys/identity · **LOC** location/geohash scoping · **OBS** observability ·
**DIST** build/distribution · **TEST** test doubles/simulators. IDs are sequential within each subsystem.

| ID | Name | Subsystem | One-line responsibility |
|---|---|---|---|
| APP-1 | AppEntry | APP | Expo entry: provider tree, error boundary root, boot sequencing |
| APP-2 | NavigationHost | APP | Stack/tab navigation, deep-link routing (`airplane://post/<id>`) |
| APP-3 | AppLifecycle | APP | Foreground/background state machine; drives MESH duty-cycle policy |
| APP-4 | ConfigService | APP | Build-time + runtime config, feature flags, protocol constants |
| APP-5 | BackgroundCoordinator | APP | Background relay scheduling; encodes iOS degraded-background policy |
| APP-6 | PermissionGate | APP | BLE + location runtime-permission request/rationale flow |
| UI-1 | FeedScreen | UI | Virtualized ranked feed (FlashList), pull-to-refresh = local rescan |
| UI-2 | ComposerSheet | UI | Post composer (≤280 chars), offline-first submit |
| UI-3 | PostDetailScreen | UI | Single post view + live view-count |
| UI-4 | MeshStatusIndicator | UI | Peer count / relay state pill fed by OBS-2 |
| UI-5 | SettingsScreen | UI | Identity, retention window, power mode, export/delete data |
| UI-6 | OnboardingFlow | UI | First-run: permissions, offline explainer, key generation |
| UI-7 | ThemeI18nShell | UI | Theme tokens (dark-first) + i18n provider |
| FEED-1 | FeedStore | FEED | Ranked feed state + subscriptions (UI-facing domain facade) |
| FEED-2 | RankingEngine | FEED | Pure scorer: `log10(1+views)/(age_h+2)^1.5`; incremental re-rank |
| FEED-3 | ViewTracker | FEED | Impression (≥1.5 s, ≥50 % visible) → signed view receipt; 24 h dedup |
| FEED-4 | GeohashScoper | FEED | Current cell + 8-neighbor ring filter policy for ingest and display |
| FEED-5 | PostPublisher | FEED | Draft → signed event → local store → mesh inject; offline submit queue |
| FEED-6 | TombstoneManager | FEED | Author-only delete via LWW tombstone events |
| MESH-1 | MeshEngine | MESH | Orchestrator facade: start/stop, mode control, wires 2–12 together |
| MESH-2 | FloodRouter | MESH | TTL-decrement / jittered / LRU-deduped rebroadcast decision |
| MESH-3 | Fragmenter | MESH | Signed event → 11 B-header frames, ≤469 B wire, MTU-aware sizing |
| MESH-4 | Reassembler | MESH | Frame collection → event bytes; timeout + GC of partials |
| MESH-5 | PeerDiscovery | MESH | BLE advertise + scan; peer table upkeep; rotating-ID linkability guard |
| MESH-6 | ConnectionManager | MESH | GATT connection pool, connect/disconnect, reconnect backoff |
| MESH-7 | GattTransport | MESH | Dual-role GATT server+client I/O behind one TS interface |
| MESH-8 | StoreForwardSync | MESH | Negentropy-style per-connection inventory catch-up |
| MESH-9 | PowerManager | MESH | Duty cycling + battery-adaptive scan/advertise modes |
| MESH-10 | MtuRegistry | MESH | Per-peer effective ATT MTU; input to fragment sizing |
| MESH-11 | BroadcastScheduler | MESH | Jittered send queue + per-peer backpressure; keeps FloodRouter pure |
| MESH-12 | BleNativeModule | MESH | Native BLE TurboModule behind `IBleAdapter` (custom; fallback per OSS) |
| EVENT-1 | EventBuilder | EVENT | Construct + sign post / receipt / tombstone events |
| EVENT-2 | EventVerifier | EVENT | Signature + schema + policy validation on every ingest path |
| EVENT-3 | CborCodec | EVENT | CBOR encode/decode of canonical 8-position event array |
| EVENT-4 | Lz4Codec | EVENT | LZ4 compress/decompress, threshold-gated (skip tiny payloads) |
| EVENT-5 | EventBus | EVENT | In-app pub/sub for event lifecycle (received/verified/stored/dropped) |
| EVENT-6 | CanonicalSerializer | EVENT | Canonical bytes for event-id (sha256) - what Ed25519 signs |
| STORE-1 | Database | STORE | op-sqlite connection, pragmas, transaction helper |
| STORE-2 | EventRepository | STORE | Event/receipt CRUD, feed queries, idempotent inserts |
| STORE-3 | PeerRepository | STORE | Peers + per-peer sync state |
| STORE-4 | MigrationRunner | STORE | Schema migrations keyed on `PRAGMA user_version` |
| STORE-5 | FragmentBuffer | STORE | Transient fragment assembly buffers (SQLite, aggressively purged) |
| STORE-6 | HotState | STORE | MMKV hot state: cursors, flags, UI prefs, config overrides |
| STORE-7 | RetentionJanitor | STORE | TTL expiry + pruning of events, seen-cache, fragments |
| CRYPTO-1 | KeyManager | CRYPTO | Ed25519 identity key lifecycle in Keychain/Keystore |
| CRYPTO-2 | Ed25519Ops | CRYPTO | sign/verify primitives (@noble/curves) |
| CRYPTO-3 | PeerIdRotator | CRYPTO | 15-min rotating ephemeral BLE peer IDs (HMAC-epoch) |
| LOC-1 | LocationService | LOC | GPS → current geohash-5; permission-aware; raw coords never stored |
| LOC-2 | GeohashUtil | LOC | encode/decode/neighbors (ngeohash) |
| OBS-1 | Logger | OBS | Structured on-device ring-buffer log |
| OBS-2 | MeshMetrics | OBS | tx/rx/dedup/drop/peer counters; feeds UI-4 |
| OBS-3 | CrashAdapter | OBS | Crash capture; upload-when-online queue |
| DIST-1 | BuildPipeline | DIST | EAS dev-build + release profiles (APK/AAB/IPA) |
| DIST-2 | SideloadPackager | DIST | Sideload artifacts + sha256 checksums + release notes |
| TEST-1 | SimulatorTransport | TEST | In-memory MESH-7 double; N-node mesh simulation |
| TEST-2 | BleFakes | TEST | Scripted `IBleAdapter` fake (scan/advertise/connect) |
| TEST-3 | EventFixtures | TEST | Deterministic signed event fixtures (fixed test keypair) |
| TEST-4 | FloodHarness | TEST | Broadcast-storm / load regression scenarios |
| RELAY-1 | RelayClient | RELAY | Nostr relay session manager: connect, publish fanout, subscribe |
| RELAY-2 | UplinkQueue | RELAY | Durable opt-in-only outbox; rate-limited, retried publish queue |
| RELAY-3 | DownlinkSync | RELAY | World-feed fetch: subscribe + backfill, unwrap → EVENT-2 ingest |
| RELAY-4 | RelayDirectory | RELAY | User-editable public-relay list; per-relay policy + health |
| RELAY-5 | NostrAdapter | RELAY | Wrap/unwrap our signed CBOR inside standard Nostr events (NIP-01)

---

## 2. Layered architecture (mobile-offline adaptation - no services, no K8s)

Layers are compile-time/logical, all inside one app process (+ native modules). Strict dependency rule:
**UI → FEED → EVENT → {MESH, STORE}**; **nothing depends upward**; native code is only ever touched
through TS interfaces; **APP** is the composition root (wires layers, owns no domain logic); **OBS** is a
cross-cutting sink (every layer emits to it; it depends on nothing); **CRYPTO** and **STORE** are leaves.

```
┌─────────────────────────────────────────────────────────────────┐
│ L7  Platform / native          MESH-12 BleNativeModule          │
│     op-sqlite driver · MMKV JSI · expo-secure-store · expo-loc  │
│     (TS interfaces only: IBleAdapter, IDatabase, IHotState…)    │
├─────────────────────────────────────────────────────────────────┤
│ L6  Persistence (STORE)   STORE-1…7  ← leaf; no upward deps      │
├─────────────────────────────────────────────────────────────────┤
│ L5  Crypto (CRYPTO)       CRYPTO-1…3 ← leaf; platform keystore   │
├─────────────────────────────────────────────────────────────────┤
│ L4  Mesh transport (MESH) MESH-1…12  → uses EVENT (decode/       │
│     verify inbound), STORE (peers/sync), native IBleAdapter     │
├─────────────────────────────────────────────────────────────────┤
│ L3.5 Relay uplink/downlink (RELAY) RELAY-1…5 → uses EVENT (wrap/ │
│     unwrap+verify), STORE (queue, world events, counters),       │
│     CRYPTO (relay key). MUST NOT depend on MESH - the two       │
│     transports are independent; FEED consumes both.             │
├─────────────────────────────────────────────────────────────────┤
│ L3  Event / codec (EVENT) EVENT-1…6 → uses CRYPTO (sign/verify), │
│     STORE (durable insert via repository iface)                 │
├─────────────────────────────────────────────────────────────────┤
│ L2  Domain (FEED)         FEED-1…6   → uses EVENT, STORE, LOC    │
├─────────────────────────────────────────────────────────────────┤
│ L1  Presentation (UI)     UI-1…7     → uses FEED only            │
├─────────────────────────────────────────────────────────────────┤
│ L0  Application (APP)     APP-1…6    composition root; wires all │
│ Cross-cutting: LOC-1…2 (consumed by FEED/MESH) · OBS-1…3 (sink)  │
│ Tooling: DIST-1…2 · TEST-1…4 (implement same TS interfaces)     │
└─────────────────────────────────────────────────────────────────┘
```

### Per-layer contract

**L1 Presentation (UI-1…UI-7).** Responsibilities: render, capture input, display mesh state; zero
business logic beyond view formatting. Owns: screens, components, theme, i18n strings, impression
callbacks. May depend on: FEED-1 (state), FEED-3 (impression hook), OBS-2 (metrics), APP-2 (nav).
Must NOT: touch EVENT/MESH/STORE/CRYPTO directly, compute scores, or sign anything.

**L0 Application (APP-1…APP-6).** Responsibilities: boot order, provider tree, navigation container,
lifecycle → power-policy mapping, permissions, background task registration, config. Owns: startup
sequencing (migrations before mesh start), deep-link table, background-task wiring. May depend on:
everything (composition root) but only to *wire*, never to implement domain rules.

**L2 Domain (FEED-1…FEED-6).** Responsibilities: what the user means by "the feed" - ranking, views,
scoping, publishing, deletion. Owns: ranking formula, receipt emission policy, geohash filter policy,
offline submit queue semantics, world-feed query. May depend on: EVENT (build/verify), STORE (repositories), LOC
(geohash), RELAY (world-feed read via FEED-1; opt-in uplink enqueue via FEED-5 - RELAY's `RelayPort`),
OBS. Must NOT: know BLE, frames, MTU, SQL, or Nostr wire details (those stay behind `RelayPort`).

**L4 Mesh transport (MESH-1…MESH-12).** Responsibilities: moving bytes between phones - discovery,
connections, fragmentation, flood routing, sync catch-up, power policy. Owns: TTL/jitter/dedup,
fragment sizing, peer table, sync protocol, duty cycles. May depend on: EVENT (decode+verify inbound
frames), STORE (peers, sync cursors, fragment buffers), MESH-12 `IBleAdapter`, OBS. Must NOT: rank,
render, sign (it forwards already-signed bytes opaquely - a relay cannot mint events), or know
anything about RELAY (the internet uplink is a separate transport, not a mesh extension).

**L3.5 Relay uplink/downlink (RELAY-1…RELAY-5) - v2.** Responsibilities: the opportunistic global
path - wrap our signed CBOR events inside *standard* Nostr events (NIP-01) and exchange them with
public Nostr relays (wss) as untrusted dumb pipes. Owns: relay sessions, the opt-in uplink queue,
downlink subscriptions/backfill, the relay directory, the wrap/unwrap adapter. May depend on:
EVENT (build inner event, verify on downlink), STORE (queue rows, world-event rows, publish
counters, relay health), CRYPTO (relay secp256k1 key), OBS. Must NOT: depend on MESH (mesh and relay
are sibling transports; either works with the other down), mint or mutate events (it wraps bytes
opaque-signed - same invariant as MESH), or publish anything the user didn't opt into.

**L3 Event/codec (EVENT-1…EVENT-6).** Responsibilities: the signed immutable event abstraction -
build, canonicalize, sign, verify, encode. Owns: event schema (kinds, field positions), id/sig
algorithm, size/policy bounds. May depend on: CRYPTO (key + primitives), STORE (idempotent insert),
OBS. Must NOT: know about BLE, peers, or UI.

**L6 Persistence (STORE-1…STORE-7).** Responsibilities: durable + hot state, migrations, retention.
Owns: schema, indexes, pragmas, MMKV keys, expiry. Leaf: depends on nothing above it (only on
platform drivers beneath it).

**L5 Crypto (CRYPTO-1…CRYPTO-3).** Responsibilities: identity key custody, sign/verify, rotating
peer IDs. Leaf: depends only on platform secure storage. Security boundary: private key material
never leaves this layer (signing happens inside; callers pass bytes in, get signatures out).

**L7 Platform/native.** Responsibilities: radio, disk, secure enclave access. Everything behind TS
interfaces (`IBleAdapter`, `IDatabase`, `IHotState`, `ISecureStore`, `ILocationProvider`) so TEST
doubles and platform swaps (bare ↔ Expo) don't ripple.

**Cross-cutting.** LOC: pure geohash + a location provider consumed by FEED-4/MESH-5. OBS: every
node may call OBS-1/OBS-2; OBS-3 crash handling is APP-1-installed. DIST/TEST: build + test tooling,
implement the same TS interfaces as prod nodes.
---

## 3. Shared protocol constants and core types

Constants live in APP-4 `ConfigService`; wire values are frozen at protocol version 1.

| Constant | Value | Notes |
|---|---|---|
| `PROTO_VER` | `1` | Bumped only on breaking wire change |
| `EVENT_KIND_POST` | `1` | Public broadcast post |
| `EVENT_KIND_RECEIPT` | `2` | View receipt (signed by viewer) |
| `EVENT_KIND_TOMBSTONE` | `3` | Author-only delete marker |
| `DEFAULT_TTL` | `7` | Rebroadcast hop budget (Bitchat uses TTL max 7 hops - verified from its public README; we adopt the same ceiling) |
| `FLOOD_JITTER_MS` | `50–500` uniform | ASSUMPTION; per-rebroadcast random delay |
| `SEEN_LRU_CAP` | `10_000` entries | ASSUMPTION; in-memory LRU + SQLite spillover |
| `MAX_CONTENT_CHARS` | `280` | ASSUMPTION; UTF-16 code units, NFC-normalized |
| `MAX_EVENT_BYTES` | `4_096` | ASSUMPTION; CBOR-encoded signed event ceiling (posts are ~200–600 B) |
| `GEOHASH_PRECISION` | `5` | ~4.9 km × 4.9 km cell; scope = cell + 8 neighbors |
| `PEER_ID_EPOCH_MIN` | `15` | Rotating BLE peer-ID epoch |
| `RECEIPT_DAY_BUCKET_S` | `86_400` | Dedup bucket = `floor(created_at/86400)` |
| `IMPRESSION_MIN_MS` | `1_500` | ASSUMPTION; ≥50 % visible |
| `RANK_GRAVITY` | `1.5` | ASSUMPTION; `score = log10(1+views) / (age_h+2)^1.5` |
| `DEFAULT_RETENTION_H` | `24` | ASSUMPTION; posts expire `created_at + retention` |
| `FRAG_WIRE_MAX` | `469` B | Product spec; = 11 B header + 458 B payload at full MTU |
| `FRAG_HEADER_LEN` | `11` B | §5 / Appendix C |
| `REASSEMBLY_TIMEOUT_MS` | `30_000` | ASSUMPTION |
| `SYNC_BUDGET_EVENTS` | `50` | ASSUMPTION; max events offered per sync exchange |
| `SYNC_INVENTORY_N` | `200` | ASSUMPTION; newest event tags advertised in SYNC_HELLO |
| `NOSTR_KIND_AIRPLANE` | `1919` | Regular (stored) Nostr kind for wrapped Airplane posts - see §7.1. Chosen in the `1000–9999` regular range (NIP-01); not present in the NIP kind registry as of 2026-10-10 (registry lists 1040, 1059, 1063, 1068, 1111, 1222, 1244, 1311, 1337, 1617–1622, 1630–1633, 1971, 1984–1987 in this band). Re-check the registry at build time; change requires adapter bump (`v` tag), not a wire break |
| `NOSTR_KIND_DELETION` | `5` | NIP-09 deletion request (tombstone uplink) |
| `UPLINK_DEFAULT` | `false` | Uplink is OPT-IN per post at compose time (coordinator decision) - no global auto-uplink in v1 |
| `UPLINK_RATE_PER_DAY` | `50` | ASSUMPTION; max relay publishes per relay-identity per 24 h, enforced client-side in RELAY-2 before any relay sees the event |
| `UPLINK_RETRY_BACKOFF_S` | `60, 600, 3600` | ASSUMPTION; queue retry schedule (exponential, capped) |
| `DOWNLINK_POLL_MIN` | `15` | ASSUMPTION; world-feed backfill cadence when online (subscriptions stay open in between) |
| `WORLD_GRAVITY` | `1.2` | ASSUMPTION; recency exponent for world-feed ranking (§7.4) |
| `WORLD_VIEWS_WEIGHT` | `0.5` | ASSUMPTION; mesh-views snapshot weight in world ranking |
| `MMKV_PIN` | `v3.3.3` | Unified v2 decision: pin `react-native-mmkv` v3.3.3; v4.x evaluation deferred to P5 (MetaMask 2026 v4→v3 revert incident - see OSS_RESEARCH) |
| `BATTERY_FOREGROUND_BUDGET` | `20 %/h` | Unified v2: P0 GO-gate ceiling for foreground mesh (8 %/h is the P5 stretch target) |

Core TypeScript types (owned by EVENT-3/EVENT-6, consumed everywhere):

```ts
type Hex64 = string;          // 64-char lowercase hex of 32 bytes
type UnixSec = number;

interface SignedEvent {
  id: Uint8Array;             // 32 B  sha256(canonical)
  pubkey: Uint8Array;         // 32 B  Ed25519
  created_at: UnixSec;
  kind: 1 | 2 | 3;
  geohash: string;            // geohash-5, e.g. "tdr1v"
  tags: string[][];           // post: []; receipt: [["e", <post Hex64>]]; tombstone: [["e", <post Hex64>]]
  content: string;            // post body; "" for receipt/tombstone
  sig: Uint8Array;            // 64 B  Ed25519(id)
}
// CBOR on-wire = 8-position array:
//   [0]=id(32B bstr) [1]=pubkey(32B bstr) [2]=created_at(uint) [3]=kind(uint)
//   [4]=geohash(tstr) [5]=tags(arr) [6]=content(tstr) [7]=sig(64B bstr)
// Canonical pre-image for id/sig = CBOR([0, pubkey, created_at, kind, geohash, tags, content])
// (7-position array; mirrors Nostr's [0,pubkey,created_at,kind,tags,content] with geohash inserted at index 4)

interface FeedPost {
  id: Hex64; pubkey: Hex64; createdAt: UnixSec; geohash: string;
  content: string; views: number; score: number; deleted: boolean;
}

interface PeerInfo {
  peerId: string;             // rotating BLE id (hex, 16 chars)
  rssi: number; mtu: number | null; platform: 'ios'|'android'|null;
  firstSeen: UnixSec; lastSeen: UnixSec; connected: boolean;
}
```

---

## 4. Full node inventory

Format per node: class/module · layer · responsibility · interface (TS) · inputs/outputs ·
dependencies/dependents · state & lifecycle · events consumed/emitted · data accessed/modified ·
communication · error handling · security · runtime location · OSS choice · testing · perf notes.

### 4.1 APP - app shell / entry / lifecycle

#### APP-1 AppEntry - `app/_layout.tsx` + `src/app/bootstrap.ts` - L0 Application - custom
- **Responsibility/scope:** Expo Router entry. Owns boot sequencing: (1) load ConfigService,
  (2) MigrationRunner, (3) KeyManager unlock-or-generate, (4) Database open, (5) construct layer
  graph via composition root, (6) install CrashAdapter + global error boundary, (7) mount
  NavigationHost. Renders nothing except boot splash / fatal-error screen.
- **Interface:** `async function bootstrap(): Promise<AppGraph>`; `AppGraph` = `{ config, db,
  feed, mesh, event, crypto, loc, obs, ... }` (typed DI container). `function FatalBootScreen({error})`.
- **Inputs/outputs:** In: nothing (process start). Out: mounted React tree or fatal screen.
- **Dependencies:** all layers (wiring only). **Dependents:** none (root).
- **State & lifecycle:** process-lifetime singleton; boot is one-shot, non-retryable except full restart.
- **Events:** emits `app:booted`, `app:boot_failed` (OBS-1).
- **Data:** reads MMKV (HotState) for last-known-good config; writes boot marker.
- **Communication:** direct construction (no IPC - single process).
- **Errors:** any boot-step failure → fatal screen with "retry" (restarts JS) + OBS-3 capture;
  MigrationRunner failure is the only non-bypassable fatal.
- **Security:** no secrets handled; ensures KeyManager unlock precedes mesh start.
- **Runtime:** JS thread (Hermes), runs before React mount.
- **OSS:** custom + `expo-router` (certain) + `expo-splash-screen` (certain).
- **Testing:** TEST-2/TEST-3 driven boot test: migrations run, graph constructs, mesh NOT started
  until permissions granted.
- **Perf:** boot budget ≤ 2 s on mid-tier Android (ASSUMPTION target); migrations are the long pole.

#### APP-2 NavigationHost - `src/app/NavigationHost.tsx` - L0 - custom (+ expo-router certain)
- **Responsibility:** stack/tab topology: `onboarding → feed → (composer modal, post/:id, settings)`;
  deep-link table `airplane://post/<hex64>` → PostDetailScreen (validates hex64, loads via FEED-1,
  404 → feed).
- **Interface:** `function NavigationHost({graph}: {graph: AppGraph})`; `navigate(route: Route)`.
- **Inputs/outputs:** In: deep links, UI nav calls. Out: screen mounts.
- **Dependencies:** APP-1 (graph), FEED-1 (post resolution). **Dependents:** UI screens.
- **State:** router state only; no domain state.
- **Events:** consumes `eventbus:post_deleted` → pops detail if viewing deleted post.
- **Errors:** malformed deep link → toast + stay; unknown post id → inline "not found (yet - mesh
  may still deliver it)" empty state.
- **Security:** deep-link ids are content-addressed (hash), no auth needed; no PII in URLs.
- **Runtime:** JS thread. **OSS:** `expo-router` (certain), `expo-linking` (certain).
- **Testing:** link-parsing unit tests incl. adversarial inputs.

#### APP-3 AppLifecycle - `src/app/AppLifecycle.ts` - L0 - custom
- **Responsibility:** subscribes `AppState`; maintains `foreground | background | inactive`;
  maps transitions to power policy: foreground → MESH-9 `active`; background → `degraded`
  (stop advertising connectable, keep short scan windows on Android; on iOS, effectively suspend -
  documented OS limit, no fake background relay).
- **Interface:** `class AppLifecycle { readonly state: Signal<AppState>; onChange(cb): Unsub }`.
- **Dependencies:** MESH-1, MESH-9, OBS-1. **Dependents:** APP-1, APP-5.
- **State:** current app state + last transition ts (MMKV-persisted for "was backgrounded X min" logic).
- **Errors:** listener failures are swallowed + logged (non-critical).
- **Runtime:** JS thread. **Testing:** fake AppState emitter.

#### APP-4 ConfigService - `src/app/Config.ts` - L0 - custom
- **Responsibility:** single source of protocol constants (§3) + build config (flavor, version) +
  runtime overrides (MMKV, e.g. retention hours, power mode). Feature flags for A/B of jitter/gravity.
- **Interface:** `class ConfigService { get<K extends keyof Config>(k: K): Config[K]; override(k, v): void }`.
- **Dependencies:** STORE-6 (overrides). **Dependents:** everything (read-only).
- **State:** in-memory merged config; overrides persisted in MMKV.
- **Errors:** unknown key → throw at dev time (typed keys); corrupt override → reset to default + log.
- **Runtime:** JS thread. **Testing:** override round-trip tests.

#### APP-5 BackgroundCoordinator - `src/app/Background.ts` - L0 - custom
- **Responsibility:** registers background tasks (`expo-background-fetch`/`expo-task-manager` -
  certain libs, **per OSS research (verify)** for our exact use): periodic 15-min wake on Android to
  run a bounded MESH-8 sync burst; on iOS registers BGProcessing task but treats grants as
  best-effort (OS may never grant - design assumes foreground-first; document, don't fight it).
- **Interface:** `async function registerBackgroundTasks(graph): Promise<void>`.
- **Dependencies:** APP-3, MESH-1, MESH-9. **Dependents:** APP-1.
- **State:** last background run ts (MMKV).
- **Errors:** task timeout (OS kills at ~30 s iOS / ~10 min Android - ASSUMPTION) → clean abort,
  partial sync state is resumable via cursors.
- **Security:** no new surface; same signed-event validation path.
- **Runtime:** JS thread, spawned by OS in background context.
- **Testing:** manual device testing primarily; TEST-1 sim for logic.

#### APP-6 PermissionGate - `src/app/Permissions.tsx` - L0 - custom
- **Responsibility:** requests `BLUETOOTH_SCAN/CONNECT/ADVERTISE` (Android 12+), `ACCESS_FINE_LOCATION`
  (needed for BLE scan on Android + geohash), iOS `NSBluetoothAlwaysUsageDescription` +
  `NSLocationWhenInUseUsageDescription`. Rationale UI, "never ask again" → settings deep-link,
  degraded-mode banner when denied (feed shows cached only).
- **Interface:** `async function ensurePermissions(): Promise<PermissionSet>`; `<PermissionGate>`.
- **Dependencies:** APP-4 (rationale copy), OBS-1. **Dependents:** APP-1 (boot), MESH-1 (start gate).
- **Errors:** denial is a *state*, not an error - mesh stays off, UI explains.
- **OSS:** `expo-location` (certain) permission helpers; BLE permission constants custom per platform.

### 4.2 UI - presentation

#### UI-1 FeedScreen - `src/ui/FeedScreen.tsx` - L1 - custom + FlashList (certain)
- **Responsibility:** virtualized ranked feed for current geohash scope. Pull-to-refresh triggers
  MESH-5 rescan burst (not a server fetch - copy says "scanning nearby"). Empty states: no peers,
  no posts, permission-denied. Renders UI-4 header pill.
- **Interface:** `function FeedScreen()`; props none (reads FEED-1 via hook `useFeed()`).
  `onViewableItemsChanged` → FEED-3 impression callbacks.
- **Inputs/outputs:** In: ranked `FeedPost[]` from FEED-1. Out: impression events, nav to detail/composer.
- **Dependencies:** FEED-1, FEED-3, OBS-2 (via UI-4). **Dependents:** APP-2.
- **State:** list scroll position (ephemeral); feed data owned by FEED-1.
- **Events:** consumes `feed:updated` → re-render; emits `ui:impression` → FEED-3.
- **Errors:** FEED-1 errors → inline retry banner; never crashes on malformed post (renders tombstone).
- **Runtime:** JS thread; FlashList native virtualization.
- **Testing:** TEST-3 fixtures render test; impression threshold unit test.
- **Perf:** `estimatedItemSize` tuned; `drawDistance` small; score text memoized (avoid re-layout on
  re-rank - re-rank animates via `key=id` stability).

#### UI-2 ComposerSheet - `src/ui/ComposerSheet.tsx` - L1 - custom
- **Responsibility:** 280-char composer, char counter, geohash scope label ("posting to ~5 km around
  you"), offline-first submit → FEED-5. Local echo: post appears instantly, badge "relaying…".
- **Interface:** `function ComposerSheet({onClose})`; `submit(draft: string): Promise<Hex64>`.
- **Dependencies:** FEED-5, FEED-4 (scope label). **Dependents:** APP-2 (modal route).
- **State:** draft text (ephemeral; preserved across sheet dismiss via MMKV draft key - ASSUMPTION).
- **Errors:** empty/over-limit → inline validation (EVENT-2 bounds mirrored); sign failure →
  "couldn't sign - restart app" (CRYPTO-1 failure is fatal-ish, surfaced honestly).
- **Security:** no plaintext leaves the device except inside the signed event.
- **Testing:** validation matrix (length, emoji, NFC normalization).

#### UI-3 PostDetailScreen - `src/ui/PostDetailScreen.tsx` - L1 - custom
- **Responsibility:** single post, full text, view count (live via FEED-1 subscription), age,
  relay stats ("seen by N devices" - honest label: views = receipt count, not humans; copy owned here),
  delete (own posts → FEED-6).
- **Interface:** `function PostDetailScreen({id: Hex64})`.
- **Dependencies:** FEED-1, FEED-6. **Dependents:** APP-2.
- **Errors:** unknown id → "waiting for mesh" skeleton; deleted → tombstone notice.

#### UI-4 MeshStatusIndicator - `src/ui/MeshStatus.tsx` - L1 - custom
- **Responsibility:** pill showing `peers: N · relay: on/degraded · power: mode`. Tapping opens
  Settings mesh section. Pure view over OBS-2.
- **Interface:** `function MeshStatusIndicator()`; hook `useMeshMetrics(): MeshSnapshot`.
- **Dependencies:** OBS-2. **Dependents:** UI-1.
- **Perf:** subscribes at 1 Hz max (throttled) to avoid re-render churn.

#### UI-5 SettingsScreen - `src/ui/SettingsScreen.tsx` - L1 - custom
- **Responsibility:** identity (pubkey fingerprint, "rotate identity" = new keypair + warning that old
  posts stay), retention window (6/12/24/48 h → APP-4 override), power mode (performance/balanced/
  saver → MESH-9), export my posts (JSON), delete all local data (STORE-1 wipe + key rotation).
- **Dependencies:** CRYPTO-1, APP-4, MESH-9, STORE-1, FEED-5.
- **Security:** "delete all" must also wipe Keychain item; export is user-initiated plaintext - warn.

#### UI-6 OnboardingFlow - `src/ui/Onboarding.tsx` - L1 - custom
- **Responsibility:** 3 slides (what it is / airplane-mode promise / anonymity limits - honest copy:
  "signed, not encrypted; anyone nearby can read"), permission prompts (APP-6), key generation
  progress (CRYPTO-1). Skippable only after permissions decided.
- **Dependencies:** APP-6, CRYPTO-1, STORE-6 (onboarded flag).

#### UI-7 ThemeI18nShell - `src/ui/Theme.tsx` + `src/ui/i18n.ts` - L1 - custom + i18next (certain)
- **Responsibility:** dark-first theme tokens, font scale respect, locale bundles (en at launch;
  hi deferred - A-016 DISPUTED, needs Tuba's call); `t()` namespaced by screen. No business logic.
- **Dependencies:** STORE-6 (locale/theme prefs). **Dependents:** all UI.
- **OSS:** `i18next` + `react-i18next` (certain).

### 4.3 FEED - ranking/views domain

#### FEED-1 FeedStore - `src/feed/FeedStore.ts` - L2 - custom (zustand per OSS research (verify) or custom signals)
- **Responsibility:** UI-facing domain facade. Owns the ranked `FeedPost[]` for current scope,
  subscriptions, optimistic local echo, tombstone filtering, and - v2 - the World feed
  (`getWorldFeed()`), which queries `source='world'` rows ranked by §7.4 (recency-primary,
  mesh-views secondary, counts labeled approximate). The ONLY node UI talks to for feed data.
- **Interface:**
  ```ts
  interface IFeedStore {
    subscribe(cb: (posts: FeedPost[]) => void): Unsub;
    getSnapshot(): FeedPost[];                       // React useSyncExternalStore-compatible
    getPost(id: Hex64): FeedPost | null;
    refreshScope(): Promise<void>;                   // re-query after geohash change
    // v2 - world feed (behind RelayPort; FEED-1 never touches Nostr bytes)
    subscribeWorld(cb: (posts: WorldPost[]) => void): Unsub;
    getWorldSnapshot(): WorldPost[];
    refreshWorld(): Promise<void>;                   // triggers RELAY-3 backfillNow()
  }
  interface WorldPost extends FeedPost { viewsApprox: boolean; originGeohash: string; }
  ```
- **Inputs/outputs:** In: EVENT-5 lifecycle events, STORE-2 query results. Out: sorted posts.
- **Dependencies:** FEED-2 (scoring), FEED-4 (scope), STORE-2 (queries), EVENT-5, RELAY-1/3 (via
  `RelayPort` - world only). **Dependents:** UI-1/2/3, APP-2.
- **State & lifecycle:** in-memory sorted array + `Map<Hex64, FeedPost>`; rebuilt on scope change or
  every 30 s re-rank tick (ASSUMPTION); process lifetime. World snapshot is a SEPARATE array -
  the two feeds never interleave (different tabs, different ranking functions).
- **Events:** consumes `event:stored(post|receipt|tombstone)` → incremental update; emits `feed:updated`.
  Consumes `relay:downlink_stored` → world incremental update; emits `feed:world_updated`.
- **Data:** reads events/receipts/view_counts via STORE-2; writes nothing directly. Muted authors
  and keyword-filtered content are excluded in BOTH feed queries (moderation, §7.5).
- **Errors:** query failure → keeps last snapshot + `feed:stale` flag; never throws to UI.
- **Runtime:** JS thread. **Testing:** TEST-3 fixtures: insert 100 posts + receipts, assert order
  matches FEED-2 scores; tombstone removal. World: fixtures with `source='world'` rank by §7.4;
  muted-key exclusion test.
- **Perf:** incremental rescore on receipt (O(log n) heap or sorted-insert; full re-sort capped at
  2 000 posts - ASSUMPTION - then paginate by score cutoff).

#### FEED-2 RankingEngine - `src/feed/Ranking.ts` - L2 - custom (pure)
- **Responsibility:** pure scoring. `score(views, ageSec) = log10(1+views) / ((ageSec/3600)+2)^1.5`.
  Also `viewsFor(postId)` aggregation helper (distinct pubkeys in current day bucket + carried
  prior buckets? - views are lifetime-distinct-pubkeys; ASSUMPTION).
- **Interface:** `function scorePost(views: number, ageSec: number): number`;
  `function rank(posts: FeedPost[]): FeedPost[]`.
- **Dependencies:** none (pure). **Dependents:** FEED-1.
- **Errors:** none (total function; clamps negatives/NaN).
- **Testing:** property tests: monotonic in views, decreasing in age, new-post boost sanity.

#### FEED-3 ViewTracker - `src/feed/ViewTracker.ts` - L2 - custom
- **Responsibility:** impression → receipt pipeline. Watches `onViewableItemsChanged`; item visible
  ≥50 % for ≥1.5 s → exactly-once-per-24h check (STORE-2 `hasReceipt(pubkey, postId, bucket)`) →
  EVENT-1 `buildReceipt` → MESH-1 publish (receipts flood like posts, TTL 7). Batches: emits at most
  1 receipt per 2 s app-wide (ASSUMPTION) to avoid storm on fast scroll.
- **Interface:** `class ViewTracker { trackViewable(ids: Hex64[], visibleMs: Map<Hex64, number>): void }`.
- **Inputs/outputs:** In: UI impression callbacks. Out: signed receipt events into mesh.
- **Dependencies:** EVENT-1, STORE-2, MESH-1, CRYPTO-1 (own pubkey), OBS-2. **Dependents:** UI-1.
- **State:** in-memory `Map<Hex64, firstVisibleTs>`; processed-set per bucket (memory + STORE-2 truth).
- **Events:** emits `feed:receipt_emitted {postId}` (OBS-2 counter).
- **Errors:** sign/publish failure → drop silently + counter (receipts are best-effort; no retry -
  next impression re-triggers).
- **Security:** receipt links viewer pubkey to post view - by design (dedup needs it); copy in UI-6
  discloses "views are public, like everything here".
- **Testing:** fake timers: 1.4 s = no receipt, 1.6 s = one receipt; 24 h dedup via STORE-2 fake.

#### FEED-4 GeohashScoper - `src/feed/Scope.ts` - L2 - custom
- **Responsibility:** scope policy: current geohash-5 + 8 neighbors = visible/ingestible set.
  Ingest rule (EVENT-2 calls this): drop events outside ring (don't store, don't relay - keeps flood
  location-bounded). Display rule: FEED-1 filters to ring.
- **Interface:** `class GeohashScoper { current(): string; ring(): string[9]; inScope(gh: string): boolean }`.
- **Dependencies:** LOC-1, LOC-2. **Dependents:** FEED-1, FEED-5, EVENT-2, MESH-2.
- **State:** cached current cell; refreshes on LOC-1 movement callback (>~1 km - ASSUMPTION).
- **Errors:** location unavailable → fall back to last-known cell (STORE-6) + `scope:stale` banner.
- **Testing:** neighbor-ring unit tests incl. edge cells (poles/dateline via LOC-2 vectors).

#### FEED-5 PostPublisher - `src/feed/Publish.ts` - L2 - custom
- **Responsibility:** `submitPost(draft, opts?)` - validate (EVENT-2 bounds), EVENT-1 build+sign
  (passing `opts.uplinkOptIn` through so the `["uplink","1"]` tag is signed into the event),
  STORE-2 insert, FEED-1 optimistic add, MESH-1 publish; offline submit queue (MMKV) for posts
  composed while mesh is down → flush on `mesh:ready`. v2: if the user toggled "share to World"
  at compose time (OPT-IN, default OFF - no global auto-uplink), ALSO enqueue the signed event
  in RELAY-2 (`IUplinkQueue.enqueue` with the current mesh view-count snapshot). The mesh path
  and the uplink path are independent - either can fail without affecting the other. Couriers
  (other online mesh members) re-derive eligibility from the signed tag, never from local state.
- **Interface:** `async function submitPost(draft: string, opts?: {ttl?: number, uplinkOptIn?: boolean}): Promise<Hex64>`.
- **Dependencies:** EVENT-1/2, STORE-2/6, MESH-1, FEED-1, OBS-2, RELAY-2 (via `RelayPort`, v2).
  **Dependents:** UI-2, UI-5 (export).
- **Errors:** `ValidationError` → UI inline; `SignError` → fatal-ish surfacing; publish failure →
  queued + "will relay when peers appear" (honest offline copy). Uplink enqueue failure →
  `uplink:enqueue_failed` event (post still floods the mesh - uplink is best-effort).
- **Timeouts:** local pipeline ≤ 5 s or queue; no network timeout (there is no network).

#### FEED-6 TombstoneManager - `src/feed/Tombstones.ts` - L2 - custom
- **Responsibility:** `deletePost(id)` - only if `post.pubkey == own pubkey` (else `NotAuthorError`);
  EVENT-1 builds kind-3 tombstone referencing post; floods; FEED-1 hides on receipt; STORE-2 marks
  `deleted=1` (LWW: tombstone `created_at` > post `created_at` wins; earlier tombstone ignored).
  v2: if the post was ever uplinked (has `nostr_id`), ALSO enqueue the tombstone in RELAY-2's
  priority lane → published as Nostr kind 5 (NIP-09, §7.2). Relay deletion is a request, not a
  guarantee - local application is the real delete.
- **Interface:** `async function deletePost(id: Hex64): Promise<void>`.
- **Dependencies:** EVENT-1, STORE-2, MESH-1, CRYPTO-1. **Dependents:** UI-3.
- **Data:** modifies `events.deleted`; tombstone itself stored as event (kind 3).
- **Security:** author check is cryptographic (verifier enforces `tombstone.pubkey == target.pubkey`);
  relays can't forge deletes.
- **Consistency:** append-only + LWW tombstones (§6).

### 4.4 MESH - mesh transport

#### MESH-1 MeshEngine - `src/mesh/MeshEngine.ts` - L4 - custom
- **Responsibility:** facade/orchestrator. `start()/stop()` in dependency order
  (MESH-12 → MESH-10 → MESH-5 → MESH-6 → MESH-7 → MESH-8 → MESH-2). Owns `mesh:ready` state.
  Routes: outbound `publish(bytes)` → MESH-3 → MESH-11 → MESH-7; inbound bytes → MESH-4 → EVENT-2 →
  STORE-2 → MESH-2 (relay decision).
- **Interface:**
  ```ts
  interface IMeshEngine {
    start(): Promise<void>; stop(): Promise<void>;
    readonly ready: boolean;
    publish(event: SignedEvent): Promise<void>;      // sign-then-fragment-then-flood (own events)
    injectRelay(raw: Uint8Array): Promise<void>;     // verified bytes from MESH-4 → flood
  }
  ```
- **Dependencies:** MESH-2…12, EVENT-1/2/3/4, STORE-2/3/5, OBS-1/2. **Dependents:** FEED-3/5/6, APP-3/5.
- **State:** started flag, mode (`active|degraded|off`).
- **Errors:** start failure (BLE off) → `MeshError(BLE_OFF)` + UI-4 shows off; partial start rolls back.
- **Runtime:** JS thread; all BLE I/O via MESH-12 async bridge.
- **Testing:** TEST-1 replaces MESH-7; TEST-2 replaces MESH-12.

#### MESH-2 FloodRouter - `src/mesh/Flood.ts` - L4 - custom (pure decision + relay fan-out)
- **Responsibility:** controlled flood. On verified event: (1) `seen(msgTag)`? drop+count;
  (2) TTL 0? drop; (3) FEED-4 `inScope`? else drop (no store, no relay); (4) schedule rebroadcast
  with jitter 50–500 ms, TTL−1, to all connected peers except ingress peer. Own events: TTL=7 initial.
- **Interface:** `class FloodRouter { onVerified(event: SignedEvent, ingress: PeerId|null): void }`.
- **Dependencies:** FEED-4, MESH-11, STORE-2 (seen check via msgTag), OBS-2. **Dependents:** MESH-1.
- **State:** none durable (seen-cache in STORE-2/`seen` table + memory LRU).
- **Errors:** no throws; drops counted by reason (`dup|ttl|scope|oversize`).
- **Testing:** TEST-4 storm: 50 nodes, 1 event → assert ≤ N×TTL transmissions, no loops, scope-bounded.
- **Perf:** decision O(1); jitter timers via MESH-11 (single timer wheel, not per-event setTimeout -
  ASSUMPTION implementation guidance).

#### MESH-3 Fragmenter - `src/mesh/Fragment.ts` - L4 - custom (pure)
- **Responsibility:** `SignedEvent → Uint8Array[]` frames. Pipeline: EVENT-3 CBOR → (if ≥64 B)
  EVENT-4 LZ4 → split into `payload = min(effMtu−3−11, 458)` chunks → prepend 11 B header (§App C).
  Per-peer sizing: caller passes peer MTU from MESH-10 (broadcast uses min over connected peers -
  ASSUMPTION).
- **Interface:** `function fragment(compressed: Uint8Array, msgTag: Uint8Array, mtu: number): Uint8Array[]`.
- **Dependencies:** EVENT-3/4, MESH-10. **Dependents:** MESH-1, MESH-8.
- **Errors:** event > `MAX_EVENT_BYTES` → `OversizeError` (dropped before radio).
- **Testing:** round-trip with MESH-4 across MTU 23/185/517; header byte-exact vectors.

#### MESH-4 Reassembler - `src/mesh/Reassemble.ts` - L4 - custom
- **Responsibility:** collects frames by `msgTag`; on `frag_total` received → concat → (LZ4 magic?
  decompress) → CBOR bytes → EVENT-2 verify. 30 s timeout → purge + `reassembly:timeout` counter.
  Duplicate frames ignored; interleaved messages supported.
- **Interface:** `class Reassembler { ingest(frame: Uint8Array, from: PeerId): void }`.
- **Dependencies:** EVENT-2/3/4, STORE-5 (buffer spillover for large), OBS-2. **Dependents:** MESH-1.
- **State:** `Map<msgTag, {total, received: Map<idx, bytes>, timer}>` + STORE-5 persistence for
  >4-fragment messages (ASSUMPTION) so background kills don't lose big posts.
- **Errors:** corrupt frame (bad header/mtu overrun) → drop + counter; never throws to transport.

#### MESH-5 PeerDiscovery - `src/mesh/Discovery.ts` - L4 - custom
- **Responsibility:** advertise (service UUID + rotating peer id in manufacturer data, connectable)
  + scan (filtered by service UUID, duty-cycled by MESH-9). Maintains peer table via STORE-3;
  RSSI smoothing; peer-lost after 3 missed windows (ASSUMPTION).
- **Interface:** `class PeerDiscovery { startAdvertising(): Promise<void>; startScan(): Promise<void>; onPeer(cb): Unsub }`.
- **Dependencies:** MESH-12, MESH-9, MESH-10, STORE-3, CRYPTO-3, OBS-2. **Dependents:** MESH-1, MESH-6.
- **State:** in-memory peer map; persisted first/last-seen in STORE-3.
- **Errors:** `BLE_OFF` → stop + `discovery:off`; scan failures backoff (MESH-9).
- **Security:** advertised id rotates every 15 min (CRYPTO-3); no pubkey, no device name in adv packet
  (ASSUMPTION - name omitted for privacy; iOS background adv wouldn't carry it anyway).
- **Runtime:** JS thread driving MESH-12; scan callbacks are the hot path - keep handler O(1).

#### MESH-6 ConnectionManager - `src/mesh/Connections.ts` - L4 - custom
- **Responsibility:** connection pool: connect on discovery (cap 5 concurrent - ASSUMPTION),
  prefer strongest RSSI unseen-sync peers; disconnect idle >60 s (ASSUMPTION); exponential reconnect
  backoff (1/2/4/8 s, jitter); link-loss → MESH-8 cursor preserved for resume.
- **Interface:** `class ConnectionManager { ensureConnected(peer: PeerId): Promise<Conn>; pruneIdle(): void }`.
- **Dependencies:** MESH-12, MESH-7, MESH-10, STORE-3, OBS-2. **Dependents:** MESH-1, MESH-11.
- **Errors:** `GATT_ERROR`/`TIMEOUT` → backoff; pool exhaustion → skip lowest-RSSI.

#### MESH-7 GattTransport - `src/mesh/Gatt.ts` - L4 - custom
- **Responsibility:** dual-role GATT: as peripheral, exposes RX_CHAR (write-without-response) +
  TX_CHAR (notify) + ID_CHAR (read); as central, discovers service, subscribes TX, writes RX.
  Single TS interface for both roles; role chosen per connection (we initiate → central).
  Routes raw frames up to MESH-1, sends MESH-11 queue down.
- **Interface:**
  ```ts
  interface IGattTransport {
    write(peer: PeerId, frame: Uint8Array): Promise<void>;   // write-without-response, MTU-chunked by MESH-12
    onFrame(cb: (frame: Uint8Array, from: PeerId) => void): Unsub;
    readPeerInfo(peer: PeerId): Promise<{ peerId: string; protoVer: number; mtu: number }>;
  }
  ```
- **Dependencies:** MESH-12 (`IBleAdapter`), MESH-10. **Dependents:** MESH-1, MESH-6, MESH-11.
- **GATT profile:** (ASSUMPTION - finalize before interop testing)
  `SVC = 128-bit 'AIRPLANE_SVC'`; `RX_CHAR` write-without-response (central→peripheral);
  `TX_CHAR` notify (peripheral→central); `ID_CHAR` read (peerId‖protoVer‖flags).
- **Errors:** write queue full → `BackpressureError` → MESH-11 sheds lowest-priority (oldest relay first).
- **Testing:** TEST-1 in-memory double implements `IGattTransport` exactly.
- **Perf:** notify > write for peripheral→central bulk; coalesce ≤MTU writes per event-loop turn.

#### MESH-8 StoreForwardSync - `src/mesh/Sync.ts` - L4 - custom
- **Responsibility:** negentropy-style catch-up per connection. Exchange: `SYNC_HELLO{cells, newestN
  tags[8B], minTs}` → peer computes set difference against own store → `SYNC_OFFER{events…}` (≤50,
  newest first, in-scope only) → requester verifies/stores/floods. Both directions can offer.
  Cursors in STORE-3 (`cursor_ts`) make repeat connects cheap.
- **Interface:** `class StoreForwardSync { onConnect(peer: PeerId): Promise<void> }`.
- **Frame types:** `0x02 SYNC_HELLO`, `0x03 SYNC_WANT`, `0x04 SYNC_OFFER` (frame envelope §App C).
- **Dependencies:** STORE-2/3, MESH-3/4/7, EVENT-2, FEED-4, OBS-2. **Dependents:** MESH-1, MESH-6.
- **State:** per-peer cursor (STORE-3); in-flight offer assembly (memory).
- **Errors:** peer sends garbage → abort sync, keep connection for flood; oversize offer → truncate.
- **Testing:** TEST-1: node A offline 1 h, B accumulates, A connects → converges; assert no duplicates
  (seen-cache) and scope respected.
- **Perf:** inventory is 200×8 B = 1.6 KB - one frame at full MTU; CPU trivial.

#### MESH-9 PowerManager - `src/mesh/Power.ts` - L4 - custom
- **Responsibility:** duty-cycle policy. Modes: `performance` (scan 100 %, adv 100 %),
  `balanced` (scan 30 s on/30 s off - ASSUMPTION), `saver` (scan 10 s/min, adv low power).
  Auto-derate on battery <30 % (ASSUMPTION) unless user pins performance. Maps APP-3 background →
  `degraded` (Android: brief scan windows; iOS: stop - honest OS limit).
- **Interface:** `class PowerManager { setMode(m: PowerMode): void; scanWindow(): {onMs, offMs} }`.
- **Dependencies:** APP-3, MESH-5, OBS-2. **Dependents:** MESH-1, MESH-5.
- **Testing:** mode-transition table test; battery-threshold test with fake battery API.

#### MESH-10 MtuRegistry - `src/mesh/Mtu.ts` - L4 - custom
- **Responsibility:** per-peer effective ATT MTU. Learns from `onMtuChanged` (Android `requestMtu(517)`)
  / iOS `maximumWriteValueLength(.withoutResponse)` and `maximumUpdateValueLength`; default 23
  (20 B payload) until learned - never assume. Feeds MESH-3 sizing and MESH-7 chunking.
- **Interface:** `class MtuRegistry { effective(peer: PeerId): number; learned(peer, mtu): void; clear(peer): void }`.
- **Dependencies:** MESH-12 callbacks. **Dependents:** MESH-3, MESH-7.
- **State:** `Map<PeerId, mtu>` + persisted in STORE-3 (hint only; re-negotiated each connect).
- **Errors:** none - safe default.
- **Verified pattern:** per-peer MTU map is how offline-protocol-sdk and react-native-lxmf fixed the
  static-244 B bug (verified via web search) - we adopt the same.

#### MESH-11 BroadcastScheduler - `src/mesh/Scheduler.ts` - L4 - custom
- **Responsibility:** jittered send queue. `enqueue(frame, peers, {priority})`; single timer wheel
  applies 50–500 ms jitter; per-peer queue cap 64 frames (ASSUMPTION) → shed lowest priority
  (relay-oldest first, own posts last). Keeps MESH-2's decision logic pure/testable.
- **Interface:** `class BroadcastScheduler { enqueue(f: OutFrame): void; drain(peer): Promise<void> }`.
- **Dependencies:** MESH-6/7, OBS-2. **Dependents:** MESH-2, MESH-8.
- **Errors:** `BackpressureError` counted; shed events logged at debug.

#### MESH-12 BleNativeModule - `src/mesh/native/` (Swift + Kotlin) + `IBleAdapter.ts` - L7/L4 - custom TurboModule
- **Responsibility:** the ONLY native BLE code. Exposes `IBleAdapter` to JS: `startAdvertising(opts)`,
  `stopAdvertising`, `startScan(filter)`, `stopScan`, `connect(peerId)`, `disconnect`, `write(peer,
  charUuid, bytes /* withoutResponse */)`, `subscribe(peer, charUuid, cb)`, `read(peer, charUuid)`,
  `requestMtu(peer, 517)`, `onMtuChanged(cb)`, `getState()` (poweredOn/…).
- **Interface:** `IBleAdapter` (TS, versioned `ADAPTER_V1`); native implements; TEST-2 fakes.
- **Dependencies:** CoreBluetooth (CBCentralManager + CBPeripheralManager) / Android BluetoothLe
  (Advertiser/Scanner/Gatt/GattServer). **Dependents:** MESH-5/6/7/10.
- **State:** native-owned (adapters, gatt handles); JS holds only peer-id strings.
- **Errors:** error codes `BLE_OFF, UNAUTHORIZED, TIMEOUT, GATT_ERROR(status), BUSY`; all ops timeout
  (connect 10 s, write 5 s, read 5 s - ASSUMPTION).
- **Security boundary:** no key material crosses; bytes are opaque. Permissions enforced at APP-6
  before start; native re-checks state on each call.
- **Runtime:** native threads → bridged to JS (events via TurboModule emitter).
- **OSS:** custom TurboModule recommended (peripheral role + MTU callbacks + background modes need
  native control). Fallback **per OSS research (verify):** `react-native-bluetooth-ble`
  (central+peripheral+L2CAP+background per 2026 UI research) - evaluate against `IBleAdapter`
  conformance before committing.
- **Testing:** TEST-2 scripted fake; on-device matrix (Android 12–16, iOS 17–18 - ASSUMPTION targets).

### 4.5 EVENT - event model / codec / crypto ops

#### EVENT-1 EventBuilder - `src/event/Build.ts` - L3 - custom
- **Responsibility:** constructs unsigned event → EVENT-6 canonical bytes → CRYPTO-1/2 sign →
  `SignedEvent`. Builders: `buildPost(content, geohash, opts?)`, `buildReceipt(postId)`,
  `buildTombstone(postId)`. Sets `created_at=now`, `ttl` is transport-level (not in event).
  `opts.uplinkOptIn=true` embeds the `["uplink","1"]` tag INSIDE the signed canonical bytes
  (wire-compatible: `tags` is extensible, PROTO_VER 1 unaffected). Couriers - any online mesh
  member, not just the author - read this tag to decide uplink eligibility; stripping or
  altering it invalidates the Ed25519 signature, so the tag is trustworthy wherever EVENT-2
  has verified the event first.
- **Interface:**
  ```ts
  interface IEventBuilder {
    buildPost(content: string, geohash: string, opts?: { uplinkOptIn?: boolean }): Promise<SignedEvent>;
    buildReceipt(postId: Hex64): Promise<SignedEvent>;
    buildTombstone(postId: Hex64): Promise<SignedEvent>;
  }
  ```
- **Tag conventions (v2, normative):** `tags` is a list of string arrays inside the signed
  canonical bytes. Defined tags: `["uplink","1"]` - the author opted this post into World
  uplink; a courier may uplink ONLY posts carrying exactly this tag. Absent tag =
  local-mesh-only and MUST NOT be uplinked by anyone. Any other `uplink` tag value →
  EVENT-2 rejects with BAD_SHAPE. (Rationale: the courier/deniability model - "whichever
  online mesh member relays it, not necessarily the author" - is unimplementable without a
  wire-visible, signed opt-in signal.)
- **Dependencies:** EVENT-6, EVENT-3, CRYPTO-1/2, FEED-4 (geohash validation). **Dependents:** FEED-3/5/6.
- **Errors:** `ValidationError(content)` (length/normalization), `SignError` (key unavailable).
- **Security:** private key never leaves CRYPTO-1; builder passes canonical bytes in.

#### EVENT-2 EventVerifier - `src/event/Verify.ts` - L3 - custom
- **Responsibility:** gatekeeper on EVERY ingest path (flood + sync + local build). Checks in order
  (cheap first): size ≤ 4 096 B → CBOR shape (8 positions, types) → kind ∈ {1,2,3} → geohash valid →
  `created_at` within [now−retention−skew, now+300 s] (ASSUMPTION clock skew) → content bounds (kind 1:
  1–280 chars; kinds 2/3: empty) → tags shape (any `uplink` tag must be exactly `["uplink","1"]`,
  else BAD_SHAPE) → id == sha256(canonical) → Ed25519 verify →
  policy: kind 3 requires `tombstone.pubkey == target.pubkey` (target lookup via STORE-2; unknown
  target → hold tombstone 10 min? ASSUMPTION: drop if target unknown after sync - simpler: store
  tombstone, apply when target arrives) → FEED-4 scope → dedup (STORE-2 `exists(id)`).
- **Interface:** `async function verify(raw: Uint8Array): Promise<VerifyOk | VerifyReject>` where
  `VerifyReject = {code: 'BAD_SHAPE'|'BAD_KIND'|'BAD_ID'|'BAD_SIG'|'FUTURE_TS'|'EXPIRED'|'OVERSIZE'|'OUT_OF_SCOPE'|'DUP'|'NOT_AUTHOR', detail?}`.
- **Dependencies:** EVENT-3/6, CRYPTO-2, STORE-2, FEED-4, OBS-2. **Dependents:** MESH-1/4/8, FEED-5.
- **Errors:** rejection is a VALUE, not a throw (hot path); throws only on internal bugs.
- **Testing:** TEST-3 adversarial corpus: bit-flipped sig, wrong id, future ts, oversize, bad geohash,
  forged tombstone (wrong pubkey) - all rejected with right code.
- **Perf:** verify budget ≤ 5 ms p99 on mid Android (Ed25519 verify ~1–2 ms via @noble/curves -
  ASSUMPTION; measure).

#### EVENT-3 CborCodec - `src/event/Cbor.ts` - L3 - cbor-x (certain) or custom
- **Responsibility:** `encode(SignedEvent) → Uint8Array` (8-position array), `decode(bytes) →
  unknown` (untrusted - returns unknown, EVENT-2 validates). Deterministic: fixed positions, no maps
  on the event path (maps only inside `tags` string arrays).
- **Interface:** `encodeEvent(e: SignedEvent): Uint8Array; decodeEvent(b: Uint8Array): unknown`.
- **OSS:** `cbor-x` (certain it exists; verify Metro/Hermes bundling) - fallback: hand-rolled minimal
  encoder for our fixed shape (custom, ~150 lines; deterministic by construction).
- **Testing:** byte-exact vectors in TEST-3; fuzz decode with random bytes (must not throw uncaught).

#### EVENT-4 Lz4Codec - `src/event/Lz4.ts` - L3 - per OSS research (verify)
- **Responsibility:** `compress(bytes) → {bytes, algo: 0|1}`; skip if input < 64 B (ASSUMPTION -
  LZ4 hurts tiny payloads); magic prefix `0x4C5A` on compressed payloads so MESH-4 can branch.
- **Interface:** `compress(b: Uint8Array): Uint8Array; decompress(b: Uint8Array): Uint8Array`.
- **OSS:** **per OSS research (verify):** `lz4js` (pure JS) for v1 - measure on 200–600 B payloads;
  if too slow, custom TurboModule wrapping LZ4 C (fast, tiny). Design isolates the choice here.
- **Errors:** decompress failure → `CorruptError` → frame dropped (MESH-4).

#### EVENT-5 EventBus - `src/event/Bus.ts` - L3 - custom (tiny)
- **Responsibility:** typed in-app pub/sub: `event:verified`, `event:stored`, `event:dropped{reason}`,
  `feed:updated`, `mesh:peer`, `scope:changed`. Synchronous dispatch, no persistence, no remote.
- **Interface:** `bus.emit<E extends EventName>(e: E, p: Payload[E]): void; bus.on<E>(e: E, cb): Unsub`.
- **Dependents:** FEED-1, UI-4, OBS-2. **Testing:** ordering test (stored before feed:updated).

#### EVENT-6 CanonicalSerializer - `src/event/Canonical.ts` - L3 - custom + @noble/hashes (certain)
- **Responsibility:** `canonical(e) → Uint8Array` = CBOR `[0, pubkey, created_at, kind, geohash, tags,
  content]`; `eventId(canonical) = sha256(canonical)`. THE consensus-critical function - byte-exact
  across platforms or signatures break.
- **Interface:** `canonicalBytes(unsigned): Uint8Array; eventId(unsigned): Uint8Array /* 32 B */`.
- **OSS:** `@noble/hashes` sha256 (certain).
- **Testing:** cross-implementation vector: fixed TEST-3 fixture must produce the exact 32-byte id
  committed in the fixture file (any drift = breaking change → PROTO_VER bump).

### 4.6 STORE - persistence

#### STORE-1 Database - `src/store/Db.ts` - L6 - op-sqlite (certain)
- **Responsibility:** single `open({name: 'airplane.db'})`; pragmas `journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON` (ASSUMPTION); `tx<T>(fn)` helper; `wipe()` for
  Settings "delete all".
- **Interface:** `db(): OpaqueDb; tx<T>(fn: (tx) => T): Promise<T>; wipe(): Promise<void>`.
- **Dependents:** STORE-2/3/4/5, OBS-1. **OSS:** `op-sqlite` (certain).
- **Errors:** open failure → APP-1 fatal; query errors → `DbError` with sanitized message (no SQL in
  user-visible strings).
- **Runtime:** JS thread calling native driver (JSI, sync-ish - keep queries small).

#### STORE-2 EventRepository - `src/store/Events.ts` - L6 - custom
- **Responsibility:** `insertEvent(e)` idempotent (`INSERT OR IGNORE` on id PK); `getEvent(id)`;
  `queryFeed(cells, {limit, cursorScore})` - joins events + view_counts, filters `deleted=0`,
  `expires_at > now`, orders by score desc; `insertReceipt` (writes events row + receipts row in tx;
  duplicate (pubkey,post,bucket) → counted once); `markDeleted`; `countViews(postId)` (distinct
  pubkeys); `hasReceipt(pubkey, postId, bucket)`.
- **Interface:** (see §6.5 for full TS).
- **Data:** owns `events`, `receipts`, `view_counts` tables (§6 DDL).
- **Errors:** constraint violation on id → treated as idempotent-ok (returns `inserted: false`);
  all else → `DbError`.
- **Testing:** idempotency (double insert), receipt 24 h dedup, tombstone LWW, expiry filter.
- **Perf:** `queryFeed` ≤ 200 ms p99 at 10 k events (indexes §6; ASSUMPTION target - measure).

#### STORE-3 PeerRepository - `src/store/Peers.ts` - L6 - custom
- **Responsibility:** `upsertPeer`, `markLost`, `getActivePeers`, sync cursors
  `getCursor/setCursor(peerId)`, MTU hints. Owns `peers`, `sync_state`.
- **Interface:** `upsertPeer(p: PeerInfo): void; getSyncCursor(peerId): UnixSec|null; …`.

#### STORE-4 MigrationRunner - `src/store/Migrations.ts` - L6 - custom
- **Responsibility:** ordered migrations `001_initial.sql …`; `PRAGMA user_version` gating;
  runs in tx; failure → throws (APP-1 fatal - a half-migrated DB is worse than no DB).
- **Testing:** migrate 1→N on fixture DBs; downgrade is NOT supported (documented).

#### STORE-5 FragmentBuffer - `src/store/Fragments.ts` - L6 - custom
- **Responsibility:** durable spillover for multi-fragment reassembly (MESH-4); `put/get/clear(tag)`;
  purged by STORE-7 after 60 s (ASSUMPTION) - fragments are transport-ephemeral.
- **Data:** owns `frag_buf`.

#### STORE-6 HotState - `src/store/Hot.ts` - L6 - react-native-mmkv (certain)
- **Responsibility:** typed MMKV wrapper: `lastGeohash`, `onboarded`, `powerMode`, `retentionH`,
  `draftPost`, `locale`, `theme`, config overrides, `lastBgRun`. Synchronous reads (MMKV is sync).
- **Interface:** `hot.get(k): T|null; hot.set(k, v): void` - typed keys.
- **OSS:** `react-native-mmkv` (certain) - **pinned v3.3.3** per unified v2 constants (v4.x deferred to P5).
- **Security:** no secrets in MMKV (keys live in secure store only).

#### STORE-7 RetentionJanitor - `src/store/Janitor.ts` - L6 - custom
- **Responsibility:** periodic (every 15 min + on boot - ASSUMPTION) purge: `events` where
  `expires_at < now`, `seen` older than 7 d, `frag_buf` older than 60 s, orphaned receipts;
  `VACUUM` if freed > 10 MB (ASSUMPTION). Runs in low-priority tx.
- **Dependencies:** STORE-1/2/5. **Testing:** insert expired fixtures → run → gone; live rows kept.

### 4.7 CRYPTO - keys / identity

> **v2 placement decision (worker 2, 2026-10-10):** identity/key custody lives in a NEW
> **`packages/crypto`** package, NOT inside `packages/protocol`. Rationale - dependency direction:
> `packages/protocol` is intentionally pure (no platform deps, no native modules; P1's 71 hermetic
> tests prove the value - it must stay runnable in CI/Jest without a keystore). `KeyStorePort`'s
> production implementation needs `expo-secure-store` (native Keychain/Keystore) and, for the relay
> key, a secp256k1 Schnorr signer. Putting either inside `protocol` would drag native/platform deps
> into the pure package and break hermetic testing. So: **pure crypto *operations*** (Ed25519/Schnorr
> sign/verify wrappers) stay in `protocol` (CRYPTO-2, testable); **key *custody*** (generation,
> secure storage, rotation, wipe) moves to `packages/crypto` (CRYPTO-1 implementing `KeyStorePort`).
> Direction: `apps/mobile` wires `crypto` → `protocol`; `protocol` never imports `crypto`. The P1
> `CryptoPort`-inside-`protocol` must be refactored accordingly before P2 (split ops from custody;
> no behavior change). This resolves audit P0 #5 (missing identity layer) at the design level.

#### CRYPTO-1 KeyManager - `packages/crypto/src/KeyStore.ts` - L5 - expo-secure-store (certain) + @noble/curves (certain) + @noble/secp256k1 or nostr-tools (see RELAY-5)
- **Responsibility:** the ONLY module that ever touches private key material. Two independent
  identities, generated on first launch:
  1. **Mesh identity - stable per-device Ed25519 keypair** (coordinator decision). Used for: signing
     posts/receipts/tombstones on the mesh; authorship continuity for tombstones (`tombstone.pubkey
     == post.pubkey` is enforceable only with a stable key - P1's throwaway-keypair-per-post made
     this meaningless); receipt dedup by stable viewer key.
  2. **Relay identity - separate secp256k1 keypair** (Nostr protocol requires secp256k1 Schnorr per
     BIP-340 - verified against NIP-01, 2026-10-10). Used ONLY for the outer Nostr envelope on
     relays. Generated independently; **unlinkable to the mesh key by default** (no binding
     published). Optional signed binding event (see below) for users who want continuity.
- **Interface - `KeyStorePort`** (the full seam; production impl wraps expo-secure-store; TEST-1
  uses an in-memory fake):
  ```ts
  interface KeyStorePort {
    // - mesh identity (Ed25519) -
    getOrCreateMeshKey(): Promise<{ publicKey: Uint8Array }>; // 32 B; generates on first launch
    getMeshPublicKey(): Promise<Uint8Array | null>;           // null = not yet created
    signMesh(canonical: Uint8Array): Promise<Uint8Array>;     // 64 B Ed25519; key never leaves
    rotateMeshKey(): Promise<{ oldPublicKey: Uint8Array; newPublicKey: Uint8Array }>;
    wipeMeshKey(): Promise<void>;
    // - relay identity (secp256k1, Nostr) -
    getOrCreateRelayKey(): Promise<{ publicKey: Uint8Array }>; // 32 B x-only (BIP-340)
    getRelayPublicKey(): Promise<Uint8Array | null>;
    signRelaySchnorr(id32: Uint8Array): Promise<Uint8Array>;  // 64 B BIP-340 Schnorr over event id
    rotateRelayKey(): Promise<{ oldPublicKey: Uint8Array; newPublicKey: Uint8Array }>;
    wipeRelayKey(): Promise<void>;
    // - panic -
    wipeAll(): Promise<void>;                                 // deletes BOTH keys; see §4.7 security
  }
  ```
- **Generation:** CSPRNG (`@noble/hashes` `randomBytes`, backed by `react-native-get-random-values`
  on device - already a stack requirement). Mesh key: Ed25519 seed → 32 B secret. Relay key:
  32 B secp256k1 secret, validated `< n` (retry on the ~2^-128 edge).
- **Storage:** expo-secure-store. iOS: Keychain; Android: Keystore (hardware-backed where available).
  Accessibility: `AFTER_FIRST_UNLOCK` (iOS) / unlocked-device-required (Android) so background
  relay runs (APP-5) can sign without the device being unlocked - **trade-off documented**:
  marginally weaker at-rest posture than `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, but required for the
  background coordinator. Keys are namespaced (`airplane.mesh.v1`, `airplane.relay.v1`); never in
  MMKV, SQLite, logs, or crash reports (OBS-1 lint rule covers this).
- **Rotation:** generates a fresh pair; the OLD private key is deleted (secure-store `deleteItem`);
  the OLD public key is appended to a `retired_pubkeys` list (MMKV - public, safe) so old posts
  remain verifiable. **Burn semantics (documented trade-off):** after rotation, posts signed by the
  old key can no longer be tombstoned by this device - rotation via Settings is a fresh pseudonym,
  and the Settings copy must say so. Rotation does NOT re-sign or migrate old content.
- **Wipe:** `wipeAll()` deletes both keys from secure storage, best-effort zeroes JS buffers
  (Hermes GC limits - documented limitation), clears `retired_pubkeys`, and emits
  `identity:wiped`. Panic-wipe path for the seizure scenario (threat-model work, P5; mechanism here).
- **Errors:** secure-store unavailable → `KeyError{op}` (APP-1 treats as fatal-before-mesh with an
  honest message - identity is required; read-only boot without keys is rejected, ASSUMPTION
  confirmed v2: anonymous-but-unidentified breaks tombstones/receipts).
- **Security boundary:** THE secret boundary of the app. Private key material never crosses this
  module's edge - callers pass bytes in, get signatures out (signing happens inside, on the JS
  thread; no native bridge round-trip of secrets).
- **Testing:** sign/verify round-trip (mesh + relay); rotate changes pubkey and retires old;
  persistence across restarts (fake store); wipe leaves no retrievable key; fake `KeyStorePort`
  used by ALL protocol tests so `packages/protocol` stays hermetic.
- **Perf:** sign ~1 ms (Ed25519, noble); secure-store read is cached in memory after first unlock
  (cache cleared on wipe/lock event).

**Identity trade-off (stated plainly for UI-6 copy):** a stable per-device key is a **linkable
pseudonym** - all posts by one key are linkable to each other by anyone (no PII is bound: no name,
phone, email exists in the app). What stability buys: tombstones work (author-only delete),
receipt dedup works, per-key rate limits work, and the world feed can attribute. The alternative
(per-post throwaway keys, P1's approach) buys unlinkability but makes authorship, deletion, and
abuse accounting meaningless. We chose stability with **user-controlled burn** (Settings → rotate =
new pseudonym, old authorship abandoned). The relay key is a *second* pseudonym, unlinkable to the
mesh key unless the user explicitly opts into a binding.

**Optional binding event (opt-in, Settings):** if the user wants continuity between their mesh
posts and their relay presence, CRYPTO-1 can emit an Ed25519-signed statement
`["airplane-bind", <relay-secp-pubkey-hex>, <created_at>]` published as a regular mesh post
(inner kind 1, tag `["bind", …]`) AND as the content of a Nostr kind-1 note from the relay key.
Verifiers can then prove "this relay key speaks for this mesh key". Default: OFF. Never automatic.

#### CRYPTO-2 Ed25519Ops - `src/crypto/Ed25519.ts` - L5 - @noble/curves (certain)
- **Responsibility:** pure `sign/verify` wrappers (constant-time where lib provides); used by
  EVENT-2 for verification (hot path) and CRYPTO-1 for signing.
- **Interface:** `edSign(priv: Uint8Array, msg: Uint8Array): Uint8Array; edVerify(sig, msg, pub): boolean`.

#### CRYPTO-3 PeerIdRotator - `src/crypto/PeerId.ts` - L5 - custom
- **Responsibility:** ephemeral BLE peer id: `peerId = HMAC_SHA256(epochKey, floor(now/900))[0:8]`
  hex; rotates every 15 min; epochKey random per install (MMKV - not the identity key; unlinkable
  to pubkey). MESH-5 re-advertises on rotation; connections survive rotation (peer tracked by
  connection handle, id refreshed via ID_CHAR read).
- **Interface:** `currentPeerId(): string; onRotate(cb): Unsub`.
- **Security:** rotation limits BLE-layer tracking; does NOT unlink signed events (documented in UI-6).

### 4.8 LOC - location / geohash scoping

#### LOC-1 LocationService - `src/loc/Location.ts` - cross-cutting - expo-location (certain)
- **Responsibility:** `getCurrentGeohash()` - single low-accuracy fix on scope refresh (foreground;
  `Accuracy.Low` - ASSUMPTION: ~1 km is fine for geohash-5), movement callback → FEED-4.
  Converts to geohash IMMEDIATELY; raw lat/lng never persisted, never logged.
- **Interface:** `currentGeohash(): Promise<string|null>; onMove(cb): Unsub`.
- **Errors:** denied/unavailable → null (FEED-4 falls back to last-known).
- **Privacy:** the strongest guarantee in the doc: coordinates exist only in a local variable.

#### LOC-2 GeohashUtil - `src/loc/Geohash.ts` - cross-cutting - ngeohash (certain)
- **Responsibility:** `encode(lat,lng,5)`, `neighbors(cell) → 8`, `valid(cell)`. Pure.
- **Testing:** known-answer vectors (including edge cells).

### 4.9 OBS - observability

#### OBS-1 Logger - `src/obs/Log.ts` - cross-cutting sink - custom
- **Responsibility:** structured ring buffer (1 000 entries - ASSUMPTION): `{ts, level, tag, msg,
  fields}`. Levels debug/info/warn/error. Persisted tail (200) to SQLite for post-crash inspection
  (ASSUMPTION). NEVER logs content bodies, pubkeys, peer ids, or locations (privacy rule enforced
  by allowlist of fields).
- **Interface:** `log.debug/info/warn/error(tag: string, msg: string, fields?: SafeFields): void`.
- **Dependents:** everyone (sink - depends on nothing).

#### OBS-2 MeshMetrics - `src/obs/Metrics.ts` - cross-cutting sink - custom
- **Responsibility:** counters: `tx_frames, rx_frames, dedup_drops, ttl_drops, scope_drops,
  verify_rejects{by_code}, peers_seen, peers_connected, sync_offers_in/out, receipts_emitted,
  battery_mode`. 1 Hz snapshot for UI-4; cumulative since boot (+ persisted daily totals? -
  ASSUMPTION: boot-only, no history).
- **Interface:** `metrics.incr(name, by=1): void; metrics.snapshot(): MeshSnapshot`.

#### OBS-3 CrashAdapter - `src/obs/Crash.ts` - cross-cutting - @sentry/react-native (certain)
- **Responsibility:** capture unhandled JS + native crashes; queue envelopes in app storage;
  upload-when-online (checks connectivity via expo-network - certain - before flush; offline-first
  means crashes may sit for days - documented). Scrub: no event content in breadcrumbs.
- **Interface:** `installCrashReporting(): void; capture(e: Error, ctx?): void`.

### 4.10 DIST - build / distribution

#### DIST-1 BuildPipeline - `eas.json` + `app.config.ts` - tooling - EAS (certain)
- **Responsibility:** build profiles: `dev` (dev-client, for Tuba's iteration), `sideload-apk`
  (release APK, no Play signing), `sideload-ipa` (ad-hoc/IPA for sideload - ASSUMPTION: Apple
  ad-hoc distribution limits apply; document). Version code from git tag.
- **Dependents:** DIST-2.

#### DIST-2 SideloadPackager - `scripts/package-sideload.sh` - tooling - custom
- **Responsibility:** takes build artifacts → `airplane-<ver>-<platform>.<ext>` + `.sha256` +
  `RELEASES.md` entry; verifies signature of artifact before publishing; output dir
  `dist/` (gitignored; published via GitHub Releases - manual step by Tuba).
- **Testing:** checksum round-trip; artifact presence assertions.

### 4.11 TEST - test doubles / simulators

#### TEST-1 SimulatorTransport - `test/sim/Transport.ts` - test - custom
- **Responsibility:** in-memory `IGattTransport` implementation: N virtual nodes, configurable
  topology (range matrix), latency/loss injection. Runs the REAL MESH-1…11 + EVENT stack per node -
  the highest-value test asset in the project.
- **Interface:** `class SimNet { addNode(graph): SimNode; setRange(a, b, rssi|null): void; run(ms): Promise<void> }`.
- **Testing:** convergence tests (all nodes get post ≤ TTL hops), partition healing, storm bounds.

#### TEST-2 BleFakes - `test/fakes/Ble.ts` - test - custom
- **Responsibility:** scripted `IBleAdapter` fake: canned scan results, connect success/failure
  scripts, MTU sequences, write capture. For MESH-5/6/7/10 unit tests.
- **Interface:** `class FakeBle implements IBleAdapter { script(...): void; written: CapturedWrite[] }`.

#### TEST-3 EventFixtures - `test/fixtures/Events.ts` - test - custom
- **Responsibility:** fixed test Ed25519 keypair (NON-secret, committed) + builders producing
  deterministic signed events with committed byte vectors (id/sig/CBOR hex). Adversarial corpus
  (bad sig, future ts, forged tombstone…).
- **Security:** fixture private key is labeled `TEST ONLY - never ship`; lint rule forbids import
  outside `test/` (ASSUMPTION enforcement).

#### TEST-4 FloodHarness - `test/harness/Flood.ts` - test - custom
- **Responsibility:** scenario runner on TEST-1: `storm(n=200, events=10)` asserts relay amplification
  ≤ TTL×N and no duplicates delivered to STORE-2; `churn` (peers join/leave); `scopeLeak` (event
  created 3 cells away never stored/relayed). CI gate: storm test must pass.
---

### 4.12 RELAY - nostr relay uplink/downlink (v2)

> Design stance: relays are **untrusted dumb pipes**. Our events are Ed25519-signed (mesh trust
> root); the Nostr envelope is standard NIP-01 so ANY existing relay software (strfry,
> nostr-rs-relay, nostream, khatru-based, …) works with zero Airplane-specific code on the relay.
> There is NO Airplane backend and NO Airplane-run relay - running our own relay would recreate the
> single takedown target the product exists to avoid. Authorship is proven by the INNER Ed25519
> signature; the outer Schnorr signature only proves which relay-key submitted the envelope.

#### RELAY-1 RelayClient - `src/relay/Client.ts` - L3.5 - custom + nostr-tools (see OSS_RESEARCH §7)
- **Responsibility:** session manager for Nostr relay connections (wss). Owns: connect/disconnect
  per directory relay, connection health, publish fanout (`EVENT` to N relays, collect `OK`s),
  subscription lifecycle (`REQ`/`CLOSE`, `EOSE` handling). Exposes `RelayPort` to FEED (see §6.7).
  Never touches MESH; works with MESH down (world feed works on pure internet).
- **Interface:** (see §6.7 `IRelayClient` for full TS).
- **Inputs/outputs:** In: wrapped Nostr events (from RELAY-2/5), REQ filters (from RELAY-3).
  Out: `OK` receipts, relay `EVENT` frames (→ RELAY-3), `NOTICE`s, health transitions (→ OBS-2, UI-4).
- **Dependencies:** RELAY-4 (relay list + per-relay policy), RELAY-5 (wire protocol), CRYPTO-1
  (relay key for signing - via `signRelaySchnorr`, key never exposed), OBS-1/2.
  **Dependents:** RELAY-2, RELAY-3, FEED-1 (via `RelayPort`).
- **State & lifecycle:** per-relay session state machine (`idle|connecting|open|backoff|disabled`);
  reconnect with exponential backoff 5 s → 5 min (ASSUMPTION); sessions die on app background
  (APP-3) and re-establish on foreground; no persistence of sockets.
- **Events:** emits `relay:connected{url}`, `relay:down{url,reason}`, `relay:publish_ok{id,url}`,
  `relay:notice{url,msg}` on EVENT-5.
- **Data:** reads `relay_health` (SQLite) for backoff history; writes per-relay counters.
- **Communication:** wss only; no HTTP except NIP-11 info fetch (optional, for UI display of relay
  name - best-effort).
- **Errors:** connect timeout 15 s → backoff; `OK:false` with `blocked:`/`rate-limited:` →
  recorded per relay, surfaced in Settings (relay transparency); auth-required (NIP-42) → relay
  marked `needs_auth`, skipped unless user enables AUTH (deferred - P3, see §7.5).
- **Security:** TLS (wss) required - `ws://` URLs rejected at RELAY-4 validation (no cleartext
  credentialless publishing; also avoids captive-portal injection); outer events are public by
  design, but transport privacy (who publishes when, from which IP) is a stated residual (Appendix E).
- **Runtime:** JS thread; one WebSocket per relay (≤ 6 concurrent, ASSUMPTION).
- **OSS:** `nostr-tools` (Unlicense; pure-JS path is Hermes-safe; explicit RN polyfill recipe in its
  README - see OSS_RESEARCH §7). Wrapped behind RELAY-5 so the lib is swappable.
- **Testing:** fake relay server (TEST harness): OK/notice/EOSE scripted; fanout test asserts
  publish reaches 2/3 relays with 1 failing; reconnect-backoff unit test.
- **Perf:** publish fanout resolves on first `OK` (≤ 3 s target) - remaining relays resolve in
  background; subscription backfill pages 200 events/REQ (ASSUMPTION).

#### RELAY-2 UplinkQueue - `src/relay/Uplink.ts` - L3.5 - custom
- **Responsibility:** the durable, **opt-in-only** outbox. FEED-5 enqueues a post here ONLY if the
  user toggled "share to World" at compose time (default OFF - coordinator decision; the toggle
  state is per-post, never a global "auto-uplink" switch in v1). Owns: persistence of queued
  wraps, connectivity gating (publish only when online), per-key client-side rate limiting,
  retry/backoff, tombstone priority (deletions jump the queue).
- **Interface:**
  ```ts
  interface IUplinkQueue {
    enqueue(inner: SignedEvent, opts: { viewsSnapshot: number }): Promise<void>; // called by FEED-5
    enqueueTombstone(inner: SignedEvent): Promise<void>;                          // priority lane
    pendingCount(): Promise<number>;
    drain(signal: AbortSignal): Promise<DrainReport>;                              // called by RELAY-1 when online
  }
  type DrainReport = { published: Hex64[]; failed: { id: Hex64; error: string }[]; rateLimited: boolean };
  ```
- **Inputs/outputs:** In: `SignedEvent` (already EVENT-2-verified locally) + mesh view-count
  snapshot. Out: wrapped Nostr events → RELAY-1 publish; queue rows deleted on `OK` from ≥1 relay.
- **Dependencies:** RELAY-5 (wrap), RELAY-1 (publish), RELAY-4 (per-relay publish policy),
  STORE-2 (`uplink_queue` table), OBS-1/2. **Dependents:** FEED-5, FEED-6 (tombstone path).
- **State & lifecycle:** SQLite `uplink_queue` (durable across restarts - a post opted-in on a Delhi
  metro with no signal must still uplink in Mumbai); rows expire with the post (`expires_at`).
- **Rate limiting (moderation mechanism, client-side, relay-agnostic):** before ANY relay publish,
  check `publish_count` for this relay-identity in the trailing 24 h (SQLite counter); if ≥
  `UPLINK_RATE_PER_DAY` (50), the drain stops with `rateLimited: true` and the UI shows
  "daily world-share limit reached". This is enforced in OUR code so it holds on every relay,
  including relays with no rate limits of their own. (Mesh-side per-key limits are MESH-2/worker-1.)
- **Errors:** `OK:false` → row stays, `attempts++`, `next_retry_at = now + backoff(attempts)`
  (60 s → 10 min → 1 h, capped; ASSUMPTION); attempts > 10 → row dropped + `uplink:dead` event
  (ASSUMPTION). Queue full (> 500 rows, ASSUMPTION) → oldest non-tombstone rows dropped first.
- **Security:** enqueue requires the local user's own key (FEED-5 passes only own posts); a
  compromised FEED could enqueue others' posts - but relays would store them anyway once published
  by anyone (public data; the harm model is spam, covered by rate limits + the opt-in gate).
- **Testing:** offline enqueue → online drain (fake RELAY-1); rate-limit trip at 51st publish;
  tombstone priority ordering; expiry purge.
- **Perf:** drain is batched (≤ 10 concurrent publishes, ASSUMPTION); queue ops are single-row SQLite.

#### RELAY-3 DownlinkSync - `src/relay/Downlink.ts` - L3.5 - custom
- **Responsibility:** populates the World feed. Owns: long-lived `REQ` subscriptions
  (`{kinds:[1919,5], '#g': [...], since: cursor}`), periodic backfill when online
  (every `DOWNLINK_POLL_MIN`), unwrap → inner CBOR → **full EVENT-2 verify** → STORE-2 insert
  (dedup by inner id - a post arriving via both mesh and relay inserts once), per-relay cursors.
- **Interface:**
  ```ts
  interface IDownlinkSync {
    start(): Promise<void>;   // opens subscriptions on all enabled relays
    stop(): Promise<void>;
    backfillNow(): Promise<BackfillReport>;
    setGeoFilter(cells: string[]): Promise<void>; // drives '#g' filter from FEED-4 scope
  }
  ```
- **Inputs/outputs:** In: raw Nostr events from RELAY-1. Out: verified `SignedEvent`s → STORE-2
  (marked `source='world'`), world-feed updates → FEED-1.
- **Dependencies:** RELAY-1 (subscribe), RELAY-5 (unwrap), EVENT-2 (verify - SAME gatekeeper as
  mesh; no second trust path), STORE-2, FEED-4 (geo filter cells), moderation store (§6.7:
  `muted_keys` block-check BEFORE verify to save CPU on known-bad keys - blocklist is local).
  **Dependents:** FEED-1 (world feed query).
- **State:** per-relay cursor `{since: UnixSec, lastId: Hex64}` in MMKV (STORE-6); subscriptions
  keyed by sub-id.
- **Filtering:** `#g` tag filter = current cell + neighbors (same 9-cell ring as mesh) by default;
  user can widen to "world" (no `#g` filter) in Settings - explicit choice, default is scoped
  (prevents the world feed from becoming a global firehose on first open).
- **Kind 5 handling:** a valid kind-5 (NIP-09) from relay-key X referencing wrapped post Y →
  resolve Y's inner event → apply inner tombstone rules (authorship: inner tombstone pubkey MUST
  equal post pubkey; the OUTER relay keys need not match - relay keys are throwaway by design).
  Applied tombstones hide the post in BOTH feeds. Relay non-compliance is expected (deletion is a
  request); our local application is the guarantee.
- **View receipts:** NEVER fetched or stored from relays (coordinator decision). Ranking uses the
  `views_snapshot` carried in the wrap (see §7.1) - labeled approximate in UI.
- **Errors:** malformed outer event (bad Schnorr) → drop + counter (relays are untrusted; garbage
  is expected); inner verify failure → drop with `VerifyReject` code (same codes as mesh);
  cursor corruption → reset to `now - 24h` and re-backfill (ASSUMPTION).
- **Security:** downlink is the abuse ingress - see §7.5 moderation hooks (blocklist pre-filter,
  per-relay policy, keyword filters at FEED-1).
- **Testing:** scripted relay serving wrapped fixtures (valid, bad-outer-sig, bad-inner-sig,
  kind-5, unknown-kind): only valid + kind-5-applied land in STORE-2; mesh/relay dedup test.
- **Perf:** backfill page 200/REQ; unwrap+verify ≤ 5 ms/event (same budget as EVENT-2).

#### RELAY-4 RelayDirectory - `src/relay/Directory.ts` - L3.5 - custom
- **Responsibility:** the user-editable relay list + per-relay policy. Owns: default list,
  add/remove/enable/disable, URL validation, per-relay publish/subscribe policy, health counters.
  This is the anti-takedown mechanism: there is NO single hardcoded relay - the app ships with
  several independent defaults, the user can add any relay (including their own), and a relay
  disappearing is a Settings event, not an outage.
- **Interface:** (see §6.7 `IRelayDirectory`).
- **Default list (verified 2026-10-10 - each recently probed clean by third-party clients; re-verify
  at build time, relay quality drifts):**
  | URL | Why default |
  |---|---|
  | `wss://nos.lol` | developer-friendly, clean in 2026 field tests (nvpn, flock) |
  | `wss://relay.primal.net` | large operator, clean in 2026 field tests |
  | `wss://nostr.mom` | probed clean 2026-09 (flock e2e relay tests) |
  | `wss://purplerelay.com` | clean in 2026 field tests |
  Deliberately NOT default: `wss://relay.damus.io` (rate-limits aggressive publishers - fine as a
  user-added relay, bad as a default for a broadcast app); `wss://nostr.wine` (paid, 403s);
  `wss://relay.snort.social` (intermittent 504s); `wss://relay.nostr.band` (flaky in 2026 probes).
  Shipping 4 independent operators' relays means no one operator is a single point of failure or
  censorship.
- **Per-relay policy** (`RelayPolicy`, stored with the directory entry):
  ```ts
  interface RelayPolicy {
    url: string; enabled: boolean;
    publish: boolean;            // may we EVENT to this relay
    subscribe: boolean;          // may we REQ from this relay
    maxPublishesPerDay: number;  // default = UPLINK_RATE_PER_DAY; 0 = never publish
    allowKinds: number[];        // default [1919, 5]; adapter refuses anything else
    denyPatterns: string[];      // per-relay keyword deny list (moderation hook, §7.5)
  }
  ```
- **Persistence:** directory entries in MMKV (STORE-6, user settings); health counters
  (`connects`, `publish_ok`, `publish_rejected`, `last_error`) in SQLite `relay_health`.
- **URL validation:** must parse as `wss://` (reject `ws://`, http(s), onion without Tor - Tor is
  deferred, P5+); hostname allowlist is NOT enforced (anyone's relay is the point).
- **NIP-65 note (deferred):** relay-list events (kind 10002) are the protocol-native way to
  discover relays; v1 uses the local directory only. NIP-65 read support is a P3 candidate -
  named here so nobody reinvents it.
- **Errors:** invalid URL → `VALIDATION` error at add-time (never stored); all relays disabled →
  world feed shows honest empty state ("no relays configured").
- **Testing:** add/remove/persist round-trip; `ws://` rejected; policy enforcement (publish to a
  `publish:false` relay is refused by RELAY-5 without touching the network).

#### RELAY-5 NostrAdapter - `src/relay/NostrAdapter.ts` - L3.5 - custom + nostr-tools (Unlicense)
- **Responsibility:** the ONLY module that speaks Nostr wire protocol. Owns: wrap
  (`SignedEvent` → NIP-01 event), unwrap (NIP-01 → `SignedEvent`), the wss message machine
  (`EVENT`/`REQ`/`CLOSE` out; `EVENT`/`OK`/`EOSE`/`CLOSED`/`NOTICE` in), Schnorr sign/verify via
  CRYPTO-1's relay key. RELAY-1 calls this; nobody else touches Nostr bytes.
- **Interface:**
  ```ts
  interface INostrAdapter {
    wrapPost(inner: SignedEvent, viewsSnapshot: number): Promise<NostrEvent>; // kind 1919
    wrapTombstone(inner: SignedEvent, targetNostrId: Hex64): Promise<NostrEvent>; // kind 5
    unwrap(ev: NostrEvent): Promise<{ ok: true; inner: SignedEvent } | { ok: false; code: UnwrapCode }>;
    // - wire machine (used by RELAY-1) -
    encodeClientMessage(m: ClientMessage): string;
    decodeRelayMessage(raw: string): RelayMessage; // throws MalformedMessage (counted, not fatal)
  }
  type UnwrapCode = 'BAD_OUTER_SIG'|'BAD_SHAPE'|'UNSUPPORTED_KIND'|'BAD_ENCODING'|'POLICY_DENY';
  ```
- **Wrap spec (normative - see §7.1 for the full field mapping):** inner event → CBOR (EVENT-3) →
  base64 → Nostr `content`; `kind: 1919`; tags `[["g", geohash5], ["client","airplane"], ["v","1"]]`;
  outer `pubkey` = relay secp256k1 x-only key; outer `id`/`sig` = standard NIP-01 Schnorr.
  Tombstones → kind 5 with `e` tag = target wrapped post's Nostr id + `k` tag `1919` (NIP-09),
  content = base64(inner tombstone CBOR).
- **Unwrap spec:** verify outer Schnorr (cheap reject of garbage) → check kind ∈ policy.allowKinds
  → base64-decode content → CBOR decode → return inner `SignedEvent` bytes for EVENT-2
  (adapter does NOT verify the inner signature - EVENT-2 owns that; separation of concerns).
- **Policy enforcement (moderation hook):** before wrapping, check RELAY-4 `allowKinds` and
  `denyPatterns` (keyword scan of post content - substring, NFC-normalized, lowercase); violation
  → `POLICY_DENY`, never hits the network. This is client-side and relay-agnostic.
- **OSS:** `nostr-tools` v2.x (Unlicense - public domain; compatible with Apache-2.0) for event
  serialization/signing helpers and the relay message types; used ONLY through this adapter
  (swappable). Pure-JS entrypoint - do NOT use `nostr-tools/wasm` (no WebAssembly on React
  Native/Hermes - stated in the lib's own README). RN needs the documented polyfills
  (`react-native-get-random-values`, `text-encoding-polyfill`, `react-native-url-polyfill`).
  Fallback: hand-rolled ~150-line NIP-01 codec (the wire format is JSON arrays - trivially
  reimplementable) + `@noble/secp256k1` for Schnorr; the adapter interface doesn't change.
- **Testing:** wrap→unwrap round-trip incl. 280-char multibyte content; NIP-01 test vector
  (fixed relay key → exact expected id/sig - guards against Schnorr lib drift); malformed relay
  messages fuzzed (never throws uncaught); policy-deny unit tests.
- **Perf:** wrap ≤ 2 ms; Schnorr sign ~1 ms (noble).
---

## 5. Data ownership & state model

### 5.1 Entity catalog

| Entity | Kind | Owner (writer) | Readers | Lifecycle |
|---|---|---|---|---|
| Post event (kind 1) | **persistent** (SQLite `events`) | EVENT-1 creates (local); MESH-8/EVENT-2 ingest (remote) - append-only, never updated in place | FEED-1, STORE-2 | `created_at → expires_at` (retention), then purged |
| ViewReceipt event (kind 2) | **persistent** (`events` + `receipts`) | EVENT-1 (FEED-3 triggers); remote via mesh | FEED-2, STORE-2 | same TTL as posts; counted once per (pubkey, post, day) |
| Tombstone (kind 3) | **persistent** (`events`, `deleted=1` on target) | EVENT-1 (FEED-6); author-only | FEED-1 (filter), STORE-2 | LWW by `created_at`; tombstone row kept ≥ target |
| Peer | **persistent** (`peers`) | MESH-5 (upsert), MESH-6 (state) | MESH-6/8/10, UI-4 | `last_seen`; pruned after 7 d inactive (ASSUMPTION) |
| SeenCache entry | **ephemeral + spillover** (memory LRU + `seen` table) | MESH-2 | MESH-2/4 | 7 d spillover, then purged; loss only risks re-relay (safe) |
| SyncState (per-peer cursor) | **persistent** (`sync_state`) | MESH-8 | MESH-8 | per peer_id; cleared on peer prune |
| Fragment buffer | **ephemeral** (`frag_buf`) | MESH-4 | MESH-4 | 60 s TTL, then purged |
| `view_counts` | **derived cache** (recomputable from `receipts`) | STORE-2 (maintained in tx) | FEED-1/2 | rebuilt by `RECOMPUTE` on migration |
| Feed ranking | **derived** (in-memory, FEED-1) | FEED-1 + FEED-2 | UI | rebuilt on boot/scope change |
| Hot state (MMKV) | **persistent, non-relational** | STORE-6 writers (various) | various | survives upgrades; wiped by "delete all" |
| Identity keypair | **persistent, secure** (Keychain/Keystore) | CRYPTO-1 | CRYPTO-1/2 (sign only) | device lifetime; rotation creates new (old kept for verify) |
| Rotating peer id | **ephemeral** (memory + MMKV epoch key) | CRYPTO-3 | MESH-5 | 15-min epochs |
| Logs / metrics | **ephemeral** (ring buffers) | OBS-1/2 | UI-4, OBS-3 | 1 000 / boot-lifetime |
| Draft post | **ephemeral** (MMKV) | UI-2 | UI-2 | until submitted/discarded |
| World post (kind 1919) | **persistent** (SQLite `events`, `source='world'`) | RELAY-3 ingests (remote) - append-only | FEED-1 (world feed), STORE-2 | `created_at → expires_at` (same retention as mesh) |
| UplinkQueue row | **persistent** (`uplink_queue`) | RELAY-2 (enqueue), RELAY-1 (delete on OK) | RELAY-2 | until published, expired, or attempts exhausted |
| Muted key | **persistent** (`muted_keys`) | UI (Settings - worker 1 owns UX) | EVENT-2, RELAY-3 (block path), FEED-1 (mute path) | until user unmutes |
| Keyword filter | **persistent** (`keyword_filters`) | UI (Settings - worker 1 owns UX) | FEED-1 (both feeds), RELAY-5 (uplink policy) | until removed/disabled |
| Relay directory entry | **persistent** (MMKV) | RELAY-4 (user edits) | RELAY-1/2/3/5 | until removed |
| Relay health counters | **persistent** (`relay_health`) | RELAY-1 | RELAY-4 (UI display) | rolling 30 d window (ASSUMPTION) |
| Publish rate counters | **ephemeral-ish** (SQLite, 24 h window) | RELAY-2 | RELAY-2 | trailing 24 h |

### 5.2 Mutation rules (who may mutate what)

1. **Events are immutable.** No `UPDATE` on `events` except the `deleted` flag via tombstone
   application - and even that is append-driven (the tombstone row is the write; the flag is a
   materialized view of it, recomputed on demand).
2. **Only the author mutates their post's visibility** - via a signed tombstone whose pubkey must
   equal the target's pubkey (EVENT-2 enforces; relays cannot forge).
3. **Receipts are write-once per (pubkey, post, day_bucket)** - enforced by PK; duplicates are
   idempotent no-ops, never errors.
4. **Mesh never mutates event bytes** - MESH-2/3/4/8 forward opaque bytes; any byte change breaks the
   id/sig and EVENT-2 rejects downstream. This is the integrity backbone of relay-by-strangers.
5. **Derived state has exactly one writer**: `view_counts` ← STORE-2; ranking ← FEED-1; metrics ←
   OBS-2. Readers never write through.
6. **Cross-layer writes go through the owning repository interface** - e.g. MESH may not SQL-write
   `events`; it calls STORE-2. (Enforced by code review + lint on imports; ASSUMPTION.)
7. **RELAY never writes mesh state and MESH never writes relay state.** The only shared table is
   `events` (both transports insert the same content-addressed rows; dedup by inner id makes the
   two paths converge). `source` is set by whichever path ingested first and never rewritten.
8. **Uplink is append to the queue, never direct publish.** FEED-5/6 enqueue; only RELAY-2 drains.
   This is what makes the opt-in gate and the client-side rate limit unbypassable in-process.
9. **Mute/block lists are local-only, never synced.** They live in SQLite, are never wrapped,
   never published, never leave the device. A mute is a private act.

### 5.3 Consistency model

**Append-only log + LWW tombstones. No CRDTs (deferred per product spec).** Consequences, stated honestly:

- Two devices can disagree transiently (partition) - convergence is eventual via MESH-8 sync.
- Deletes are last-writer-wins on `created_at`; a tombstone arriving before its target is stored and
  applied on target arrival (no ordering assumption on the flood).
- View counts are monotonic per (pubkey, post, day) - no decrements, no conflicts possible.
- There is no global ordering of posts; ranking is a local pure function of (views, age) -
  two devices with the same event set compute the same order (deterministic tiebreak: `id` asc).
- Clock skew: accept `created_at` up to +300 s future (ASSUMPTION); beyond that, reject (prevents
  rank gaming by future-dating).

### 5.4 Migrations

STORE-4 owns `PRAGMA user_version`-gated ordered migrations. Rules: additive only in v1.x
(new tables/columns/indexes); destructive changes require a major version + documented export path;
`view_counts` is always recomputed after migration (it's derived). Downgrades unsupported.

### 5.5 Retention (TTL-based expiry)

- Default post lifetime: `expires_at = created_at + retentionH*3600`, default 24 h (APP-4 override:
  6/12/24/48). Receipts and tombstones share the target post's lifetime (tombstone kept ≥ target so
  late-arriving copies of the post are still suppressed - ASSUMPTION).
- STORE-7 purges expired rows every 15 min and on boot. Expired = invisible AND unrelayed
  (MESH-2 checks `expires_at` before rebroadcast - do not relay the dead).
- `seen` spillover: 7 d. `peers`: 7 d inactive. `frag_buf`: 60 s. MMKV: no TTL except draft (7 d -
  ASSUMPTION).

### 5.6 Privacy model (no PII stored)

- **Stored identity = Ed25519 pubkey only.** No name, phone, email - none exist in the app.
- **Location: geohash-5 on events; raw coordinates never persisted, never logged** (LOC-1 converts
  and drops). Geohash-5 is ~5 km precision - coarse by design.
- **Keys in Keychain/Keystore only** (CRYPTO-1). Never in MMKV, SQLite, logs, or crash reports.
- **BLE layer:** rotating peer ids (CRYPTO-3), no device name in advertisements, no pubkey on the
  radio. Linkability residual: signed events by one key are linkable *by content graph* (unavoidable
  for dedup/tombstones - disclosed in UI-6 onboarding copy).
- **Threat note (honest):** BLE transport is unauthenticated - anyone in radio range can read posts
  (they're public by design), observe peer-id rotations via timing/RSSI, and inject invalid frames
  (rejected by EVENT-2; costs them battery, not us integrity). Traffic analysis (who publishes when)
  is NOT mitigated in v1 - documented, not hand-waved.
- **Relay path (v2):** the relay identity is a SEPARATE secp256k1 keypair, unlinkable to the mesh
  Ed25519 key by default (§4.7) - a relay operator (or relay-data observer) cannot trivially join
  your mesh posts to your relay presence unless you opt into the binding event. Residuals, stated:
  relays see publish timing + source IP (no Tor in v1); uplinked posts carry origin geohash-5
  (public by design); raw view receipts NEVER uplink (only the count snapshot tag); mute/block
  lists never leave the device. All relay traffic is `wss://` only - cleartext `ws://` rejected.
---

## 6. Internal API contracts

### 6.1 UI ↔ FEED - owner: FEED-1 `IFeedStore`

Consumers: UI-1, UI-2, UI-3, APP-2. UI never touches EVENT/MESH/STORE directly.

```ts
interface IFeedStore {
  subscribe(cb: (posts: FeedPost[]) => void): () => void;
  getSnapshot(): FeedPost[];
  getPost(id: Hex64): FeedPost | null;
  refreshScope(): Promise<void>;
  submitPost(draft: string): Promise<Hex64>;          // delegates to FEED-5
  deletePost(id: Hex64): Promise<void>;               // delegates to FEED-6
  reportImpression(id: Hex64, visibleMs: number): void; // delegates to FEED-3
}
type FeedError =
  | { code: 'VALIDATION'; field: 'content'; reason: 'EMPTY'|'TOO_LONG' }
  | { code: 'NOT_FOUND'; id: Hex64 }
  | { code: 'NOT_AUTHOR' }
  | { code: 'MESH_DOWN' }        // submit queued, not failed
  | { code: 'STORE'; detail: string };
```

- **Validation:** content 1–280 chars (NFC-normalized, trimmed); id must be 64-char hex.
- **Timeouts/cancellation:** `submitPost` resolves on local sign+store (≤ 5 s) - relay is async and
  unacknowledged (no network → no delivery receipts; UI copy says "relaying…"). `refreshScope`
  ≤ 3 s. No cancellation (operations are local and fast).
- **Versioning:** `IFeedStore` is v1; additive methods only. `FeedPost` gains optional fields only.
- **Observability:** `feed:updated` (count, top score), `feed:submit{queued: bool}`, `feed:stale`.

### 6.2 FEED ↔ EVENT - owners: EVENT-1 `IEventBuilder`, EVENT-2 `verify()`

Consumers: FEED-3, FEED-5, FEED-6 (build); MESH-1/4/8 (verify).

```ts
interface IEventBuilder {
  buildPost(content: string, geohash: string): Promise<SignedEvent>;
  buildReceipt(postId: Hex64): Promise<SignedEvent>;
  buildTombstone(postId: Hex64): Promise<SignedEvent>;
}
type BuildError =
  | { code: 'VALIDATION'; reason: 'EMPTY'|'TOO_LONG'|'BAD_GEOHASH'|'UNKNOWN_POST'|'NOT_AUTHOR' }
  | { code: 'SIGN'; reason: 'KEY_UNAVAILABLE' };

async function verify(raw: Uint8Array): Promise<
  | { ok: true; event: SignedEvent }
  | { ok: false; code: 'BAD_SHAPE'|'BAD_KIND'|'BAD_ID'|'BAD_SIG'|'FUTURE_TS'|'EXPIRED'
      | 'OVERSIZE'|'OUT_OF_SCOPE'|'DUP'|'NOT_AUTHOR'; detail?: string }
>;
```

- **Validation (EVENT-2 order, cheap→expensive):** byte length ≤ 4096 → CBOR 8-array shape → kind ∈
  {1,2,3} → geohash matches `^[0-9a-z]{5}$` → `created_at ∈ [now−retention−60, now+300]` →
  content bounds (kind 1: 1–280 chars; 2/3: empty) → tags shape → `id == sha256(canonical)` →
  `ed25519.verify` → tombstone authorship → scope → dedup.
- **Timeouts:** verify is synchronous CPU work, budget ≤ 5 ms p99; no cancellation (atomic).
- **Versioning:** event schema v1; `kind` registry is append-only (new kinds ignored by old builds -
  forward-compat rule: unknown kind → `BAD_KIND` drop, never crash). `PROTO_VER` bump on any
  canonical-byte change.
- **Observability:** `verify_rejects{code}` counter per code; `event:verified{kind}`.

### 6.3 EVENT ↔ MESH - owner: MESH-1 `IMeshEngine`

Consumers: FEED-3 (receipts), FEED-5 (posts), FEED-6 (tombstones) via `publish`; MESH-4 inbound.

```ts
interface IMeshEngine {
  readonly ready: boolean;
  readonly mode: 'active' | 'degraded' | 'off';
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(event: SignedEvent): Promise<void>;   // sign already done; fragments + floods, TTL=7
  onMeshEvent(cb: (e: MeshEvent) => void): () => void;
}
type MeshEvent =
  | { type: 'peer'; peers: number }
  | { type: 'mode'; mode: 'active'|'degraded'|'off' }
  | { type: 'publish_queued'; id: Hex64 };
type MeshError = { code: 'BLE_OFF'|'PERMISSION'|'ALREADY_STARTED'|'START_FAILED'; detail?: string };
```

- **Validation:** `publish` accepts only locally-built `SignedEvent` (re-verified cheaply: id check -
  defense against FEED bugs, not trust).
- **Timeouts/cancellation:** `publish` resolves when frames are queued to MESH-11 (≤ 1 s), NOT when
  delivered (delivery is unknowable offline). `start()` ≤ 15 s or `START_FAILED`.
- **Versioning:** frame-type registry (`0x01/0x02/0x03/0x04`) append-only; unknown frame types dropped
  with counter.
- **Observability:** `tx_frames`, `rx_frames`, `peers_connected`, `publish_queued`.

### 6.4 MESH ↔ native BLE - owner: MESH-12 `IBleAdapter` (v1)

Consumers: MESH-5, MESH-6, MESH-7, MESH-10. Implemented by: native TurboModule (prod), TEST-2
(scripted fake). **This is the seam that makes the radio testable.**

```ts
interface IBleAdapter {
  readonly ADAPTER_VERSION: 1;
  getState(): Promise<'poweredOn'|'poweredOff'|'unauthorized'|'unsupported'>;
  startAdvertising(opts: { serviceUuid: string; peerId: string; connectable: true }): Promise<void>;
  stopAdvertising(): Promise<void>;
  startScan(opts: { serviceUuids: string[] }): Promise<void>;
  stopScan(): Promise<void>;
  onAdvertisement(cb: (a: { peerId: string; rssi: number; }) => void): () => void;
  connect(peerId: string, opts?: { timeoutMs?: number }): Promise<ConnHandle>;
  disconnect(handle: ConnHandle): Promise<void>;
  discoverService(handle: ConnHandle, serviceUuid: string): Promise<void>;
  subscribe(handle: ConnHandle, charUuid: string, cb: (bytes: Uint8Array) => void): Promise<void>;
  write(handle: ConnHandle, charUuid: string, bytes: Uint8Array): Promise<void>; // without response
  read(handle: ConnHandle, charUuid: string): Promise<Uint8Array>;
  requestMtu(handle: ConnHandle, mtu: 517): Promise<number>;  // android; ios resolves max write len
  onMtuChanged(cb: (handle: ConnHandle, mtu: number) => void): () => void;
  maxWriteLength(handle: ConnHandle): Promise<number>;        // ios maximumWriteValueLength
  onDisconnect(cb: (handle: ConnHandle, reason: string) => void): () => void;
}
type BleError = { code: 'BLE_OFF'|'UNAUTHORIZED'|'TIMEOUT'|'GATT_ERROR'|'BUSY'|'NOT_FOUND';
                  detail?: string; gattStatus?: number };
```

- **Validation:** native re-checks powered-on + permission on every call; `write` rejects > current
  MTU−3 (JS must chunk via MESH-10 - native never fragments silently).
- **Timeouts:** connect 10 s, write 5 s, read 5 s, requestMtu 5 s (ASSUMPTION); all abort the JS
  promise with `TIMEOUT`.
- **Versioning:** `ADAPTER_VERSION` checked at MESH-1 start; mismatch → `START_FAILED` with honest
  message (forces native+JS lockstep in dev builds).
- **Observability:** per-op latency histogram (debug), `ble:error{code}` counters.

### 6.5 EVENT ↔ STORE - owners: STORE-2 `IEventRepository`, STORE-3 `IPeerRepository`

Consumers: EVENT-2 (dedup/exists), FEED-1/2/3/5/6, MESH-2/8, STORE-7.

```ts
interface IEventRepository {
  insert(event: SignedEvent): Promise<{ inserted: boolean }>; // INSERT OR IGNORE; false = dup
  get(id: Hex64): Promise<SignedEvent | null>;
  exists(id: Hex64): Promise<boolean>;
  queryFeed(cells: string[], now: UnixSec, limit: number, cursor?: { score: number; id: Hex64 })
    : Promise<FeedPost[]>;
  insertReceipt(r: SignedEvent): Promise<{ counted: boolean }>; // PK (pubkey,post,bucket)
  hasReceipt(pubkey: Hex64, postId: Hex64, bucket: number): Promise<boolean>;
  countViews(postId: Hex64): Promise<number>;
  applyTombstone(t: SignedEvent): Promise<{ applied: boolean }>; // LWW check inside tx
  pruneExpired(now: UnixSec): Promise<number>;
  inventoryNewest(cells: string[], n: number): Promise<{ tag: Uint8Array /*8B*/; created_at: UnixSec }[]>;
  eventsSince(cells: string[], since: UnixSec, limit: number): Promise<SignedEvent[]>;
}
interface IPeerRepository {
  upsertPeer(p: PeerInfo): Promise<void>;
  markLost(peerId: string): Promise<void>;
  activePeers(): Promise<PeerInfo[]>;
  getCursor(peerId: string): Promise<UnixSec | null>;
  setCursor(peerId: string, ts: UnixSec): Promise<void>;
  setMtuHint(peerId: string, mtu: number): Promise<void>;
}
```

- **Validation:** repository trusts EVENT-2 (ingest path always verifies first); still enforces
  NOT NULL / PK / FK-ish constraints defensively.
- **Timeouts:** `queryFeed` ≤ 200 ms p99 target (ASSUMPTION - measure on device); writes are
  fire-and-forget-safe (WAL).
- **Versioning:** repository interfaces v1; schema changes via STORE-4 migrations, never interface
  drift.
- **Observability:** `db:write{op}`, `db:query_ms{op}` (p50/p99 in debug), `db:pruned{n}`.

### 6.6 APP ↔ OBS - owners: OBS-1 `Logger`, OBS-2 `MeshMetrics`, OBS-3 `CrashAdapter`

Consumers: every node (sink - OBS depends on nothing).

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface ILogger {
  log(level: LogLevel, tag: string, msg: string, fields?: Record<string, string | number | boolean>): void;
}
interface IMetrics {
  incr(name: MetricName, by?: number): void;
  gauge(name: GaugeName, value: number): void;
  snapshot(): MeshSnapshot;
}
function installCrashReporting(): void;
function captureException(e: Error, ctx?: Record<string, string>): void;
```

- **Validation (privacy-critical):** `fields` values are primitives only; a lint rule + code review
  forbid logging `content`, `pubkey`, `peerId`, coordinates. Violation = P0 bug.
- **Timeouts:** all calls are non-blocking (ring buffer / in-memory counters); crash upload is
  best-effort background.
- **Versioning:** additive metric/log tags; never rename a metric without updating UI-4 + dashboards.
- **Crash upload policy:** queue to app storage; flush only when `expo-network` reports connectivity;
  offline-first means reports may be days stale - accepted and documented.

### 6.7 FEED ↔ RELAY - owners: RELAY-1 `IRelayClient`, RELAY-4 `IRelayDirectory`

Consumers: FEED-1 (world feed), FEED-5 (opt-in enqueue), FEED-6 (tombstone uplink), UI-5 (relay
settings). FEED never touches Nostr bytes - everything goes through these interfaces.

```ts
interface IRelayClient {
  readonly status: Signal<Record<string, RelayConnState>>; // url -> idle|connecting|open|backoff|disabled
  publishWrapped(wrapped: NostrEvent): Promise<PublishReport>;
  subscribe(filter: NostrFilter, cb: (ev: NostrEvent) => void): () => void; // returns unsub (CLOSE)
  backfill(filter: NostrFilter, limit: number): Promise<NostrEvent[]>;      // one-shot REQ until EOSE
}
type PublishReport = { id: Hex64; perRelay: { url: string; ok: boolean; message?: string }[] };
type RelayConnState = 'idle'|'connecting'|'open'|'backoff'|'disabled';
interface NostrEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string; }
interface NostrFilter { kinds?: number[]; '#g'?: string[]; '#e'?: string[]; since?: number; until?: number; limit?: number; }

interface IRelayDirectory {
  list(): RelayEntry[];                                   // from MMKV; includes defaults on first run
  add(url: string): Promise<RelayEntry>;                  // validates wss://, rejects duplicates
  remove(url: string): Promise<void>;
  setEnabled(url: string, enabled: boolean): Promise<void>;
  setPolicy(url: string, patch: Partial<RelayPolicy>): Promise<void>; // §4.12 RELAY-4
  health(url: string): Promise<RelayHealth>;              // counters from relay_health
}
interface RelayEntry { url: string; enabled: boolean; policy: RelayPolicy; addedAt: UnixSec; builtin: boolean; }
interface RelayHealth { connects: number; publishOk: number; publishRejected: number; lastError: string | null; lastSeen: UnixSec | null; }

// Moderation data model (owned by STORE-2; written by UI-5, read by EVENT-2 / RELAY-3 / FEED-1)
interface IModerationStore {
  muteKey(pubkey: Uint8Array, action: 'mute'|'block', scope: 'mesh'|'world'|'both'): Promise<void>;
  unmuteKey(pubkey: Uint8Array): Promise<void>;
  isBlocked(pubkey: Uint8Array): Promise<boolean>;   // hard drop at ingest
  isMuted(pubkey: Uint8Array): Promise<boolean>;     // stored, hidden from feeds
  addKeyword(pattern: string): Promise<void>;        // substring, NFC-normalized, lowercased
  removeKeyword(id: number): Promise<void>;
  keywordFilters(): Promise<{ id: number; pattern: string; enabled: boolean }[]>;
}
```

- **Validation:** `add()` rejects non-`wss://` URLs, duplicates, and > 20 relays (ASSUMPTION cap);
  `publishWrapped` rejects events whose kind ∉ policy.allowKinds (defense in depth - RELAY-5
  already enforces). `muteKey` validates 32-byte pubkey.
- **Timeouts:** `publishWrapped` resolves on first `OK` or all-relays-responded, ≤ 10 s; `backfill`
  ≤ 30 s or returns partial with `truncated: true` (ASSUMPTION).
- **Versioning:** `RelayPort` v1; additive methods only. `NostrEvent` follows NIP-01 exactly.
- **Observability:** `relay:publish{url,ok}`, `relay:downlink_events{url,n}`, `relay:rejected{url,reason}`,
  `uplink:queued/drained/rate_limited`, `moderation:blocked_drop`, `moderation:muted_hidden`.

---

## 7. Nostr adapter spec - wrapping Airplane events in standard Nostr events (v2, normative)

> Protocol facts below verified against NIP-01 (nostr-protocol/nips `01.md`) and NIP-09 (`09.md`)
> via web search on 2026-10-10. Nostr identity = secp256k1 keypair, Schnorr signatures per
> BIP-340; event `id` = sha256 of the UTF-8 JSON (no whitespace) of
> `[0, pubkey, created_at, kind, tags, content]`; `sig` = 64-byte hex Schnorr over `id`.

### 7.1 Wrap mapping (RELAY-5 normative)

Our signed CBOR envelope (EVENT-1…6, Ed25519, §3) is wrapped **opaque** inside a standard Nostr
event so any relay stores and serves it with zero Airplane-specific code:

| Nostr field | Value for a wrapped post |
|---|---|
| `kind` | `1919` (`NOSTR_KIND_AIRPLANE`) - regular (stored) kind in the NIP-01 `1000–9999` regular range; absent from the NIP kind registry as of 2026-10-10 (band-mates: 1040 OpenTimestamps, 1059 Gift Wrap, 1063 File Metadata, 1068 Poll, 1111 Comment, 1617–1622 git, 1984 Reporting, …). NOT kind 1: a base64 blob in the global text-note feed would pollute every Nostr client's main timeline; NOT ephemeral (`20000–29999`): relays are not expected to store those, and we need storage; NOT parameterized-replaceable (`30000+`): we want append-only, not per-d-tag replacement |
| `content` | **base64** (RFC 4648 §4, standard alphabet with padding) of the CBOR-encoded inner `SignedEvent` (the exact 8-position array EVENT-3 produces, ≤ 4 096 B → ≤ 5 464 chars). Decision: base64 over hex - 33 % smaller than hex, relay-agnostic ASCII, trivially decodable. NOT raw CBOR bytes (content must be a UTF-8 string) |
| `tags` | `[["g", "<geohash5>"], ["client", "airplane"], ["v", "1"]]` - `g` = origin geohash (single-letter tags are relay-indexed per NIP-01 filters → downlink geo-scoping via `#g`); `client` = app tag (existing client-tag convention); `v` = adapter schema version (bump if this mapping changes) |
| `pubkey` | the device's **relay** secp256k1 x-only pubkey (hex) - NOT the mesh Ed25519 key |
| `created_at` | = inner event's `created_at` (keeps one timeline; relays may impose their own bounds - NIP-11) |
| `id` / `sig` | standard NIP-01: sha256 of `[0, pubkey, created_at, kind, tags, content]`; 64-byte hex BIP-340 Schnorr by the relay key |

**Signature relationship (two independent trust roots):** the OUTER Schnorr signature proves "this
envelope was submitted by relay-key K" - relays verify it at ingest, clients MAY verify it. The
INNER Ed25519 signature (inside the base64 blob) proves "this post was authored by mesh-key M" -
clients MUST verify it via EVENT-2; it is the only authorship that matters. The relay key is a
throwaway transport pseudonym by default; it is unlinkable to the mesh key unless the user opts
into the §4.7 binding event. A malicious relay can drop or delay envelopes (availability attack)
but cannot forge authorship, alter content (inner id/sig would break), or mint posts as someone
else.

### 7.2 What gets a Nostr kind - and what stays mesh-only (decided)

- **Posts (inner kind 1) → Nostr kind 1919.** Uplinked only when the author opts in at compose
  (RELAY-2). Carries the mesh view-count snapshot: the wrap adds tag
  `["views", "<n>", "<as_of_unix>"]` where `n` = `STORE-2.countViews(postId)` at enqueue time.
  This is the ONLY view data that ever leaves the mesh - raw receipts (inner kind 2) are NEVER
  wrapped or published (coordinator decision).
- **Tombstones (inner kind 3) → Nostr kind 5 (NIP-09 deletion request).** `e` tag = target wrapped
  post's Nostr `id` (hex), `k` tag = `1919`, plus the standard `g`/`client`/`v` tags; `content` =
  base64(inner tombstone CBOR) so any client can verify authorship without trusting the relay.
  Relays SHOULD honor deletions from the same pubkey (NIP-09) - compliance is voluntary, so
  RELAY-3 ALSO applies the inner tombstone locally on downlink (authorship rule: inner
  `tombstone.pubkey == post.pubkey`; outer relay keys need not match). Tombstones are enqueued in
  RELAY-2's priority lane.
- **View receipts (inner kind 2) → mesh-only. No Nostr kind.** They stay on BLE. Rationale:
  receipts are high-volume, privacy-sensitive (they reveal who viewed what, when), and useless to
  the world feed - the snapshot tag carries what ranking needs.
- **Reports (abuse):** NIP-56 kind `1984` (Reporting) exists in the registry; our client MAY publish
  kind-1984 reports when a user reports a world-feed post (worker 1 owns the UX; the mechanism is
  specified here). Relays that honor NIP-56 act on them; we never rely on it - local block is the
  guarantee.

### 7.3 Downlink filter shape

```json
["REQ", "<sub-id>", { "kinds": [1919, 5], "#g": ["tdr1v", "tdr1u", "..."], "since": 1728500000, "limit": 200 }]
```
`#g` defaults to the FEED-4 9-cell ring; Settings "world mode" drops `#g` (explicit user choice).
Cursors per relay in STORE-6 (`since` = last seen `created_at`). Unknown kinds in responses are
ignored (forward-compat - never crash on a relay's extra data).

### 7.4 World-feed ranking spec (normative)

The World feed (FEED-1 `getWorldFeed()`) ranks **primarily by recency, mesh-views second**:

```
age_h   = (now - received_at) / 3600            // LOCAL receive time (same anti-skew rule as §5.3/C11)
views   = views_snapshot from the ["views", n, as_of] tag (0 if absent)
worldScore = 1 / (age_h + 2)^1.2  +  0.5 * log10(1 + views) / (age_h + 2)^1.5
             \________ recency term ________/    \________ views term ________/
```
Weights `1.2` / `0.5` are ASSUMPTION (tune in P3 with real relay data). Deterministic tiebreak:
inner `id` ascending. Deleted (tombstoned) and expired events are excluded before ranking.
**Approximate labeling (required UI copy):** every world-feed view count renders as "≈ N" with the
footnote "views counted on local meshes - approximate, not audited". Raw receipts never leave the
mesh, so exact global counts are unknowable by design - the UI must not imply otherwise.

### 7.5 Moderation hooks (mechanism - worker 2; launch-gate UX owned by worker 1)

The World feed amplifies abuse (audit P0 M1): anonymous broadcast + global reach + no server.
Mechanisms specified here; worker 1 owns the v1 sideload-launch gate (per-post report/hide,
per-key mute/block, keyword filter UX in UI-5):

1. **Client-side per-key rate limits (relay-agnostic):** RELAY-2 enforces `UPLINK_RATE_PER_DAY`
   (50) publishes per relay-identity per 24 h BEFORE any relay contact - holds on every relay
   including ones with no limits. Mesh-side per-key flood limits live in MESH-2 (worker 1).
   Rationale: identities are free to mint, so limits alone don't stop a determined spammer -
   they raise the cost of casual abuse and give relays' own limits (e.g. damus rate-limiting)
   a client that doesn't trip them.
2. **Local mute/block (data model - §6.7 `IModerationStore`, DDL in Appendix D):**
   - `block` = hard drop at ingest: EVENT-2 (mesh) and RELAY-3 (world) check `isBlocked(pubkey)`
     BEFORE signature verification (saves CPU on known-bad keys). Blocked keys' events are never
     stored, never displayed, never relayed onward.
   - `mute` = stored but hidden: FEED-1 excludes muted authors from both feeds' queries;
     reversible in Settings. Scope is per-key with a `scope` column (`mesh`/`world`/`both`).
   - Both are LOCAL-ONLY: never wrapped, never published, never leave the device (mutation rule §5.2.9).
3. **Relay-level filtering hooks (RELAY-5 + RELAY-4):** per-relay `RelayPolicy` carries
   `allowKinds` (default `[1919, 5]` - the adapter refuses to wrap anything else, so a bug can't
   publish DMs to the world) and `denyPatterns` (per-relay keyword deny list, substring match on
   NFC-normalized lowercase content; violation → `POLICY_DENY` before network). Downlink applies
   the same deny patterns + the global keyword filters before EVENT-2. NIP-56 kind-1984 reports
   are the standards-based escalation path to relay operators (§7.2).
4. **What this does NOT do (honest):** no global moderation (no backend, no trusted third party);
   a spammer minting fresh keys on a permissive relay still reaches users who haven't blocked them -
   the world feed defaults to the 9-cell `#g` scope to bound blast radius, and widening to global
   is an explicit user choice. Relay reputation scoring and Tor-gated publishing are deferred (P5).

### 7.6 Deferred (named, with phase)

- **Tor / onion relays:** publishing/fetching via `ws://*.onion` - P5+ (needs Arti/Orbot integration
  research; RELAY-4 currently rejects non-`wss://` URLs).
- **Relay reputation scoring:** per-relay spam/abuse scoring feeding auto-disable - P5.
- **NIP-65 relay lists (kind 10002):** protocol-native relay discovery - P3 candidate.
- **NIP-42 AUTH:** relays requiring authentication - P3 (RELAY-1 marks `needs_auth` today and skips).
- **Global auto-uplink:** explicitly NOT in v1 by coordinator decision; any future change needs a
  product-level safety review (protest scenario), not just an engineering one.

---

## Appendix A - Transport frame envelope & fragment header (byte-exact)

Every BLE payload the app sends is a **frame**, discriminated by its first byte (frozen v2):

| First byte | Name | Layout |
|---|---|---|
| `0xA1` | EVENT_FRAG | 11 B fragment header (below, magic=`0xA1`) + ≤458 B data (MESH-3/4) |
| `0x02` | SYNC_HELLO | Appendix C |
| `0x03` | SYNC_WANT | Appendix C |
| `0x04` | SYNC_OFFER | sequence of EVENT_FRAG frames (each self-describing) |

> v2 note: the v1 draft had a separate `[frame_type: u8]` envelope prefix; the P1 implementation
> folds discrimination into the header's first byte (magic `0xA1` for fragments, `0x02–0x04` for
> sync control frames). Receiver rule: first byte `0xA1` → parse as fragment header; `0x02/0x03/0x04`
> → sync frame; anything else → drop + counter. `0x01` is unassigned (kept out to avoid confusion
> with the old draft).

**Fragment header - 11 bytes, big-endian** (frozen v2 - see reconciliation note below):

| Offset | Size | Field | Description |
|---|---|---|---|
| 0 | 1 | `magic` | `0xA1` - frame magic (identifies Airplane fragment frames) |
| 1 | 4 | `msg_tag` | first 4 bytes of the event `id` (sha256), big-endian u32 - reassembly/dedup key |
| 5 | 2 | `frag_total` | total fragments, 1–65535 (u16; `MAX_EVENT_BYTES` caps reality at ~9) |
| 7 | 2 | `frag_idx` | 0-based fragment index, must be `< frag_total` |
| 9 | 1 | `ttl` | remaining flood TTL stamped at fragment time (u8) |
| 10 | 1 | `flags` | reserved, must be 0 (forward-compat seam) |

> **Spec reconciliation note - 2026-10-10 (worker 2, audit P0 G4):** the v1 blueprint's Appendix A
> specified `[ver=0x01][frag_idx u8][frag_total u8][msg_tag 8B]`; the P1 implementation
> (`packages/protocol/src/flood/fragment.ts`, `docs/spec/wire-format.md`) shipped
> `[magic=0xA1][msgTag u32][total u16][index u16][ttl u8][flags u8]` with no ADR. **v2 freezes the
> P1 code layout** (this table). Rationale: (1) it is implemented, tested (71/71), and matches the
> repo spec - Appendix A was never built; (2) the per-fragment `ttl` byte is load-bearing for
> MESH-2 flood decisions and Appendix C SYNC_OFFER self-describing frames; (3) the `flags` byte is
> a forward-compat seam the v1 layout lacked; (4) the u16 total/index costs nothing because
> `MAX_EVENT_BYTES` (4 096) caps fragments at ~9 regardless. Accepted trade-off: 4-byte msgTag
> (vs 8) - collision risk is contained because msgTag is ONLY a reassembly key; EVENT-2 dedup and
> `seen` use the full 32-byte event id, and `Reassembler` already keeps-first-wins on
> total-mismatch (tag collision). The 8-byte tag survives in SYNC_HELLO/SYNC_WANT (Appendix C),
> which are inventory messages, not reassembly keys. No ADR churn: this dated note is the record.

Max wire frame = 11 + 458 = **469 B** (product spec). Payload per fragment =
`min(eff_mtu − 3 − 11, 458)` where `eff_mtu` comes from MESH-10 (default 23 → 9 B payload
frames until MTU is learned - tiny but correct; real links negotiate 185/517 quickly).
Max reassembled message: 65535 × 458 ≫ `MAX_EVENT_BYTES` (4 096) - EVENT-2's size cap
is the real limit; header space is not the constraint.

LZ4 marker: if the reassembled payload starts with `0x4C 0x5A` (`"LZ"`), MESH-4 strips it and
EVENT-4 decompresses before CBOR decode. (ASSUMPTION.)

## Appendix B - GATT profile (ASSUMPTION - freeze before interop testing)

128-bit UUIDs shown are placeholders; final values assigned in MESH-12 and mirrored in MESH-7 tests.

| Element | UUID (placeholder) | Properties |
|---|---|---|
| Service `AIRPLANE_SVC` | `a11ce000-6d5e-4c1a-9f2b-000000000001` | - |
| `RX_CHAR` (central → peripheral) | `…0002` | write-without-response |
| `TX_CHAR` (peripheral → central) | `…0003` | notify |
| `ID_CHAR` (read) | `…0004` | read → `peerId(8B hex-ascii 16B) ‖ protoVer u8 ‖ flags u8` |

Advertising packet: service UUID in the service-UUID AD field + 8 B rotating peer id in
manufacturer data (company id `0xFFFF` test range - ASSUMPTION; replace with assigned id if we ever
ship BLE-certified hardware, N/A for phones). No device name, no pubkey. Scan filter = service UUID.
Both roles run simultaneously (dual-mode like Bitchat: each device is client *and* peripheral -
verified Bitchat architecture from its public README).

## Appendix C - Sync frame layouts (MESH-8)

`SYNC_HELLO (0x02)`:
`[frame_type:1][proto_ver:1][cell_count:1][cells: cell_count×5B ascii][min_ts: u32 BE][tag_count:1][tags: tag_count×8B]`
- advertises newest `SYNC_INVENTORY_N` (200) event tags in shared cells.

`SYNC_WANT (0x03)`:
`[frame_type:1][want_count:1][tags: want_count×8B]` - request specific events by tag.

`SYNC_OFFER (0x04)`:
followed by 1…`SYNC_BUDGET_EVENTS` (50) complete EVENT_FRAG sequences (each self-describing via
msg_tag). Receiver reassembles → EVENT-2 → STORE-2 → MESH-2 (relay decision applies to synced
events too - TTL is decremented as if received over flood; ASSUMPTION).

Typical exchange on connect: A→B HELLO, B→A HELLO, each side computes
`their_tags − my_tags`, sends WANT or directly OFFERs up to budget, both update `sync_state.cursor`.

## Appendix D - SQLite DDL (STORE-1…STORE-5; migration `001_initial.sql`)

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE events(
  id         BLOB PRIMARY KEY,              -- 32-byte event id
  pubkey     BLOB NOT NULL,                 -- 32-byte Ed25519
  kind       INTEGER NOT NULL CHECK(kind IN (1,2,3)),
  created_at INTEGER NOT NULL,              -- unix seconds
  geohash    TEXT NOT NULL CHECK(length(geohash)=5),
  tags       BLOB NOT NULL,                 -- CBOR-encoded tags array
  content    TEXT NOT NULL DEFAULT '',
  sig        BLOB NOT NULL,                 -- 64-byte signature
  received_at INTEGER NOT NULL,             -- local receipt time
  expires_at INTEGER NOT NULL,              -- created_at + retention
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
);
CREATE INDEX idx_events_feed   ON events(kind, geohash, created_at DESC);
CREATE INDEX idx_events_expiry ON events(expires_at);
CREATE INDEX idx_events_pubkey ON events(pubkey, created_at DESC);

CREATE TABLE receipts(                      -- counted views: 1 per (pubkey, post, day)
  pubkey     BLOB NOT NULL,
  post_id    BLOB NOT NULL,
  day_bucket INTEGER NOT NULL,              -- floor(created_at/86400)
  event_id   BLOB NOT NULL UNIQUE,          -- the receipt event id
  created_at INTEGER NOT NULL,
  PRIMARY KEY(pubkey, post_id, day_bucket)
);
CREATE INDEX idx_receipts_post ON receipts(post_id);

CREATE TABLE view_counts(                   -- derived cache, recomputed after migrations
  post_id    BLOB PRIMARY KEY,
  views      INTEGER NOT NULL DEFAULT 0,    -- distinct pubkeys
  updated_at INTEGER NOT NULL
);

CREATE TABLE peers(
  peer_id    TEXT PRIMARY KEY,              -- rotating BLE id (16 hex chars)
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  rssi       INTEGER,
  mtu        INTEGER,                       -- hint only; renegotiated per connect
  platform   TEXT CHECK(platform IN ('ios','android'))
);
CREATE INDEX idx_peers_seen ON peers(last_seen);

CREATE TABLE sync_state(
  peer_id       TEXT PRIMARY KEY,
  last_hello_at INTEGER,
  cursor_ts     INTEGER                     -- newest created_at offered to this peer
);

CREATE TABLE seen(                          -- flood dedup spillover
  msg_tag BLOB PRIMARY KEY,                 -- 8-byte fragment tag
  seen_at INTEGER NOT NULL
);
CREATE INDEX idx_seen_at ON seen(seen_at);

CREATE TABLE frag_buf(                      -- transient reassembly spillover
  msg_tag     BLOB NOT NULL,
  idx         INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  data        BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(msg_tag, idx)
);

CREATE TABLE logs(                          -- OBS-1 persisted tail
  ts    INTEGER NOT NULL,
  level TEXT NOT NULL,
  tag   TEXT NOT NULL,
  msg   TEXT NOT NULL
);
CREATE INDEX idx_logs_ts ON logs(ts);

-- v2 additions (RELAY subsystem + moderation). Migration 002_relay.sql is ADDITIVE:
-- existing installs gain columns/tables; no data migration needed.

ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'mesh'
  CHECK(source IN ('mesh','world'));        -- which transport ingested first (never rewritten)
ALTER TABLE events ADD COLUMN mesh_views INTEGER;          -- ["views",n] snapshot tag at uplink/downlink (NULL = unknown)
ALTER TABLE events ADD COLUMN views_as_of INTEGER;         -- unix seconds of the snapshot
ALTER TABLE events ADD COLUMN nostr_id BLOB;              -- 32-byte outer Nostr id (world rows; NULL for mesh-only)
ALTER TABLE events ADD COLUMN relay_pubkey BLOB;          -- 32-byte x-only secp256k1 submitter key (world rows)
CREATE INDEX idx_events_world ON events(source, created_at DESC) WHERE source='world';

CREATE TABLE uplink_queue(                   -- RELAY-2 durable opt-in outbox
  event_id    BLOB PRIMARY KEY,             -- inner event id
  kind        INTEGER NOT NULL CHECK(kind IN (1,3)),  -- posts + tombstones only; receipts never uplink
  wrapped_at  INTEGER NOT NULL,             -- enqueue time (unix seconds)
  views_snapshot INTEGER NOT NULL DEFAULT 0,-- mesh view count at enqueue
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,           -- unix seconds
  priority    INTEGER NOT NULL DEFAULT 0 CHECK(priority IN (0,1)),  -- 1 = tombstone lane
  expires_at  INTEGER NOT NULL              -- drop when the post expires
);
CREATE INDEX idx_uplink_next ON uplink_queue(priority DESC, next_retry_at);

CREATE TABLE muted_keys(                     -- local-only moderation (never synced, never published)
  pubkey     BLOB PRIMARY KEY,              -- 32-byte Ed25519 mesh identity
  action     TEXT NOT NULL CHECK(action IN ('mute','block')),
  scope      TEXT NOT NULL DEFAULT 'both' CHECK(scope IN ('mesh','world','both')),
  created_at INTEGER NOT NULL
);

CREATE TABLE keyword_filters(
  id         INTEGER PRIMARY KEY,
  pattern    TEXT NOT NULL,                 -- substring; stored NFC-normalized lowercase
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE relay_health(                   -- RELAY-1 per-relay counters (rolling 30 d)
  url             TEXT PRIMARY KEY,
  connects        INTEGER NOT NULL DEFAULT 0,
  publish_ok      INTEGER NOT NULL DEFAULT 0,
  publish_rejected INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_seen       INTEGER,                  -- unix seconds of last successful contact
  window_start    INTEGER NOT NULL          -- unix seconds; reset when older than 30 d
);

CREATE TABLE publish_counters(               -- RELAY-2 client-side rate limit (trailing 24 h)
  relay_pubkey BLOB NOT NULL,               -- our relay identity (32 B x-only)
  day_bucket   INTEGER NOT NULL,            -- floor(now/86400)
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(relay_pubkey, day_bucket)
);
```

## Appendix E - Key decisions, honest limits, and open questions for sibling workers

**Decided in v2 (relay + identity):**
6. Relays are untrusted dumb pipes: standard Nostr events (NIP-01), any relay software works,
   NO Airplane backend, NO Airplane-run relay. Authorship = inner Ed25519 signature; the outer
   Schnorr signature is a transport pseudonym, unlinkable to the mesh key by default.
7. Uplink is OPT-IN per post at compose time, default OFF (coordinator decision). No global
   auto-uplink in v1 - a Delhi protest post must never silently go global.
8. View receipts never leave the mesh. The world feed ranks by recency first, mesh-view snapshots
   second, and view counts are labeled approximate - exact global counts are unknowable by design.
9. Identity = stable per-device Ed25519 keypair (Keychain/Keystore via `KeyStorePort`) + a
   SEPARATE secp256k1 relay keypair. Stable key = linkable pseudonym (no PII bound); rotation via
   Settings burns old authorship (old posts become undeletable). Key custody lives in a new
   `packages/crypto` - `packages/protocol` stays pure/hermetic.
10. Moderation mechanism (worker 2): client-side per-key publish rate limits, local mute/block
    (hard drop at ingest / hidden at query, never synced), per-relay `RelayPolicy` hooks in the
    adapter, NIP-56 kind-1984 reports as the standards-based escalation. No global moderation -
    there is no server to do it. ARCHITECTURE.md §2.5 defines the v1 launch-gate UX copy.

**Honest limits (v2 additions - do not promise otherwise):** a relay operator sees publish timing
and IP metadata (transport privacy is NOT provided - Tor is P5+); deletion on relays is a request
(NIP-09), not a guarantee - our local tombstone application is the real delete; a relay can
censor our events (that's why the directory ships 4 independent defaults and is user-editable);
world-feed view counts are approximate snapshots; spam with free key minting is mitigated
(rate limits, scope-default, blocklists) not solved.

**Decided here (challengeable, but changing them ripples):**
1. Relays forward opaque signed bytes; verification happens at every ingest - integrity without trust.
2. Location scope enforced at ingest AND relay (FEED-4): the flood is geographically bounded by design.
3. View receipts are public signed events (dedup needs the pubkey); "views" = distinct viewing devices,
   honestly labeled in UI copy - not humans, gameable, stated upfront.
4. Foreground-first: iOS background relay is documented-degraded, not faked.
5. No encryption in v1: posts are public broadcasts. (E2E would contradict the public-feed product.)

**Honest limits (do not promise otherwise):** broadcast storms in dense crowds are mitigated (TTL 7,
jitter, dedup, backpressure) not solved - TEST-4 is a CI gate, not a proof; traffic-analysis
resistance is out of scope for v1; battery cost of continuous BLE is real - MESH-9 defaults to
balanced mode.

**Open questions for other workers:**
- UI worker: exact copy for "views = devices, not people" and the anonymity-limits onboarding slide.
- Protocol/security worker: review EVENT-2 check ordering, tombstone-before-target policy, and the
  `+300 s` future-timestamp acceptance window.
- Mobile/native worker: confirm `IBleAdapter` against chosen BLE lib (custom TurboModule vs
  react-native-bluetooth-ble **per OSS research (verify)**); iOS background-mode plist reality check;
  LZ4 choice (**per OSS research (verify)**: lz4js vs native).
- PM/coordinator: retention default (24 h) and receipt day-bucket semantics are ASSUMPTIONs - confirm
  with Tuba before beta.

---
*End of system design. 63 nodes registered (58 v1 + RELAY-1…5 v2). Next: diagram worker consumes §1;
mobile worker implements §6.4 `IBleAdapter`; protocol worker stress-tests §5.3 and Appendix A–C;
relay worker implements §4.12/§6.7/§7 behind `RelayPort` with `packages/crypto` for key custody.*
