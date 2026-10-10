# Airplane — Operations, Reliability, Security (canonical)

> Synthesized 2026-10-10 by the architecture coordinator from the reliability/ops worker output.
> Contains the full ADRs (ADR-01…ADR-08), runtime strategy, distribution plan, dependency map,
> failure analysis, and gap report. Verification tags: **[V]** verified this session, **[FR]** framework research 2026-10-10, **[UNVERIFIED]**.

---

**Project:** Airplane — anonymous public broadcast feed with two feeds: "Around you" (BLE mesh, fully offline, local-first) and "World" (opportunistic global relay over untrusted third-party Nostr relays; uplink opt-in per post, default OFF). **No Airplane backend, no Airplane-run relay.**
**Stack:** React Native + Expo (dev client, CNG), SQLite + MMKV, signed CBOR events (Ed25519), views-based ranking.
**Status:** Working paper for the architecture blueprint. Repo `enginoor/airplane` is empty.
**Date:** 2026-10-10. Version claims marked **[V]** were verified against 2025–2026 sources this session; version numbers from the 2026-10-10 framework research are cited as **[FR]**. Anything I could not verify is marked **[UNVERIFIED]** — do not treat as fact.

**Scope note:** This document covers runtime, distribution, dependencies, reliability, failure handling, gaps, and ADRs. It does not design transports, protocols, crypto formats, UI, or data models — those belong to the other five workers. Cross-references use node IDs: `APP` (app shell/lifecycle), `UI` (feed UI), `FEED` (ranking), `MESH` (BLE transport/flood), `EVENT` (event schema/verify), `STORE` (persistence), `CRYPTO` (keys/signing), `LOC` (location), `OBS` (observability), `DIST` (distribution/update), `TEST` (testing).

---

## 1. Runtime strategy (mobile-appropriate)

There are no containers, no servers, no sidecars in the user runtime. The runtime is two phone OSes. "Ops" for Airplane means: lifecycle discipline, permission discipline, battery discipline, and graceful degradation. Dev containers and CI runners are the only place containers appear (see §2).

### 1.1 Process / thread model

- **One app process per OS.** No multi-process design (Android `:remote` services, iOS app extensions) in v1 — the IPC and lifecycle cost exceeds the benefit for a flood-relay mesh.
- **JS thread (Hermes)** owns: `APP` startup orchestration, `UI`, `FEED` ranking, `STORE` query logic, `EVENT` schema validation and signature *orchestration*, flood-control *policy* (TTL/jitter/dedup decisions). JS is single-threaded: every native callback must be non-blocking, and every heavy loop must be chunked or moved off-thread.
- **Native threads** own: BLE scan/advertise/connect/GATT I/O (CoreBluetooth queues on iOS; `BluetoothLeScanner`/`BluetoothGatt` callbacks on Android binder threads), crypto primitives via JSI (synchronous C++ — fast, but still keep batch verifies off the JS thread), SQLite I/O via op-sqlite's JSI (its own threading).
- **Rule:** native → JS callbacks deliver *small summaries* (peer appeared, chunk received), never raw floods. `MESH` assembles fragments natively or in a bounded JS buffer, then hands complete datagrams to `EVENT` for CBOR decode → schema validate → signature verify → `STORE` insert. Any stage that fails validation drops the datagram and increments a counter (`OBS`) — never throws across the bridge.
- **Serialization hot path:** CBOR decode + Ed25519 verify per received event. With native Ed25519 (`CRYPTO`), verify is ~microseconds **[V]** (Margelo's published comparison shows ~10k Ed25519 sign/verify ops/sec vs ~60/sec for pure-JS noble — their numbers, treat as directional). At mesh scale (tens of events/sec in a dense crowd) this is fine on the JS thread *if* native-backed; the pure-JS noble fallback must be reserved for low-rate paths (own signing, occasional verify) or moved to a worker. **Adapter required** (see §8): `CRYPTO` exposes `sign/verify` behind an interface; `APP` selects native implementation at startup, falls back to noble with a logged warning.

### 1.2 Lifecycle

| State | Android | iOS |
|---|---|---|
| Foreground | Full mesh: scan + advertise + GATT server + flood relay. | Full mesh while foregrounded. |
| Background, screen on | Foreground service (`connectedDevice` type) keeps scan/advertise alive; persistent notification. OEM battery managers (Xiaomi, Oppo, Vivo, Samsung) may still kill — see §O. | `bluetooth-central` + `bluetooth-peripheral` background modes: scanning continues throttled/coalesced, `allowDuplicates` ignored; advertising moves service UUIDs to the **overflow area** — discoverable only by iOS devices scanning for that exact UUID; **Android cannot discover a backgrounded iPhone** [V][FR]. |
| App killed / suspended | FGS with `START_STICKY` attempts restart; OEM-dependent, not guaranteed. | System may relaunch on BLE events if state restoration was opted in (`CBCentralManagerOptionRestoreIdentifierKey`); degraded, never guaranteed always-on [V]. Force-quit by user disables relaunch until next manual launch. |
| Radio off / permission revoked | `MESH` enters dormant state; `APP` shows persistent non-blocking banner with one-tap fix deep-link (settings). No crash, no spin. | Same; CoreBluetooth `poweredOff` → dormant. |

**Design posture: foreground-first mesh (ADR-07).** The product's core scenarios (protest, concert, dead zone) have the phone in hand or in pocket with screen on. Background relay is best-effort opportunism, not a guarantee — the protocol and UX must never promise delivery.

### 1.3 Startup order (`APP`)

1. Native module init (crash handler first — `OBS` installs before anything else can throw).
2. JS bundle → `APP` bootstrap: read `MMKV` config (feature flags, duty-cycle params, last clean shutdown marker).
3. `STORE`: open SQLite, run migrations, `PRAGMA integrity_check` (fast path; full check weekly — see §O SQLite corruption).
4. `CRYPTO`: load-or-generate Ed25519 identity from secure storage (Keychain/Keystore). Never generate silently on every launch — key loss = identity loss (§O).
5. `EVENT`: replay last N events from store into in-memory feed heads (bounded — e.g., 500, then lazy-load).
6. `MESH`: permission check → radio check → start scan/advertise per duty-cycle policy → start FGS (Android).
7. `UI`: render feed; show lifecycle banner if degraded (radio off, permissions missing, background-only).

Cold-start budget is a **target needing validation**: < 2 s to interactive feed on a mid-range Android (see §11).

### 1.4 Graceful shutdown

- `APP` writes a clean-shutdown marker + persists: seen-event LRU snapshot, flood queue heads, duty-cycle state, last event cursor.
- `MESH` stops advertising first (so peers drop us cleanly), then scan, then closes GATT server.
- `STORE` checkpoints SQLite WAL.
- On unclean start (marker absent): run integrity check, reconcile seen-cache from store, resume — the event store is the source of truth (§11).

### 1.5 Resource limits

- **Battery — scan/advertise duty cycling (`MESH`, `APP`):** continuous BLE scan is the dominant drain. Default policy (tunable via `MMKV`, targets needing validation): scan windows of ~30 s with ~10 s rest while foregrounded and stationary; shorten rest when new peers appear (crowd detected); lengthen rest when battery < 20% or no peers seen for 5 min. Advertising interval relaxed (e.g., ~500 ms–1 s) — discovery latency vs. drain trade-off, validate on device.
- **Memory — LRU caps (`STORE`, `MESH`):** seen-event ID cache cap (e.g., 10k entries), per-peer reassembly buffers cap (e.g., 64 KB/peer, 16 peers), view-receipt dedup table bounded by 24 h window (SQLite TTL delete), feed in-memory window (2 000 ranked items — designed value, SYSTEM_DESIGN.md §4.3 FEED-1; rest paged from SQLite). No unbounded arrays anywhere on the flood path.
- **Storage — pruning (`STORE`):** event table size cap (e.g., 50k events or 200 MB, whichever first — validate); prune oldest non-pinned events first; never prune own posts or events < 24 h old without user-visible setting. View receipts are ephemeral by design (24 h dedup window) — aggressive prune is safe.

### 1.6 Permissions model per OS

**Android** (permission matrix verified against 2026 BLE library docs **[V]**):

| Operation | API 31+ (Android 12+) | API ≤ 30 |
|---|---|---|
| Scan | `BLUETOOTH_SCAN` (runtime) with `android:usesPermissionFlags="neverForLocation"` so scan is **not** treated as location | `BLUETOOTH` + `BLUETOOTH_ADMIN` + `ACCESS_FINE_LOCATION` |
| Connect / GATT server | `BLUETOOTH_CONNECT` (runtime) | `BLUETOOTH` + `BLUETOOTH_ADMIN` |
| Advertise | `BLUETOOTH_ADVERTISE` (runtime) | `BLUETOOTH` + `BLUETOOTH_ADMIN` |
| Foreground service | `FOREGROUND_SERVICE_CONNECTED_DEVICE`; service declared `android:foregroundServiceType="connectedDevice"`; **Android 14+ rejects `startForeground()` without a type** [V] | `FOREGROUND_SERVICE` |
| FGS notification | `POST_NOTIFICATIONS` (runtime, API 33+) | n/a |

Location-permission implication: on Android 12+ with `neverForLocation`, BLE scanning does **not** require location permission and scan results are stripped of location derivation — declare exactly this; do not request `ACCESS_FINE_LOCATION` on 12+ (it would contradict the product's privacy story and trigger Play scrutiny). On API ≤ 30, location permission is unavoidable for scan — the permission rationale screen must explain this honestly. `minSdkVersion`: recommend **26** (Android 8.0) — covers extended-advertising APIs and the modern permission model; pre-26 devices are a shrinking tail not worth the legacy permission matrix. **[Decision for architect sign-off.]**

**iOS:**

- `NSBluetoothAlwaysUsageDescription` (and legacy `NSBluetoothPeripheralUsageDescription`) with a concrete, honest string: what the mesh does and why it runs in background.
- `UIBackgroundModes`: `bluetooth-central`, `bluetooth-peripheral`.
- `PrivacyInfo.xcprivacy` listing required-reason APIs actually used (UserDefaults, file timestamps) in every bundle **[V]**.
- No location permission requested at all: `LOC` is coarse/on-device (see gap on location granularity — worker 5's call; ops only requires that we never request what we don't need).

**Permission-denied behavior:** every `MESH` operation checks grants per call and returns typed errors (`bt-permission-required`), never prompts from the bridge. `UI` renders a single persistent fix-it card. Denial is a normal state, not an exception.

---

## 2. Distribution strategy (sideload-first, ADR-06)

No backend, no cloud, no store dependency for the primary channel. The release pipeline produces signed artifacts; users install them directly or via Obtainium. Stores are secondary channels with explicit review-risk handling.

### 2.1 GitHub Releases APK pipeline (primary, Android)

- **Trigger:** push of tag `vX.Y.Z` (semver) or manual dispatch. CI (GitHub Actions, `ubuntu-latest` runner — containers in CI only, per §1 scope note) runs: typecheck → lint → unit tests → `eas build --platform android --profile production` **or** bare `./gradlew assembleRelease` inside the prebuilt `android/` dir (CNG output committed). EAS Build is recommended: no Mac needed, reproducible, and the team already uses Expo.
- **Signing in CI:** release keystore stored as `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` + `ANDROID_KEY_ALIAS` + `ANDROID_KEY_PASSWORD` in GitHub Actions secrets **[V]** (standard pattern, verified across multiple 2026 repos). Workflow decodes to a `0600` temp file, signs, verifies (`apksigner verify`), then `shred -u` the temp keystore in an `always()` step. Keystore + passwords never touch git or logs. The keystore's backup lives **offline with Tuba** (two copies, separate media) — losing it means losing the update identity forever (§O).
- **Versioning:** `versionName` = semver tag; `versionCode` = strictly monotonic integer derived from the tag (e.g., `major*1000000 + minor*1000 + patch`, plus build number on re-cuts). **Monotonic `versionCode` is what Obtainium uses to detect updates** [V] — a non-increasing versionCode silently breaks the update channel. Enforce monotonicity in CI (fail the release job if `versionCode <= latest release`).
- **Artifacts per release:** `airplane-<version>-arm64.apk` (split ABI to keep size sane) + `airplane-<version>-universal.apk`; `.aab` built alongside for the optional Play track. Release notes = changelog excerpt. Attach a `SHA-256SUMS` file.
- **Supply-chain note:** consider Sigstore-style signing of release artifacts later (gap §12); minimum viable is the Android signature + checksums.

### 2.2 Obtainium compatibility (recommended update UX)

Obtainium (ImranR98, open-source) tracks a GitHub repo's Releases page, polls on a schedule (default every 6 h), and installs updates over the top — including background auto-install on Android 12+ **[V]**. Compatibility requirements, all satisfiable:

1. Releases published as GitHub Releases with APK assets (yes — §2.1).
2. Monotonically increasing `versionCode` (enforced — §2.1).
3. Stable asset naming + a documented regex filter (e.g., `airplane-.*-arm64\.apk`) so Obtainium picks the right ABI asset; publish an `OBTAINIUM.md` in the repo with the one-tap setup (repo URL → Add App → filter regex), following the pattern used by sideload-first projects **[V]**.
4. Same signing key on every build (keystore discipline — §2.1).

Obtainium becomes the *de facto* updater: users add `enginoor/airplane` once, updates flow. This externalizes the hardest part of sideload distribution (detection + install) to a maintained tool instead of hand-rolled code.

### 2.3 iOS: TestFlight path (primary, iOS)

iOS has no sideload equivalent for normal users, so TestFlight is the iOS primary channel:

- Internal testers (up to 25, no review) for dev builds; external testers (up to 10,000) after a lighter Beta App Review.
- **Builds expire after 90 days** — the ops calendar must cut a fresh build at least every ~75 days or iOS users go dark. Automate: scheduled CI job that bumps build number and pushes to TestFlight if no release happened in 60 days.
- EAS Build can produce and submit iOS builds without a Mac in the loop (App Store Connect API key in CI secrets).
- Review risk applies to TestFlight external review too (Guideline 1.2) — the moderation story (§2.5) must be in the binary before the first external submission.

### 2.4 Google Play / App Store as secondary channels

Only after the sideload channel is healthy. Honest accounting:

- **Google Play:** requires the `connectedDevice` foreground-service-type declaration in Play Console (manual approval step) **[FR]**; `BLUETOOTH_SCAN` with `neverForLocation`; avoid background location entirely. Play's UGC expectations (report/block flows for user-generated content) must be implemented regardless — they're needed for the product anyway (§12 moderation gap). `REQUEST_INSTALL_PACKAGES` (if we ship in-app APK self-update) draws Play scrutiny — gate that code path to non-Play builds via flavor/build flag.
- **App Store:** background modes + Bluetooth usage descriptions are routinely approved when justified **[FR]**; the real risk is **Guideline 1.2 (revised Feb 6, 2026), which explicitly targets "random or anonymous chat" and allows removal without notice** [FR]. An anonymous broadcast feed is the highest-risk shape on the store, independent of framework.
- **Review-risk mitigation (all must be true before submission):** (a) frame the product as a *public broadcast feed*, never "chat" — no DMs, no 1:1 messaging exists to misread; (b) ship on-device moderation UX: per-post report/hide, per-key block/mute, keyword filter, 17+ rating; (c) review notes include a no-second-device demo path (reviewers can't mesh alone) **[FR]**; (d) keep the sideload channel as the continuity plan if removed — removal must be survivable, not fatal.

### 2.5 In-app update check for sideloaded builds — options compared honestly

| Option | How | Verdict |
|---|---|---|
| **A. Obtainium (external)** | User installs Obtainium once; it tracks GitHub Releases, notifies/installs. | **Recommended primary.** Zero code, maintained by others, background auto-install on Android 12+. Cost: one extra app install; users must discover it (document in-app). |
| **B. In-app GitHub Releases poll** | `DIST` polls `api.github.com/repos/enginoor/airplane/releases/latest` (10 s timeout, weekly default + manual "check" button), compares `versionCode`, prompts, downloads APK, fires install intent. | **Recommended secondary / convenience.** Needs `REQUEST_INSTALL_PACKAGES` (permission prompt; Play-scrutiny if ever on Play — flavor-gate it). No server of ours involved — GitHub is the dumb file host. Rate limits: unauthenticated 60 req/h/IP — fine at weekly cadence. |
| **C. EAS Update / expo-updates OTA** | JS-bundle-only over-the-air updates via Expo's hosted service. | **Not recommended.** Hosted = cloud dependency (tension with ADR-08); cannot change native code — and most Airplane fixes will be native (BLE, FGS, permissions); adds Expo-account trust. |
| **D. Self-hosted OTA** (e.g., Codemagic Patch-style own server) | Own update server for JS bundles. | **Ruled out.** A server is a server (ADR-08). Also JS-only — same native limitation as C. |
| **E. `sp-react-native-in-app-updates`** | Wraps Play Core in-app updates + iTunes lookup. | **Irrelevant** to the sideload channel; only useful if/when on the stores. |

Decision: **A primary, B as in-app convenience.** Both respect "no backend": GitHub Releases is static file hosting, not our infrastructure.

### 2.6 Rollback story

- **Android:** the OS forbids downgrading to a lower `versionCode` with the same signing key. There is no graceful rollback — the recovery is a **fast-forward hotfix** (`vX.Y.Z+1`) through the same pipeline; Obtainium picks it up within ~6 h. Keep the release pipeline runnable in < 30 min (warm CI cache, one-command tag cut) because hotfix speed *is* the rollback plan. Nuclear option: user uninstalls + reinstalls older APK — loses local event store and (on Android) the Keystore identity (§O key loss) — document, don't rely on.
- **iOS:** expire the bad TestFlight build, push a fixed build; users update from TestFlight. Same fast-forward logic.
- **JS-only emergencies:** none — no OTA by design (ADR-08). Accept the trade: slower fix propagation in exchange for zero cloud trust.

---

## 8. Package / dependency map

Policy for every entry: **exact pin** (`"1.2.3"`, no `^`/`~`), committed lockfile, **Renovate** (recommended over Dependabot for RN: better grouping + Expo-aware presets — **[UNVERIFIED: confirm Renovate's Expo preset currency at setup]**) with automerge for patch-level bumps of pure-JS deps and manual review for anything native or crypto. Prefer dependencies that publish with **npm provenance** (Sigstore-backed attestations) where available; record provenance status at pin time.

Consuming-module key: `APP` shell/lifecycle · `UI` feed UI · `FEED` ranking · `MESH` BLE transport/flood · `EVENT` event schema/verify · `STORE` persistence · `CRYPTO` keys/signing · `LOC` location · `OBS` observability · `DIST` distribution/update · `TEST` testing.

### 8.1 Core runtime

| Package | Role | Consumers | D/T | License | Security / maintenance risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `react` + `react-native` (0.8x — **[FR]** Oct-2026 era; re-verify at pin) | UI runtime, new-arch Fabric/TurboModules | APP, UI | direct | MIT | Low (Meta). Upgrade cadence is the risk: stay ≤ 2 minors behind; Expo SDK pins the version anyway. | n/a | — |
| `expo` SDK 57 **[FR]** | Managed native modules, config plugins, build config (CNG) | APP | direct | MIT | Low. Expo Go is unusable for this app (no native BLE) — dev-client only; document so nobody wastes a day. | n/a | Bare RN (high cost, avoid) |
| `expo-dev-client` | Dev builds with custom native code | APP, TEST | direct | MIT | Low | n/a | — |
| `hermes` (bundled w/ RN) | JS engine | all JS | transitive | MIT | Low | n/a | — |
| `react-native-get-random-values` | `crypto.getRandomValues` polyfill (needed by noble fallback) | CRYPTO | direct | MIT | Low, tiny, stable | n/a | — |

### 8.2 UI

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `@shopify/flash-list` 2.3.3 **[FR]** | Recycled feed list (RecyclerView-class perf) | UI, FEED | direct | MIT | Low (Shopify). Rewritten for Fabric — verify on new-arch at integration. | No | `FlatList` (perf cliff on long feeds) |
| `expo-router` **or** `react-navigation` — pick ONE | Navigation | APP, UI | direct | MIT | Low either way. **Overlap flag:** do not install both. expo-router fits the Expo project; react-navigation if the team prefers explicit stacks. | No | — |
| `react-native-reanimated` | Feed animations, gesture-adjacent UI | UI | direct | MIT | Medium — native, version-locked to RN/Expo SDK; upgrades lag RN releases. | No | `Animated` API (jank risk) |
| `react-native-gesture-handler`, `react-native-screens`, `react-native-safe-area-context` | Standard Expo navigation prerequisites | UI | mostly transitive | MIT | Low | No | — |
| `@legendapp/state` **[FR]** | Reactive client state for feed/ranking | UI, FEED | direct | MIT | Low-Medium (small team, but established). Keeps feed updates off naive `useState` re-render storms. | No | zustand (simpler, less fine-grained) |

### 8.3 Domain / app

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `zod` | **CBOR event schema validation on receive** — trust-boundary enforcement (§11) | EVENT, MESH | direct | MIT | Low, pure JS | No — schemas are the contract | Hand-rolled validators (don't) |
| `ts-pattern` (optional) | Exhaustive matching on event/failure kinds | EVENT, APP | direct | MIT | Low | No | switch statements |

Keep this category deliberately thin — domain logic is first-party code, not dependencies.

### 8.4 Data / storage

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `op-sqlite` 18.2.5 **[FR]** **xor** `expo-sqlite` 57.0.4 **[FR]** — pick ONE | Event store (append-only), view-receipt dedup table, feed queries | STORE | direct | MIT | Low-Medium. op-sqlite is JSI-fastest; expo-sqlite is Expo-maintained. **Overlap flag:** installing both doubles native SQLite surface — choose at spike. | **Yes — `StorePort`**: `EVENT`/`FEED` never import the driver directly (crash-recovery and migration logic must survive a driver swap). | The other one |
| `react-native-mmkv` **v3.3.3** (pin at scaffold; evaluate v4.3.2 in a dev build, P5 at the earliest) | Config, duty-cycle state, seen-cache hot snapshot, counters | APP, STORE, MESH | direct | MIT | **Medium — MetaMask's 2026 v4→v3 revert incident (research: OSS_RESEARCH.md §4): do NOT start on v4.3.2.** JSI sync — do not store large blobs. | No | AsyncStorage (slow, don't) |
| `expo-secure-store` **or** `react-native-keychain` — pick ONE | Ed25519 private key at rest (Keychain / Keystore) | CRYPTO | direct | MIT / MIT | Low. **Keys live ONLY here** — never MMKV, never SQLite, never logs (§11). | **Yes — `KeyStorePort`** (biometric-gating and export/backup flows differ per impl). | The other one |
| `expo-file-system` | Crash-log export, identity backup file, release-notes cache | OBS, CRYPTO, DIST | direct | MIT | Low | No | `react-native-fs` (less Expo-integrated) |

### 8.5 Networking

Near-empty by design (ADR-08/ADR-09): no HTTP client library, no MQTT, no Airplane-operated
endpoints. The only network surface is **third-party Nostr relays over `wss`** (untrusted dumb
pipes — §10).

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| *(built-in `WebSocket`)* | Nostr relay publish/subscribe (`wss://`) for world-feed uplink/downlink | RELAY | n/a | n/a | Low — platform API. **Trust posture:** relays are untrusted; every received event goes through the standard EVENT-2 verify path; never trust relay bytes. | **Yes — `RelayTransportPort`**: the RELAY subsystem must not import WebSocket directly, so relay protocol handling stays swappable | — |
| *(built-in `fetch`)* | GitHub Releases poll for update check (§2.5-B) | DIST | n/a | n/a | None | No | — |
| `react-native-netinfo` (optional) | Distinguish "no internet" vs "radio off" in diagnostics UX; gate world-feed fetch attempts | OBS, UI, RELAY | direct | MIT | Low | No | Skip (infer from failures) |

### 8.6 Background

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `react-native-background-actions` 4.1.0 **[FR]** **xor** hand-rolled Kotlin FGS module — spike both | Android foreground service wrapper (scan/advertise while screen-on) | APP, MESH | direct | MIT | Medium — maintainer bus factor; **verify it declares `connectedDevice` FGS type correctly on Android 14+** (the munim-bluetooth fix of 2026-09-19 shows this is where libs break **[V]**). | **Yes — `ForegroundServicePort`**: `MESH` talks to an interface; swapping impls must not touch protocol code. | Hand-rolled native module (more control, more code) |
| `react-native-bluetooth-ble` v0.4.0 **[FR]** (Expo config plugin for background modes, `startBackgroundSession()`) | Candidate unified BLE stack (central+peripheral, GATT server, L2CAP) | MESH | direct | **[UNVERIFIED — check license before pinning]** | **High — newest, smallest community** of the three BLE candidates. Purpose-built for exactly this use case, which is why it's listed — but treat as spike-first. | **Yes — `BleTransportPort` (critical)**: `MESH` flood logic must be transport-agnostic; the BLE library is the single most-swappable component. | — |
| `react-native-ble-manager` 12.5.3 **[FR]** | Alternative BLE stack (TurboModule, peripheral/advertising support) | MESH | direct | MIT | Medium — established, but API is lower-level; more glue code. | Same port as above | — |
| `@sfourdrinier/react-native-ble-plx` 3.9.3 **[FR]** | Alternative BLE stack (new-arch fork, opt-in iOS restoration, Android FGS) | MESH | direct | Apache-2.0 (inherited) | Medium — fork of a revived upstream (3.5.1 **[FR]**, central-only upstream); fork health depends on one maintainer. | Same port as above | — |
| `expo-task-manager` | — | — | — | — | **Do not use for relay**: ~30 s background windows are useless for mesh relay **[FR]**. Listed only to forbid it. | — | — |

**BLE selection is the highest-dependency-risk decision in the project.** Exactly one of the three BLE libraries ships in v1; the other two are evaluated in the spike and then removed. The `BleTransportPort` adapter is non-negotiable.

### 8.7 Security

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `react-native-quick-crypto` (Margelo) | Native (C++/JSI) Ed25519 sign/verify, RNG | CRYPTO, EVENT | direct | MIT | Medium — native module, version-locked to RN; but Margelo's maintenance is strong and it documents Ed25519 one-shot sign/verify + `Ed` class **[V]**. | **Yes — `CryptoPort`** (see §1.1) | `@noble/curves` + `@noble/hashes` pure JS (audited, PGP-signed releases, npm provenance **[V]**; ~60 verify/sec — too slow for flood path, fine for own-signing) |
| `cbor-x` | CBOR encode/decode for wire events | EVENT, MESH | direct | MIT **[assumed — verify at pin]** | Low-Medium — pure JS, fast; **must run decode inside try/catch with strict schema validation after** (never trust received bytes). | No | `cbor` (slower, more deps) |
| `react-native-lz4` (mateoguzmana) | LZ4 compress/decompress for event batches | MESH, EVENT | direct | **[UNVERIFIED]** | **High — author marks it experimental, error handling still being polished** [V]. Spike: measure whether LZ4 on ≤ ~300-byte payloads even pays (likely not — gate compression on size threshold, e.g., only batch payloads > 1 KB). | **Yes — `CodecPort`** so LZ4 can be dropped to identity-codec without touching protocol. | Pure-JS `lz4js`-family (slow) / **no compression v1** (legitimate: tiny payloads) |
| `expo-crypto` | Random UUIDs, digests for non-identity uses | APP, STORE | direct | MIT | Low | No | quick-crypto |

### 8.8 Observability

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `@sentry/react-native` — **P5 only, opt-in** (not in v1) | Crash + error reporting with **offline event caching** (default 30 envelopes; Android flushes on restart, iOS on next event **[V]**) | OBS, APP | direct | MIT | **Medium — cloud touchpoint.** Ships only behind an explicit opt-in consent screen that names what leaves the device; aggressive redaction (no key material, no precise location, no message content — metadata only). | **Yes — `DiagnosticsPort`**: `OBS` writes to a local ring buffer always; Sentry is one *sink* behind the port, removable in one flag. | Local-only crash log + user-triggered export (share sheet) — **the v1 option** |
| Custom file/MMKV ring logger (first-party) | Offline diagnostics: counters, flood stats, lifecycle transitions | OBS | n/a | n/a | None — first-party | n/a | — |

**Decided (ADR-10):** v1 ships **local-only diagnostics** — structured ring buffer + user-triggered
log export (share sheet / file export). **No cloud crash reporter in v1.** Opt-in crash reporting
arrives in **P5** as a sink behind `DiagnosticsPort`: `@sentry/react-native` (Sentry-protocol;
self-hosted GlitchTip as the sink), gated by an explicit consent screen that names what leaves the
device (metadata only — no key material, no precise location, no message content; see §11.10
redaction rules). This resolves the v1 three-way contradiction (SYSTEM_DESIGN OBS-3's "(certain)"
+ upload-when-online vs this doc's local-only default vs ARCHITECTURE §7): the default at launch is
file-export, period. A builder implementing v1 from this doc must NOT bundle a cloud crash reporter.

### 8.9 Testing / dev

| Package | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `jest` + `@testing-library/react-native` | Unit + component tests (protocol logic, ranking, schema validation) | TEST | direct (dev) | MIT | Low | n/a | — |
| `maestro` | E2E on real devices (BLE flows need physical devices — emulators can't mesh **[FR]**) | TEST | direct (dev) | MIT/Apache | Low-Medium — maintained; drives real devices via cloud or local rig | n/a | Detox **[UNVERIFIED currency in 2026 — check before choosing]** |
| `typescript` (strict), `eslint`, `prettier`, `husky` + `lint-staged` | Type safety, hygiene | TEST/dev | direct (dev) | Apache/MIT | Low | n/a | — |
| Property/fuzz tests for `EVENT` decode (`fast-check`) | Adversarial CBOR inputs — the trust boundary deserves fuzzing | TEST | direct (dev) | MIT | Low | n/a | Hand-rolled corpus |

**Device lab is a testing dependency, not a package:** budget 2–3 Androids across OEMs (Pixel + Xiaomi/Samsung for OEM-kill behavior) + 1–2 iPhones **[FR]**. No emulator substitutes for BLE mesh validation.

### 8.10 Build / deploy

| Package/tool | Role | Consumers | D/T | License | Risk | Adapter? | Fallback |
|---|---|---|---|---|---|---|---|
| `eas-cli` + EAS Build | Production Android/iOS builds without local Mac; TestFlight submission | DIST | direct (dev) | MIT (CLI) / hosted service | Low-Medium — hosted build service is a *build-time* cloud touch, not a runtime one (acceptable under ADR-08; the artifact is verifiable). | n/a | Bare Gradle/Xcode locally |
| GitHub Actions | CI: typecheck, lint, test, release pipeline (§2.1) | DIST | n/a (CI) | n/a | Low | n/a | — |
| `fastlane` (optional) | Only if EAS proves insufficient for store submissions | DIST | direct (dev) | MIT | Low | n/a | EAS Submit |

### 8.11 Optional / experimental

| Package | Role | Status |
|---|---|---|
| `react-i18next` | i18n — **deferred** (gap §12). English v1. | Do not install until the i18n decision lands. |
| Accessibility | Mostly built-in (accessibility labels, dynamic type) — no library needed v1; audit as gap §12. | — |
| `expo-updates` | OTA channel — **excluded by §2.5 decision**. Do not install. | — |
| On-device ML (spam classifiers) | Speculative moderation aid — **not v1**; moderation v1 is user-driven (report/block/filter). | — |

### Overlap & supply-chain risk summary

1. **Three BLE stacks overlap** (ble-manager / sfourdrinier ble-plx / bluetooth-ble) — spike exactly one winner; the `BleTransportPort` adapter contains the blast radius of a wrong pick.
2. **Two SQLite drivers overlap** (op-sqlite / expo-sqlite) — same treatment via `StorePort`.
3. **Two secure-storage libs overlap** — pick one via `KeyStorePort`.
4. **Two routers overlap** — pick one, never both.
5. **Native Ed25519 vs pure-JS noble overlap is intentional** (primary/fallback) — contained by `CryptoPort`.
6. **react-native-lz4 is the riskiest pin**: experimental, unverified license, possibly unnecessary (tiny payloads). The `CodecPort` must allow shipping v1 with compression disabled.
7. **Supply chain:** exact pins + lockfile + Renovate; prefer npm-provenance-published deps; `npm audit` in CI (fail on high); the Android release key is the crown jewel — offline backup, never in git (§2.1). Sigstore signing of GitHub Release artifacts is a v2 hardening (gap §12).
8. **Bus-factor watch:** sfourdrinier ble-plx fork, react-native-background-actions, react-native-lz4, react-native-bluetooth-ble — all small-maintainer. The adapter ports (§8.6/8.7) are the mitigation: no protocol or product logic may import these directly.

---

## 10. Threat model (v2: mesh + world feed)

v1's threat model assumed pure offline. The World feed adds two new exposure surfaces (relay
operators, global readers) without changing the mesh core. Read §2.4 of ARCHITECTURE.md (privacy
model) as the normative statement; this section is the adversarial reasoning behind it.

### 10.1 Passive local observer — sees ALL mesh traffic content

BLE flood traffic is **plaintext by design**. A passive observer in radio range (a laptop with a
BLE sniffer at the protest) sees **every post's full content**, every receipt, every tombstone.
**Anonymity protects *who said it*, not *what was said*.** There is no content-confidentiality
mitigation in v1 and none is planned (it would contradict the public-broadcast product): the
mitigation is operational awareness, enforced by launch-gate UX copy (ARCHITECTURE.md §2.5 —
the composer must say "Everyone nearby can read this" before v1 ships). Corollaries:
- Never imply encryption exists — docs and UI say "anonymous", never "encrypted"/"private"
  for post contents (terminology discipline, §11.10).
- Geohash-5 cells are coarse (~4.9 km), but a reader of the feed can infer a poster's
  *presence in the area* at post time. Stable pseudonyms (§10 intro) make repeated presence
  linkable across posts. This is accepted and disclosed, not fixed.
- Traffic analysis (who relays when, correlation of timing) is not mitigated in v1 —
  documented gap, unchanged.

### 10.2 Relay IP↔post linkage (uplink)

On uplink, the relay operator sees the **uploader's IP address** next to the post's inner
Ed25519 pubkey (a stable pseudonym). Risks: IP↔pseudonym linkage by a hostile relay operator;
jurisdictional exposure of the uploader's ISP-assigned address. Mitigations, in order of
strength:
1. **Uplink is opt-in per post, default OFF** — the highest-risk posts (local protest
   coordination) simply never leave the mesh unless the author explicitly chooses.
2. **Deniability by design:** the phone that uplinks a post is *whichever online mesh member*
   relays it — not necessarily the author. The relay operator's IP log points at an uploader,
   and upload ≠ authorship. (This is a property, not a guarantee — a lone online phone in a
   mesh is still identifiable as *the* uploader.)
3. **No PII anywhere** to join to the pseudonym — no accounts, no phone numbers; the pubkey
   is linkable across posts but binds to nothing.
4. **Identity rotation:** "new identity" in settings severs the pseudonym chain going forward
   (old posts' tombstones become unauthorizable — disclosed in UX).
5. **Separate relay keypair** (secp256k1, Nostr-protocol) unlinkable from the mesh keypair by
   default; binding is opt-in and signed.
- **Tor is explicitly out of scope for v1** — deferred to post-v1 exploration (P5+). Rationale:
  Tor on mobile adds a large, fragile dependency for a benefit that matters only to the
  uplink path; the opt-in + deniability properties above are the v1 answer. Do not hand-wave
  it as "later" without the phase: **P5 exploration at the earliest.**

### 10.3 Malicious relays — can't forge, can withhold or spam

Relays are untrusted dumb pipes. The inner Ed25519 signature means a relay **cannot forge or
alter** a post (client verifies every downlinked event through the standard EVENT-2 path —
unverified bytes never reach the feed). What a malicious relay *can* do: withhold posts
(selective censorship), inject spam (unsigned junk is dropped at verify; signed spam from
fresh keys is the same abuse class as mesh spam), profile which IPs fetch what. Client
mitigations:
- **Multi-relay publish and fetch** (publish uplink to N relays, fetch world feed from N
  relays, dedupe by event ID) — no single relay is load-bearing.
- **Signature verification on everything** downlinked — the relay is never trusted, only
  transported.
- **User relay management** (F-13): add/remove relay URLs, relay blocklist, subscription
  filters — a bad relay is a user action away from removal.
- **Relay reputation scoring is deferred post-v1** (P5 research) — v1 relies on user
  curation, not algorithmic trust.

### 10.4 Relay takedowns — decentralization is the mitigation

Anyone can run a Nostr relay; the client ships multiple defaults and user-addable URLs. There
is **no Airplane-operated relay**, hence no single server to seize, subpoena, or §69A-block.
If a relay disappears, publish/fetch rotate to the next. Relay software and our event format
are both open, so migration is a config change, not a rewrite. (Standing external risk
remains G-11: GitHub-level action against the repo itself — sideload continuity plan in §2.)

### 10.5 World-feed amplification

The World feed takes local abuse (spam, illegal content) and gives it planetary distribution.
This is why **moderation is a sideload-launch gate, not a store-submission gate** (G-1): the
launch-gate set (per-key rate limits, local mute/block, per-post hide, keyword filter, relay
filtering hooks) must exist before any build that can uplink. Beyond the launch-gate set,
there is **no global moderation by design** — user-curated, not platform-moderated; stated
honestly in the product copy.

### 10.6 Device seizure / state-level adversary (promoted from P4 stub)

The protest use case implies motivated state actors; **seizure of an unlocked device is the
realistic attack** (M6). On-device exposure: the stable identity keypair (Keychain/Keystore),
the event store (received posts, including others'), view receipts (what you looked at).
v1 posture: keys in secure storage only (never MMKV/SQLite/logs); no PII to seize beyond the
pseudonym; user-initiated "new identity" rotation + app data wipe exist. **Panic-wipe /
duress flows are deferred post-v1** (P5 exploration) — the v1 answer is honest disclosure that
an unlocked seized device exposes the pseudonym and local feed history. Full seizure/duress
analysis belongs in `docs/threat-model.md` (M6, P1).

### 10.7 Summary — what Airplane protects

| Protected | Mechanism | Not protected (accepted, disclosed) |
|---|---|---|
| Who posted (identity) | Stable pseudonymous keypair; no accounts/PII; rotation | Linkability of the pseudonym across posts |
| Post integrity | Ed25519 inner signature; client-side verify | Relay withholding/spam (mitigated, §10.3) |
| Author vs uploader | Deniability: any online mesh member uplinks (§10.2) | Lone-uploader identifiability |
| Local posts staying local | Per-post opt-in, default OFF; no global switch | — |
| Post *content* confidentiality | **Nothing — public by design** | Readable by anyone in radio range / any relay operator |

**Terminology discipline (binding on docs and UI):** say **"anonymous"** (identity hidden).
NEVER "encrypted" or "private" for post contents. A post is public speech; the product hides
the speaker, not the speech.

## 11. Reliability / performance / security analysis

### 11.1 Resource & memory ownership

- **Owns its memory:** `STORE` (SQLite pages, MMKV), `MESH` (reassembly buffers, peer table, flood queues — all capped, §1.5), `FEED` (ranked window — paged, never the whole table).
- **Borrowed, never owned:** native BLE callback payloads are copied into JS-owned buffers immediately; no holding of native references across async gaps.
- **Leak risks (explicit):** (1) BLE scan callbacks registered without deregistration on lifecycle transitions — `MESH` must pair every `start` with `stop` in a state machine, not in ad-hoc UI handlers; (2) GATT connections to vanished peers — sweep timers close stale connections; (3) event-listener accumulation on re-renders — `UI` uses the reactive store, not manual subscriptions; (4) MMKV growth — counters are fixed keys; no per-event keys in MMKV (that's SQLite's job).

### 11.2 Concurrency

- JS is single-threaded: `EVENT` verification and `FEED` re-ranking must be **incremental and chunked** (process N events per tick, `setImmediate`/`InteractionManager` yields) so a flood burst can't jank the feed.
- Native callbacks arrive on arbitrary threads: the bridge serializes to JS, but `MESH` must treat callback order as *unordered* — dedup by event ID in `STORE` (idempotent upserts) makes ordering irrelevant.
- Signing (own post) goes through `CryptoPort.sign` async — never block the composer UI on key I/O.
- **Cancellation:** every in-flight GATT operation carries a generation counter; stale completions (peer gone, radio cycled) are dropped, not applied.

### 11.3 Backpressure

Flood path is the only place the network can outrun the device:

- **Inbound:** bounded queue (e.g., 1,000 datagrams). On overflow, drop policy: view-receipts first (regenerable, lowest value), then oldest by sender-timestamp, then — only under sustained overload — shed load by temporarily narrowing scan duty cycle. Every drop increments `OBS` counters (`flood.drop.inbound_overflow{reason}`) so congestion is *visible*.
- **Outbound per-peer:** bounded queue (64 frames/peer — designed value, SYSTEM_DESIGN.md §4.4 MESH-11). Drop-oldest with counter; a peer that is always full gets deprioritized in the next gossip round (don't waste radio on a deaf peer).
- **Store writes:** batch inserts in transactions (e.g., up to 200 events/txn); `busy_timeout` 5 s; WAL mode. A slow disk must not stall the radio — the inbound queue absorbs it, then the drop policy engages honestly.

### 11.4 Timeouts / retries / cancellation per boundary

| Boundary | Timeout | Retry | Cancellation |
|---|---|---|---|
| BLE connect (per peer) | OS-driven (~10–30 s); app gives up at 10 s | 3 attempts, exponential backoff + jitter; then peer cooldown (5 min) | On radio state change or peer vanished from scan |
| GATT read/write/notify | 5 s app-level | 2 retries for idempotent reads; **writes of flood batches are idempotent by event ID — safe to retry** | On disconnect |
| Flood rebroadcast | Jitter 50–500 ms before forward (de-synchronizes the mesh; BitChat-verified) | TTL-bounded: protocol constant **TTL 7, hard ceiling 7** (ADR-10) — validate crowd behavior in field tests | — |
| Event verify (CBOR decode + schema + signature) | Must complete < 10 ms p99 per event (native crypto); slow path logs | No retry — deterministic: invalid is invalid | — |
| GitHub Releases update poll | 10 s | Weekly schedule; manual trigger; no retry storm (backoff on failure) | On app background |
| SQLite txn | `busy_timeout` 5 s | Once, then surface to `OBS` and degrade (read-only feed mode) | — |
| Key load (secure storage) | 5 s | Once; failure = fatal to posting (not to reading) | — |

### 11.5 Error classification & recovery

- **Transient** (radio busy, peer vanished, scan throttled by OS): retry with backoff; never surface to the user beyond a subtle status dot.
- **Permanent-input** (bad signature, schema violation, oversize payload): drop + count + (for repeat offenders) per-key throttling. These are *expected* on an open mesh — adversarial input is the norm, not the exception.
- **Permanent-system** (permission revoked, radio off): dormant state + fix-it UI (§1.6).
- **Fatal** (SQLite unreadable, key unrecoverable): recovery paths in §O. The app must always *read* (cached feed) even when it cannot *write* or *relay*.

### 11.6 Crash recovery — the event store is the source of truth

On restart: clean-shutdown marker? No → `PRAGMA integrity_check` → if healthy, replay last cursor into `FEED`; flood queues rebuild from the store (anything un-acked is re-gossipable — append-only + idempotent upserts make this safe). If corrupt → §O recovery (rename aside, recreate, resync from mesh). **No in-memory-only state may be load-bearing**: seen-cache, queues, and ranking inputs must all be rebuildable from SQLite + MMKV snapshots.

### 11.7 Idempotency / consistency / cache invalidation

- **Idempotency:** every event has a globally unique ID (`key_id || seq` — crypto worker's format, ops requires uniqueness + monotonic per-key seq). `STORE` upserts on ID; the seen-cache is an LRU of IDs. Receiving the same event 50 times (normal in flooding) costs one dedup lookup.
- **View receipts:** deduped on `(viewer_key, post_id, 24 h window)` — replays outside the window are dropped; inside the window, counted once.
- **Consistency:** append-only event log; no updates, no deletes (a "delete" is a tombstone event — protocol decision, mesh worker). Ranking is a pure function of (events, receipts, now) — recompute, never mutate-then-patch.
- **Cache invalidation:** the only caches are the ranked window (invalidated on new event batch or 30 s tick) and the seen-LRU (self-invalidating by cap). No stale-cache class of bug is possible if nothing else is cached.

### 11.8 Dependency failures

- **BLE off / permission denied:** dormant mode (§1.2, §1.6). Feed still reads from store.
- **Secure-storage unavailable** (e.g., device lock state edge cases): read-only mode — can verify others' events (public keys are in the events) but cannot sign own posts; UI explains why.
- **Disk full:** prune aggressively (§1.5), refuse new writes with a banner, never crash on `SQLITE_FULL`.
- **GitHub unreachable:** update check silently skips; Obtainium handles its own retries. The mesh never depends on it.

### 11.9 Trust boundaries — never trust received bytes

1. **Wire → `EVENT`:** CBOR decode in try/catch → `zod` schema validation (field types, sizes, seq monotonicity, timestamp sanity window) → Ed25519 verify against the claimed public key → *only then* `STORE` insert and `UI` render. A single failed stage drops the datagram. Fuzz this boundary (`fast-check`, §8.9).
2. **Store → `UI`:** render only from validated rows; defense in depth (a corrupt DB shouldn't become an XSS-equivalent — text is rendered as text, no HTML injection surface in RN, but link handling must not auto-open).
3. **Peer → `MESH`:** peer-supplied metadata (RSSI, claimed capabilities) is *hint*, never *authority*.
4. **Update channel → `DIST`:** APK asset verified by Android's package signature on install (same-key requirement); additionally verify SHA-256 against the release's `SHA-256SUMS` before prompting install.
5. **Relay → `EVENT` (world feed):** relay bytes are *less* trusted than mesh bytes, not more. Every downlinked event goes through the identical EVENT-2 verify path (size → schema → kind → geohash → timestamp → id → Ed25519) before `STORE`/`UI`; the relay's transport framing is validated and discarded. A relay can only *deliver* bytes; it can never *authorize* them.

### 11.10 Privacy model, least privilege, secrets, input validation, log redaction

- **Privacy model (binding, v2):** post *contents* are public by design — never encrypted, never
  "private". What is protected is *identity*: no accounts, no phone numbers, no PII; the stable
  per-device Ed25519 keypair is a pseudonym (linkable across posts, user-rotatable via "new
  identity"; rotation orphans old tombstones — disclosed in UX). Relay identity is a separate
  Nostr secp256k1 keypair, unlinkable by default. Full threat reasoning: §10.
- **Terminology discipline (binding on docs and UI copy):** say **"anonymous"** (identity
  hidden). NEVER "encrypted" or "private" for post contents. A post is public speech; the
  product hides the speaker, not the speech.
- **Least privilege:** request the minimal permission set per OS (§1.6); no location permission on Android 12+; no contacts/camera/mic — ever. The FGS does one thing (BLE relay) — no piggybacked work.
- **Secrets:** Ed25519 private key in Keychain/Keystore only (§8.4). No key material in MMKV, SQLite, logs, crash reports, or backups. GitHub Actions secrets for the *signing* keystore, never the *identity* key (identity keys never leave the device — except via the explicit export flow, gap §12).
- **Input validation:** §11.9 — plus hard size caps (post text ≤ N chars, event ≤ N KB — protocol constants, mesh worker; ops enforces at the boundary).
- **Log redaction:** the `OBS` ring buffer and Sentry scrub: private keys, exact GPS (coarse-or-nothing), peer MACs/identifiers beyond truncated hashes, message content in the default config. A `redact()` pass is mandatory before any diagnostic leaves the device.

### 11.11 Provisional performance targets (all need physical-device validation)

Stated as targets, not claims:

| Metric | Target (to validate) | Notes |
|---|---|---|
| Cold start to interactive feed | < 2 s, mid-range Android (Pixel 6a-class) | Lazy-load feed window; defer BLE start until after first paint |
| Post propagation, dense crowd | 1 post → 50 nearby peers < 30 s | Depends on TTL/jitter tuning; crowd-test required |
| Event verify throughput | > 500 events/s sustained (native Ed25519) | Pure-JS fallback would collapse here — validates the `CryptoPort` primary choice |
| Foreground mesh battery | ≤ 8 %/h on Pixel-class with default duty cycle — **P5 stretch target**; the **P0 GO gate is ≤ 20 %/h** (ADR-10) | **Highest-uncertainty number in this doc** — measure, don't assume |
| Store write | p99 < 5 ms per event (batched txns) | op-sqlite JSI should clear this easily |
| Feed scroll | 60 fps on 2-year-old devices | FlashList + Fabric; validate with release builds, not dev |

---

## O. Failure propagation & recovery

| Failure | Blast radius | Containment | Recovery |
|---|---|---|---|
| **BLE radio off** | `MESH` only. Feed reads from `STORE`; posting queues locally. | Dormant state; no retry spin; one fix-it banner. | User re-enables → `MESH` resumes; queued own-posts flood on next peer contact. |
| **OS kills background task** (OEM battery manager / iOS jetsam) | Relay stops; device becomes leaf-only until next launch. Rest of app unaffected next launch. | FGS `START_STICKY` (Android); state restoration opt-in (iOS). Neither guaranteed — **accepted** (ADR-07). | Next app launch resumes full mesh; missed events re-flood from neighbors (append-only store). UX: onboarding explains OEM whitelisting; deep-link to battery settings on Xiaomi/Oppo/Vivo/Samsung. |
| **Corrupt event received** (bad CBOR / schema / signature) | One datagram. | Drop + count at the `EVENT` boundary (§11.9); per-key throttle on repeats. | None needed — mesh redundancy delivers valid copies via other paths. |
| **SQLite corruption** | `STORE` reads/writes; feed goes stale; posting disabled. | Startup `integrity_check`; on failure, quarantine (rename `airplane.db` → `airplane.db.corrupt.<ts>`), recreate schema. | Resync from mesh (events re-flood; receipts regenerate). Own identity key is in secure storage, unaffected. Report via `OBS` (local log + opt-in Sentry). |
| **Key loss** (uninstall on Android wipes Keystore; device loss; secure-storage failure) | Identity only: old posts remain verifiable (public key embedded), but user can no longer post *as that identity*. View history tied to key is orphaned. | Never auto-generate a *replacement* silently — that forks identity confusingly. | **Gap-driven** (§12): v1 = explicit "new identity" flow with honest copy ("your old posts stay, but aren't yours anymore"); v2 = encrypted export/backup + key rotation events. |
| **Clock skew** (affects `score = log(views)/age^gravity`) | Ranking distortion: future-dated events rank too high; past-dated vanish. | Trust boundary: sender timestamp must be within `[now − retention − skew, now + 5 min]` (retention-aligned window, SYSTEM_DESIGN.md §4.5 EVENT-2) or the event is dropped; **age for ranking uses local receive-time**, not sender timestamp. | Self-healing as skewed events age out; per-key seq ordering (not timestamps) for causality. |
| **Dense-crowd congestion collapse** (hundreds of peers, broadcast storm) | `MESH` throughput; battery; UI jank if unbounded. | Backpressure (§11.3): inbound cap + drop policy (receipts first), gossip subset (forward to k random peers, not all), TTL cap, adaptive duty-cycle tightening under sustained overload. | Automatic: load-shedding is the steady state, not an alarm. `OBS` counters make it tunable. Crowd-test to set k and caps. |
| **Relay unreachable / malicious** (world feed only) | World feed goes stale; mesh feed unaffected (NF-9). A withholding relay silently censors; a spamming relay injects signed junk. | Multi-relay publish/fetch (no single relay load-bearing); client-side Ed25519 verify on everything downlinked; user removes the relay (F-13). Uplink retries on backoff, never blocks mesh. | Switch defaults / user adds relays; mesh continues offline regardless. |
| **Uplink IP↔post linkage** (threat, not failure) | A hostile relay operator links uploader IP to the post's pseudonym (§10.2). | Opt-in per post (default OFF); deniability (any online mesh member uplinks, not necessarily the author); no PII anywhere; identity rotation; Tor explicitly deferred to post-v1 exploration (P5+). | User rotates identity ("new identity"); posts stay local unless re-opted. |
| **Storage full** | `STORE` writes; then `OBS` ring buffer; app must not crash. | Proactive prune at 80 % of quota (§1.5); on `SQLITE_FULL`, read-only feed mode + banner. | User frees space or adjusts retention setting → resume writes. Never delete the identity key or config to make room. |

---

## 12. Gap report

Every gap has a **named owner** (audit I15). Where no team exists yet, the owner is Tuba (PM) —
a name, not a subsystem, so there is always a human on the hook.

| # | Gap | Impact / Severity | Recommended solution | Priority | Phase | Owner |
|---|---|---|---|---|---|
| G-1 | **Moderation story for an anonymous public feed.** Spam, abuse, and illegal content *will* appear in a protest/concert feed; anonymity removes account-level levers; the World feed amplifies abuse globally. This is the product's existential risk (and the core of the Apple 1.2 / Play review problem). | **Critical** | **Sideload-launch gate (built P4, required before any shippable build — v1 launches via sideload, so this gates v1 itself, not store submission):** per-key rate limits (enforced at ingest), local per-post hide/report, per-key mute/block, keyword filters, relay-level filtering hooks (relay blocklist + subscription filters, F-13). Acceptance bar (ARCHITECTURE.md §3 F-16): a protest-density feed stays usable under adversarial spam. Protocol: hide/mute state is local-only in v1 (no global takedown — there is no global). Document the philosophy honestly: user-curated, not platform-moderated. v2+: web-of-trust / crowd-moderation research. | Critical — launch gate | P5 | **Tuba (PM)** + UI subsystem |
| G-2 | **Key rotation & identity export/backup.** No rotation protocol; Android uninstall = identity death (§O). v2 identity decision (ADR-10) makes this load-bearing: stable per-device keypair is the trust root. | High | v1: "new identity" flow in settings (honest copy: old posts stay, tombstones become unauthorizable) + encrypted export (QR / file) of the seed with explicit user action; v2: rotation event type (old key signs "moved to new key"). Never cloud backup. | High | P2 (export) / post-v1 (rotation event) | **Tuba (PM)** + CRYPTO subsystem |
| G-3 | **Crash diagnostics — DECIDED (ADR-10).** | High | **v1: file-export diagnostics only** (local ring buffer + user-triggered export). **P5: opt-in reporting** (Sentry-protocol sink behind `DiagnosticsPort`, consent screen naming what leaves the device; SYSTEM_DESIGN.md OBS-3 is Worker 2's to reconcile). Default at launch is local-only, period. | Decided | v1 done / P5 opt-in | **Tuba (PM)** + OBS subsystem |
| G-4 | **Store-review narrative.** Apple 1.2 anonymous-chat risk; Play UGC + FGS declarations. | High | Moderation UX (G-1) + framing ("public broadcast feed", no DMs) + reviewer demo path + sideload continuity plan (§2.4). Attempt only after G-1. | High | P5 | **Tuba (PM)** |
| G-5 | **Update-mechanism completeness.** Obtainium covers Android; iOS depends on TestFlight 90-day refresh discipline. | Medium | In-app update check (§2.5-B) as convenience; automated 60-day TestFlight refresh job; document both in-repo. | Medium | P6 | **Tuba (PM)** + DIST subsystem |
| G-6 | **Release-artifact integrity beyond APK signatures.** No Sigstore/Rekor attestation on GitHub Releases today. | Medium | v2: sign `SHA-256SUMS` with a release key (Sigstore) and verify in the in-app updater (§11.9-4 already does checksum; attestation is the upgrade). | Medium | P6 | **Tuba (PM)** + DIST subsystem |
| G-7 | **Accessibility.** Dynamic type, TalkBack/VoiceOver labels on feed actions, contrast. | Medium | Audit pass before v1; no new deps needed (built-in APIs). | Medium | P2 | **Tuba (PM)** + UI subsystem |
| G-8 | **i18n deferred.** English-only v1 excludes much of the target user base (India). | Medium | String-externalization discipline from day one (no hardcoded UI strings) so `react-i18next` drops in later. | Medium | P2 | **Tuba (PM)** |
| G-9 | **Sybil / view-receipt gaming.** Views-based ranking is gameable by key-spinners; receipts are cheap to forge at scale. | Medium-High | v1: per-key rate limits on receipts (now *meaningful* under the v2 stable-identity decision — ADR-10), 24 h dedup window, log-scale scoring dampens linear gaming. **Raw receipts are never uplinked** — world feed carries the mesh view-count snapshot only (§10). v2: proof-of-proximity / peer-witnessed receipts (research). Ranking math: FEED subsystem; rate-limit enforcement points: MESH/EVENT. | Medium-High | P5 | **FEED subsystem** (math) + **Tuba (PM)** (enforcement points) |
| G-10 | **Physical-device validation.** Every perf target in §11.11 and every background behavior in §1.2 is unvalidated until the device lab exists. | High (process) | Stand up the lab (§8.9) before the BLE spike concludes; make "validated on device" a merge gate for `MESH` changes. Retires the ASSUMPTION tags (see docs/assumption-register.md). | High | P0 (ongoing process) | **Tuba (PM)** + MESH/TEST subsystems |
| G-11 | **India §69A enforcement scope.** Bitchat/Briar/Bridgefy were pulled from Indian stores Oct 3 2026 under §69A; GitHub repo takedown requests were reported Jul 2026 **[FR]**. An India-built anonymous mesh app faces genuine distribution risk. | High (external) | Sideload-first *is* the mitigation (no store to be pulled from); keep source mirrored across named forges (Codeberg mirror pre-P5 — audit I12); APK mirror + release-asset backup; legal counsel before any Play India listing. Not solvable in code — tracked as a standing risk. | High | ongoing (awareness) | **Tuba (PM)** |
| G-12 | **OEM background-kill variance.** Xiaomi/Oppo/Vivo/Samsung kill FGS aggressively; behavior differs per MIUI/OneUI version. | Medium | Whitelisting guidance UX + `OBS` telemetry on service-death rate per OEM (opt-in) to prioritize workarounds. | Medium | P3 / P5 | **Tuba (PM)** + MESH/APP subsystems |
| G-13 | **World-feed / relay risks (new in v2).** Relay IP↔post linkage (§10.2); relay operator profiling of fetch patterns; default-relay choice as implicit trust; world-feed spam amplification beyond local mesh. | High | IP-linkage: opt-in per post default OFF + deniability (§10.2); Tor explicitly deferred to post-v1 exploration (P5+). Defaults: ship ≥3 independent relays, multi-relay publish/fetch. Abuse: G-1 launch-gate set covers world feed via relay filtering hooks. Relay reputation scoring deferred to P5 research. | High | P4 | **Tuba (PM)** + RELAY subsystem |

---

## 13. Architecture Decision Records

### ADR-01 — React Native + Expo over Flutter

- **Context:** Cross-platform UI framework for an offline-first BLE mesh feed. Candidates evaluated 2026-10-10 by three research agents (framework research doc): RN+Expo 7/10, Flutter 6/10, KMP 6/10.
- **Options:** (a) React Native + Expo SDK 57 dev client + EAS Build; (b) Flutter 3.41+; (c) Kotlin Multiplatform + Compose Multiplatform.
- **Decision:** (a) React Native + Expo.
- **Rationale:** Healthiest 2026 BLE plugin layer of any cross-platform option (ble-manager 12.x, sfourdrinier ble-plx 3.9.x, purpose-built react-native-bluetooth-ble 0.4.0); feed + local DB are solved problems (FlashList, op-sqlite, MMKV); largest JS/TS hiring pool and closest to the team's skills; EAS keeps shipping sane without a Mac.
- **Trade-offs:** iOS background BLE limits and ~30–40% native Swift/Kotlin share are identical under any framework — RN buys no advantage there. New-arch (Fabric/TurboModules) migration sharp edges remain in some libs.
- **Consequences:** ~70–80% of code in TypeScript; radio hot path stays native or library-owned; Expo Go cannot be used (dev-client only); OTA via EAS Update is available but declined (§2.5).
- **Risks:** BLE library bus factor (mitigated by `BleTransportPort`, §8.6); Expo SDK upgrade cadence (3/year — take every one, never skip).
- **Reconsider if:** the BLE spike shows all three RN BLE stacks inadequate for peripheral+GATT-server+L2CAP on both OSes while a Flutter/KMP path proves solid on device — framework is in service to the radio, not the reverse.

### ADR-02 — BLE GATT only (no Wi-Fi Direct / Multipeer interop)

- **Context:** Mesh transport options: BLE GATT mesh, Wi-Fi Direct (Android-only), Multipeer Connectivity (iOS-only, no background).
- **Options:** (a) BLE GATT only; (b) BLE + Wi-Fi Direct on Android + Multipeer on iOS; (c) Wi-Fi-based primary.
- **Decision:** (a) BLE GATT only for v1.
- **Rationale:** Wi-Fi Direct is Android-only, its RN library ecosystem is stale; Multipeer does not run in background on iOS, so it can't serve the pocket-relay case anyway. BLE is the only transport that exists on both OSes with background modes. One transport = one security boundary, one test matrix, one battery model.
- **Trade-offs:** Lower bandwidth than Wi-Fi Direct (fine — payloads are tiny); iOS↔Android background discovery gap is unavoidable (accepted, ADR-07).
- **Consequences:** Protocol designed around ~MTU-sized fragments, L2CAP where available; no cross-transport identity bridging needed.
- **Risks:** If BLE throughput proves insufficient for crowd densities in testing, there is no fallback transport in v1.
- **Reconsider if:** device testing shows BLE-only cannot sustain the target crowd density, or a maintained Wi-Fi Direct RN library emerges — then add it as a second `BleTransportPort`-style transport, Android-only, opportunistic.

### ADR-03 — Append-only signed events, no CRDT v1

- **Context:** Data model for posts propagating over an unreliable flood mesh with no server and no coordination.
- **Options:** (a) Append-only log of signed immutable events; (b) CRDTs (OR-Set/LWW-Map) for mutable shared state; (c) Mutable records with last-writer-wins.
- **Decision:** (a) Append-only signed events. State changes (edits, deletes, mutes) are new events (tombstones), never mutations.
- **Rationale:** A flood mesh gives at-least-once, unordered, duplicated delivery — the exact semantics append-only + idempotent upserts handle trivially. CRDTs add merge complexity and larger payloads for no v1 benefit: the product is a broadcast feed, not collaborative editing. Every event is self-verifying (Ed25519), so any peer can validate without trusting the relay path.
- **Trade-offs:** Storage grows monotonically (mitigated by pruning policy, §1.5); "edit" UX is a superseding event, not a true edit.
- **Consequences:** `STORE` is insert-only in the hot path; ranking is a pure function over the log; crash recovery is replay (§11.6).
- **Risks:** Unbounded growth if pruning is misconfigured — the size cap is a reliability requirement, not a nice-to-have.
- **Reconsider if:** v2 features (threads, reactions-as-state, collaborative lists) need merge semantics — then introduce CRDTs per-feature, not as the base layer.

### ADR-04 — Views-based ranking with receipts

- **Context:** Feed ordering without likes, without a server, without accounts. Product requirement: ranked by views.
- **Options:** (a) View receipts: viewers emit signed "saw post X" receipts, deduped per (viewer, post, 24 h), score = log(views)/age^gravity; (b) Like-equivalents; (c) Pure chronological; (d) Server-computed (impossible — no server).
- **Decision:** (a) View receipts with log-scaled decay.
- **Rationale:** Views are the only engagement signal obtainable passively in a broadcast mesh; log scaling dampens Sybil-inflated linear gaming; the 24 h dedup window bounds receipt storage; decay keeps the feed fresh without central curation.
- **Trade-offs:** Gameable by key-spinners (accepted v1 risk, G-9); receipts add mesh traffic (shed first under backpressure, §11.3); "views" in an anonymous system are approximate by nature.
- **Consequences:** `FEED` ranking is a pure function of (events, receipts, now); receipts are the lowest-priority flood traffic; per-key receipt rate limits are an ops enforcement point.
- **Risks:** Ranking manipulation in adversarial settings (protests) could drown signal — v2 needs peer-witnessed receipts or web-of-trust weighting.
- **Reconsider if:** measured gaming in real deployments distorts feeds, or receipt traffic exceeds ~30% of mesh bandwidth — then revisit signal design (v2).

### ADR-05 — SQLite + MMKV

- **Context:** On-device persistence: event log + dedup tables + config + counters, fully offline.
- **Options:** (a) SQLite (op-sqlite or expo-sqlite) + MMKV; (b) WatermelonDB; (c) Realm; (d) AsyncStorage only.
- **Decision:** (a) SQLite + MMKV.
- **Rationale:** SQLite is the right tool for the event log (indexed queries, transactions, idempotent upserts, integrity_check for crash recovery); MMKV is the right tool for small synchronous config/counters (JSI, no async bridge hop). WatermelonDB is ~14 months stale (2026) **[FR]**; Realm was EOL'd Sep 2025 **[FR]**; AsyncStorage is too slow for the hot path.
- **Trade-offs:** Two storage systems to operate (mitigated by `StorePort` + strict key discipline: bulk data in SQLite, scalars in MMKV, secrets in neither).
- **Consequences:** WAL mode, batched transactions, pruning policy (§1.5); MMKV holds only fixed keys.
- **Risks:** Driver choice (op-sqlite vs expo-sqlite) still open — spike it; corruption recovery path must be tested, not just written (§O).
- **Reconsider if:** the SQLite driver spike fails on either OS — the `StorePort` adapter exists precisely so the driver can change without touching `EVENT`/`FEED`.

### ADR-06 — Sideload-first distribution

- **Context:** How users get the app given: no backend, Apple Guideline 1.2 anonymous-chat risk, India §69A takedowns of Bitchat/Briar/Bridgefy (Oct 2026).
- **Options:** (a) Sideload-first (GitHub Releases APK + Obtainium; TestFlight for iOS); (b) Stores-first (Play + App Store); (c) Stores-only.
- **Decision:** (a) Sideload-first; stores secondary and conditional.
- **Rationale:** The product's threat model *includes* store removal — designing distribution around stores makes the primary risk unmitigable. Sideloading (Android) and TestFlight (iOS) keep the project shippable under takedown pressure; Obtainium gives sideloaded Android a real update channel; stores remain a reach channel once the moderation story (G-1) exists.
- **Trade-offs:** Higher install friction (unknown-sources prompt, Obtainium as a second install); no store discovery; iOS capped by TestFlight's 90-day expiry and 10k external testers; in-app update check must be hand-built (§2.5-B).
- **Consequences:** Release pipeline (§2.1), Obtainium docs, monotonic `versionCode` enforcement, fast-forward-as-rollback (§2.6), offline keystore backup discipline.
- **Risks:** TestFlight review can still reject (1.2); GitHub itself received takedown requests for mesh-chat repos in Jul 2026 **[FR]** — mirror source across forges (G-11).
- **Reconsider if:** store review posture changes (guideline revision) or sideload friction demonstrably blocks adoption — then promote stores to co-primary, keeping sideload as the continuity channel.

### ADR-07 — Foreground-first mesh (background best-effort)

- **Context:** Can the mesh relay while the app is backgrounded? (See §1.2 for the OS truth table.)
- **Options:** (a) Foreground-first: full mesh in foreground, best-effort background; (b) Promise background relay as a core feature.
- **Decision:** (a) Foreground-first.
- **Rationale:** iOS background BLE is OS-crippled (overflow-area advertising invisible to Android, throttled scans, no guaranteed relaunch); Android background depends on OEM battery managers that kill foreground services on large market segments. Promising (b) would be dishonest and would generate 1-star "doesn't work in pocket" reviews for a physics problem. The product's core scenarios have the phone in active use anyway.
- **Trade-offs:** Pocket-relay density is lower than the ideal; iPhones contribute less as relays when backgrounded — **treat Android as the relay backbone, iOS as opportunistic** [FR].
- **Consequences:** UX never promises background delivery; duty-cycle and FGS work still ships (best-effort is worth having); protocol uses 16-bit service UUID + filter-scanning so backgrounded iOS devices remain discoverable iOS-to-iOS.
- **Risks:** Users will expect background relay regardless — messaging and onboarding must set the expectation explicitly.
- **Reconsider if:** iOS background BLE behavior materially improves in a future iOS release (validate on device, never on release notes alone).

### ADR-08 — No backend / cloud

- **Context:** Whether any server component exists (relay, directory, updates, analytics, crash reporting).
- **Options:** (a) No backend at all; (b) Minimal backend (update server, crash ingestion); (c) Full backend.
- **Decision:** (a) No backend. GitHub Releases is static file hosting, not our infrastructure; EAS Build is build-time tooling, not runtime.
- **Rationale:** The product's reason to exist is operating where networks are hostile or absent; a server is a single point of failure, a seizure target (§69A), and a trust liability for an anonymity product. Every proposed server function has a serverless answer: discovery (BLE scan), updates (Obtainium + in-app GitHub poll), diagnostics (local log + opt-in export).
- **Trade-offs:** No OTA JS updates (accepted — most fixes are native anyway); no server-side analytics (diagnostics are opt-in and local-first); update propagation is slower than push.
- **Consequences:** §2.5 (no EAS Update / self-hosted OTA); §8.8 (Sentry only opt-in, local-first diagnostics default); the release pipeline is the only "ops infrastructure" and it's CI, not production.
- **Risks:** Slower incident response (fast-forward hotfix is the only lever — the pipeline must stay < 30 min); temptation to add "just one endpoint" later — this ADR is the backstop.
- **Reconsider if:** a hard requirement emerges that is *provably* impossible without a server (none identified in v1 scope) — and then only with a threat-model review, not convenience.

**v2 clarification (no decision change):** "no backend" means **no Airplane-operated server
component**. Third-party Nostr relays used as untrusted dumb pipes for the World feed are not
our infrastructure — see ADR-09 for how the two coexist.

### ADR-09 — Hybrid transport: local-first mesh + opportunistic global relay

- **Context:** v1 assumed pure offline: a Delhi protest would be invisible in Mumbai, and a
  tourist with full bars in a dead-zone mesh saw nothing beyond radio range. Product correction
  (2026-10-10, Tuba): keep the mesh local-first, add an opportunistic global layer so
  internet-connected viewers can also see posts relayed from meshes everywhere.
- **Options:** (a) **Pure offline** (v1 model — mesh only, no global layer); (b) **Hybrid over
  standard Nostr relays** (third-party `wss` relays as dumb pipes; our Ed25519-signed events
  make relays untrusted by design); (c) Hybrid over **Airplane-run custom relays** (our
  servers, our protocol); (d) **Federation** (Airplane-run servers that federate like
  Mastodon/ActivityPub).
- **Decision:** (b) Hybrid over standard Nostr relays. "Around you" = BLE mesh feed (unchanged,
  always works, zero internet). "World" = client-side downlink from public relays + uplink of
  mesh posts by any online mesh member. Uplink is **opt-in per post at compose time, default
  OFF**; no global "always uplink" switch in v1.
- **Rationale:** (a) leaves the product's best stories (protest seen worldwide) untold and
  cedes the "world" to centralized social apps — the correction is product, not vanity. (c)
  and (d) reintroduce exactly what ADR-08 exists to kill: an Airplane-operated server is a
  seizure target, a §69A target, and a trust liability for an anonymity product. (b) keeps
  every property that matters: relays can't forge (Ed25519 inner signatures, client-side
  verify), anyone can run one (no single takedown target), and the protocol already exists
  (standard Nostr relays — no new protocol to design, audit, or maintain). The mesh stays the
  soul; the internet is an opportunity, never a dependency (NF-9).
- **Trade-offs:** Relay operators see uploader IPs (IP↔post linkage — §10.2; mitigations:
  opt-in default-off, deniability of upload≠authorship, no PII, rotation; Tor deferred to
  post-v1 exploration, P5+). World feed amplifies abuse globally (§10.5 — moderation is a
  launch gate, G-1). View counts on the world feed are approximate by construction (mesh
  view-count snapshot, recency-primary ranking; raw receipts never uplinked — anti-gaming +
  viewer-privacy). Relay availability/retention policies are third-party and untested (new
  unknown, §"Highest-risk unknowns"). Relay identity is a separate secp256k1 keypair
  (Nostr-protocol requirement), unlinkable from the mesh keypair by default.
- **Consequences:** New RELAY subsystem (uplink publisher, Nostr downlink fetcher, relay
  manager — RELAY-* defined in SYSTEM_DESIGN.md §1); new FRs F-11…F-14; relay
  management UX (add/remove/blocklist); per-post locality indicator; the event's uplink flag
  is part of the signed payload.
- **Risks:** A hostile or compelled relay operator profiles upload/fetch IPs; default-relay
  choice is implicit trust (mitigated by multi-relay defaults + user curation); Nostr relay
  operators could rate-limit or drop our event kinds (mitigated by multi-relay + the mesh
  remaining fully functional).
- **Reconsider if:** standard Nostr relays prove unusable in practice (widespread kind-based
  blocking, hostile retention) — then revisit (c) as *community-run* (never Airplane-run)
  relays speaking the same protocol, not a custom backend. Revisit the opt-in default only
  with an explicit product decision and a threat-model review — never silently.

### ADR-10 — Frozen v2 protocol constants + crash-reporting + identity decisions

- **Context:** The 2026-10-10 audit found 25 contradictions across the blueprint, including on
  *frozen wire constants* (TTL as 7/8/16/6, jitter 50–500 vs 50–250 ms, battery 20/8/5 %/h,
  MMKV v3.3.3 vs v4.3.2) and two privacy-critical undecided defaults (crash reporting in three
  docs with three answers; per-post throwaway keys making tombstones/rate-limits meaningless).
- **Decision 1 — frozen v2 constants (wire-affecting values are PROTO_VER 1 interop
  commitments; tunables remain tunable):**
  - `DEFAULT_TTL = 7`, **hard ceiling 7** (adopting BitChat's verified ceiling).
  - `FLOOD_JITTER_MS = 50–500` ms uniform per rebroadcast (BitChat-verified).
  - Battery: **≤ 20 %/h foreground mesh = P0 GO gate**; 8 %/h = P5 stretch target.
  - `react-native-mmkv` pinned **v3.3.3** at scaffold (MetaMask 2026 v4→v3 revert incident);
    v4.3.2 evaluation deferred to P5 dev builds.
  - These supersede: ROADMAP.md Q12 (8/max-16 → P1 property-test variables only),
    OPERATIONS.md §11.4 ("suggestion 6", "50–250 ms"), OPERATIONS.md §8.4 (4.3.2 pin),
    ARCHITECTURE.md §3 NF-4/NF-5 (3 s cold start → 2 s interactive feed).
- **Decision 2 — crash reporting, decided once:** **v1 ships file-export diagnostics only**
  (local ring buffer + user-triggered export; zero cloud). **Opt-in reporting arrives in P5**
  (Sentry-protocol sink behind `DiagnosticsPort`; consent screen naming what leaves the
  device; aggressive redaction). This resolves SYSTEM_DESIGN.md OBS-3 vs OPERATIONS.md
  §8.8/G-3 vs ARCHITECTURE.md §7 (Worker 2 reconciles OBS-3's text).
- **Decision 3 — identity model (privacy):** **stable per-device Ed25519 keypair**, generated
  on first launch, stored in Keychain/Keystore via `KeyStorePort` (Worker 2 specs the
  mechanism). Rationale: tombstones need authorship continuity; receipt-dedup needs stable
  viewer keys; per-key rate limits need stable keys — throwaway-per-post keys make all three
  meaningless. Trade-off: the stable key is a *pseudonym* linkable across posts by anyone;
  no PII is bound to it; the user can rotate via "new identity" in settings, which orphans
  old posts' tombstones (disclosed in UX). Relay identity is a **separate Nostr secp256k1
  keypair** (protocol requirement), unlinkable by default; optional signed binding event for
  users who want continuity.
- **Trade-offs:** Freezing constants early trades tuning flexibility for interop safety —
  correct trade: these values are hard to change after P3 radios ship, cheap to get right
  from BitChat's verified numbers now. The identity decision trades unlinkability
  (throwaway keys) for accountability primitives (tombstones, rate limits, dedup) — the
  product cannot function as designed without the latter; rotation is the escape hatch.
- **Risks:** If P0/P3 field measurements show 7 hops insufficient for target densities, the
  ceiling is wire-frozen — mitigation is gossip-subset tuning and duty-cycle work, not TTL
  inflation (reconsider only with a protocol-version bump and interop plan).
- **Reconsider if:** field data invalidates a frozen value (requires PROTO_VER bump process,
  not a silent edit); if the v4 MMKV evaluation in P5 shows the revert incident's cause
  fixed and migration safe; if a future threat review demands stronger unlinkability than
  rotation provides (then revisit identity, not constants).

---

## Highest-risk unknowns (need physical-device validation, not assumptions)

1. **Actual battery drain of foreground mesh** on 2–3 Android OEMs with the default duty cycle — the §11.11 numbers are targets, not measurements. If real drain is 2× target, the duty-cycle design changes.
2. **iOS↔Android background discovery in practice** — overflow-area behavior, scan coalescing intervals, and restoration relaunch rates vary by iOS version; the "Android as backbone" posture rests on measurements we don't have yet.
3. **Dense-crowd propagation** — 50+ peers: does the TTL/jitter/gossip-subset design sustain < 30 s propagation, or does the mesh collapse into collisions? This is the load test that validates or breaks the flood parameters.
4. **OEM foreground-service kill rates** — Xiaomi/Oppo/Vivo/Samsung, per OS skin version. Determines whether the whitelisting UX (G-12) is a footnote or a core flow.
5. **Ed25519 verify throughput on low-end devices** (native vs noble fallback) — validates the `CryptoPort` primary/fallback split under flood load.
6. **`react-native-lz4` viability** — experimental status, unverified license; and whether compression pays at all on sub-KB payloads. May resolve to "no compression v1."
7. **BLE library spike outcome** — which of the three candidates actually does peripheral + GATT server + L2CAP + background on both OSes. The whole `MESH` schedule depends on this answer.
8. **TestFlight external review outcome** under Guideline 1.2 — unknowable until submitted; the moderation story (G-1) must precede it.
9. **India §69A enforcement scope** — whether open-source mesh-communication projects face repo-level action beyond store removal; determines mirroring urgency (G-11).
10. **Obtainium auto-install UX on Android 12+** for our exact asset layout — verify end-to-end on a real device before declaring the update story done.
11. **Public Nostr relay availability, retention, and rate-limit policies for our event kinds** — untested; the multi-relay defaults chosen in P3 are guesses until measured. The mesh remaining fully functional offline bounds the downside.

---

*End of worker 4 deliverable. Open questions for the parent/orchestrator: (1) confirm `minSdkVersion 26` and the BLE-library spike shortlist; (2) decision on Sentry opt-in vs local-only diagnostics (G-3) before v1 scope freeze; (3) approve the "no OTA / fast-forward hotfix" rollback posture (§2.6) as the incident-response model.*
