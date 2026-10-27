# Airplane - Roadmap & Repository Plan (canonical)

> Synthesized 2026-10-10 by the architecture coordinator from the roadmap-planner worker output.
> **v2 re-plan (2026-10-10, Worker 3 - review & revise only):** product correction - local-first mesh
> ("Around you" feed) + opportunistic global relay ("World" feed via third-party Nostr relays as
> untrusted dumb pipes; uplink OPT-IN per post, default OFF). P1 is pushed to `enginoor/airplane`;
> P0/P1 unchanged except P0 gains the field-script authoring task. New phase **P4 (relay)** after P3;
> hardening renumbered **P5**, distribution **P6**. Audit P0s addressed here: P0 field-script task (M3),
> moderation as sideload-launch gate (M1), TTL-7 resolution (C1/Q12), MMKV v3.3.3 pin (C5).
> License recommendation: **Apache-2.0**.
> Node ranges in §14 now match the final registry (SYSTEM_DESIGN.md §1, 58 nodes) + 5 new RELAY nodes (v2).

---

**Worker 5 deliverable · Sections 14, 15, 23, 24 of the blueprint (v2 revised by Worker 3)**
**Date:** 2026-10-10 · Status: P1 foundation pushed to `enginoor/airplane`; P0–P6 plan below is the build order.

Node-ID prefixes used: APP (shell/lifecycle), UI (presentation), FEED (ranking/views), MESH (networking), EVENT (event model/codec), STORE (persistence), CRYPTO (keys/identity), LOC (geohash scoping), OBS (observability), DIST (build/distribution), TEST (test doubles), RELAY (opportunistic global relay - v2).

> **Node numbering is now canon.** The ranges above match the final registry (SYSTEM_DESIGN.md §1);
> RELAY-1…5 are the v2 addition (Worker 3). The `(confirm with W#)` caveats from the proposal era are retired.

### Proposed node allocation (reference)

| Prefix | Range | Coverage |
|---|---|---|
| APP | APP-1…APP-6 | shell, navigation, lifecycle, background coordination, permission gate, Expo dev-client config |
| UI | UI-1…UI-7 | feed, composer, post detail, mesh status, settings, onboarding, theme/i18n shell |
| FEED | FEED-1…FEED-6 | feed store, ranking engine, view tracker, geohash scoper, post publisher, tombstone manager |
| MESH | MESH-1…MESH-12 | engine, flood router, fragmenter, reassembler, peer discovery, connection mgr, GATT transport, store-forward sync, power mgr, MTU registry, broadcast scheduler, BLE native module |
| EVENT | EVENT-1…EVENT-6 | schema/builder, verifier, CBOR codec, LZ4 (deferred), event bus, canonical serializer |
| STORE | STORE-1…STORE-7 | SQLite schema/migrations, event + peer repositories, fragment buffer, MMKV hot state, retention janitor |
| CRYPTO | CRYPTO-1…CRYPTO-3 | key manager (KeyStorePort), Ed25519 ops, peer-id rotator |
| LOC | LOC-1…LOC-2 | geohash encode, cell scoping (permission UX: LOC-1 + UI-6) |
| OBS | OBS-1…OBS-3 | logging, mesh metrics, crash adapter (opt-in) |
| DIST | DIST-1…DIST-2 | EAS build pipeline, sideload packager |
| TEST | TEST-1…TEST-4 | simulator transport, BLE fakes, fixtures/golden events, flood harness |
| RELAY | RELAY-1…RELAY-5 | relay client, uplink queue, downlink sync, relay directory, Nostr adapter (v2) |

---

## 14. Proposed repository structure

Monorepo (npm/pnpm workspaces). Rule: `packages/protocol` is pure TypeScript with **zero** React Native / Expo imports - it must run under plain Node for property tests. All platform seams cross an interface defined in `protocol`; native code implements it. Tags: `[P1]` = created in phase 1, `[P3+]` = appears in phase 3 or later, etc.

```
airplane/
├── README.md                          # what it is, threat-model pointer, sideload install
├── LICENSE                            # Apache-2.0 (see §14.1)
├── CONTRIBUTING.md              [P1]  # dev setup, commit style, PR bar
├── SECURITY.md                  [P5]  # disclosure policy, supported versions
├── CODE_OF_CONDUCT.md           [P6]
├── package.json                       # workspaces: apps/*, packages/*
├── tsconfig.base.json           [P1]
├── eslint.config.mjs            [P1]
├── app.json / eas.json          [P1]  # Expo config, EAS build profiles → DIST-1
│
├── apps/
│   └── mobile/                  [P1]  # Expo (dev build) - APP, UI
│       ├── app/                       # expo-router screens
│       │   ├── (tabs)/_layout.tsx     # tab shell → APP-1
│       │   ├── (tabs)/feed.tsx       # → UI-1, FEED-3 (Around-you feed)
│       │   ├── (tabs)/world.tsx [P4] # → UI-1 (World tab: downlink feed, origin-geohash tags)
│       │   ├── (tabs)/compose.tsx    # → UI-2 (+ [P4] uplink opt-in toggle, default OFF)
│       │   ├── post/[id].tsx          # → UI-3
│       │   ├── settings.tsx           # → UI-4
│       │   └── onboarding.tsx   [P2]  # → UI-5
│       ├── src/
│       │   ├── app/lifecycle.ts     # foreground/background state, BLE lifecycle hooks → APP-2
│       │   ├── features/feed/         # hooks + components → UI-1
│       │   ├── features/compose/      # composer → UI-2
│       │   ├── features/design/ [P2]  # tokens, primitives → UI-6
│       │   ├── lib/mesh-service.ts  # singleton: wires protocol+flood+transport+store → APP-3
│       │   └── lib/di.ts              # composition root (simulator ↔ real radio swap) → APP-4, TEST-1
│       └── app.config.ts              # → APP-3, DIST-1
│
├── packages/
│   ├── protocol/                [P1]  # pure TS, no RN deps - EVENT, MESH-3/6/7, FEED-1/2, LOC
│   │   └── src/
│   │       ├── events/          # schema + types → EVENT-1
│   │       ├── codec/           # CBOR encode/decode → EVENT-2
│   │       ├── sign/            # Ed25519 sign/verify adapter → EVENT-3, CRYPTO-2 (impl in crypto pkg)
│   │       ├── payloads/        # post, view-receipt payload types → EVENT-4
│   │       ├── flood/           # controlled flood: TTL, jitter, LRU seen-cache → MESH-3, MESH-6, MESH-7
│   │       ├── transport.ts     # Transport interface (advertise/scan/connect/send) → MESH-1 boundary
│   │       ├── ranking/         # score=log(views)/age^gravity → FEED-1
│   │       ├── receipts/        # (key,post,24h) dedup → FEED-2
│   │       └── geo/             # geohash encode, cell scoping → LOC-1, LOC-2
│   ├── crypto/                  [P1]  # CRYPTO-1…3 (keygen, secure storage adapter, rotation)
│   ├── storage/                 [P1]  # STORE-1…3
│   │   └── src/
│   │       ├── schema/          # SQLite DDL + migrations
│   │       ├── repos/           # posts, receipts, peers repositories
│   │       └── kv/              # MMKV wrappers (settings, counters)
│   ├── native-ble/              [P3]  # implements protocol Transport → MESH-1, MESH-2, MESH-4, MESH-5
│   │   │                        # [P1]: interface stub + mock only, in test-doubles. Decision: ble-plx
│   │   │                        # fork vs ble-manager 12.x lands in P0 (see §15 P0).
│   │   ├── src/transport.ts     # Transport impl over chosen BLE lib
│   │   ├── src/gatt.ts          # GATT server (peripheral) + client (central) roles
│   │   ├── src/frag.ts          # fragmentation/reassembly → MESH-4
│   │   └── expo-plugin/         # config plugin: BT permissions, background modes → APP-3
│   ├── relay/                   [P4]  # pure TS, no RN deps - RELAY-1…5 (opportunistic global relay)
│   │   └── src/
│   │       ├── client/          # RELAY-1 RelayClient: wss pool, Nostr sessions, failover
│   │       ├── uplink/          # RELAY-2 UplinkQueue: durable opt-in queue, retry/backoff
│   │       ├── downlink/        # RELAY-3 DownlinkSync: REQ filters, EOSE handling, world ingest
│   │       ├── directory/       # RELAY-4 RelayDirectory: default+user relays, health, blocklist
│   │       ├── nostr/           # RELAY-5 NostrAdapter: mesh event ↔ Nostr envelope (unlinkable keypair)
│   │       └── socket.ts        # RelaySocketPort (platform WebSocket adapter; TEST double in test-doubles)
│   ├── observability/           [P2]  # OBS-1…3; P1 = structured log facade only
│   └── test-doubles/            [P1]  # TEST-1, TEST-2
│       └── src/
│           ├── simulator.ts     # in-memory multi-peer radio simulator (latency/loss knobs)
│           └── fixtures.ts      # golden events, deterministic keypairs
│
├── tools/
│   └── field-test/              [P0]  # TEST-4: measurement harness + checklists for P0/P3 field runs
│       ├── measure.sh           # orchestrates timed trials, logs to CSV
│       └── checklist.md         # P0 trial protocol (distances, orientations, N trials)
│
├── docs/
│   ├── blueprint/               [P1]  # THIS series: arch docs, node catalogs, worker outputs
│   ├── spec/                    [P1]  # wire format + flood algorithm spec (source of truth for protocol/)
│   │   ├── wire-format.md       # → EVENT-1, EVENT-2
│   │   └── flood.md             # → MESH-3, MESH-6, MESH-7
│   ├── adr/                     [P1+] # architecture decision records (0001-template.md first)
│   ├── threat-model.md           [P5]  # draft stub in P1, full review in P5
│   └── launch/                  [P6]  # release runbooks, Obtainium/TestFlight steps → DIST-2
│
├── scripts/                     [P1]  # DIST-2: version bump, changelog, release asset prep
├── fastlane/                    [P6]  # ONLY if EAS proves insufficient; default: EAS handles signing
├── .github/
│   └── workflows/
│       ├── ci.yml               [P1]  # lint, typecheck, unit tests (protocol/storage/test-doubles)
│       └── eas-build.yml        [P1]  # dev-build on PR; release builds on tag [P6]
└── .gitignore
```

**Deliberately absent:** no `packages/server` (there is no server), no `packages/relay-server` (relays are third-party Nostr relays - we run none), no `packages/api`, no `web/` app (mobile-first; a web viewer would need a bridge - out of scope until P6+), no `packages/geo` micro-package (lives in `protocol/src/geo` - one ~100-line module doesn't earn a package), no `fastlane/` until EAS fails us.

### 14.1 License recommendation: Apache-2.0

**Apache-2.0.** This project ships a mesh protocol and crypto-adjacent code where contributors may hold patents; Apache-2.0's express patent grant protects contributors and downstream forks in a way MIT does not, while staying permissive enough for maximum adoption - which matters for a censorship-resistance tool whose value scales with the number of forks and ports. GPL/AGPL copyleft would restrict integration into larger systems and deter the very reimplementation the protocol needs to survive takedowns; MIT is acceptable but leaves the patent exposure open. Keep the NOTICE attribution requirement; revisit only if a funder mandates otherwise. *(Confirm with Tuba - her call; default Apache-2.0.)*

---

## 15. Phased implementation roadmap

**Sequencing rule:** P0 gates everything (no radio, no product). After protocol types + `Transport` interface freeze in P1, UI work (P2) parallelizes against `test-doubles` simulator. **P4 (relay) lands after P3** so mesh scope semantics (FEED-4) are stable first - and because it needs no radio, it can overlap late-P3 hardening work. **P5 hardens mesh + relay together** (threat model, moderation launch-gates, opt-in crash reporting) before **P6 distribution**. **Highest-risk phase: P0** - if foreground BLE phone-to-phone can't sustain the flood's modest needs, the entire product thesis dies and the only pivots are different radios (Wi-Fi Aware/Direct, ultrasound) with worse stealth/battery profiles. P5 (dense-crowd congestion) is the second-highest risk but is at least tunable in software.

**Assumption retirement (seeds Worker 1's assumption register, audit I17):** each phase table carries an
"Assumptions retired" row tagging which blueprint assumptions that phase validates - P0 retires the radio
assumptions, P1 the crypto/storage/wire assumptions, and so on. The canonical register lives with Worker 1
(planned: ARCHITECTURE.md appendix); these tags are its input, not a duplicate.

**P0 assumptions (marking as required):** test hardware = 2 Android (BLE 5.x, Android 12+) + 1 iPhone (iOS 16+). BLE library choice (ble-plx fork vs ble-manager 12.x) is a P0 *output*, not input - the spike tries both. Version numbers cited are current-as-of-2026-10 knowledge; re-verify at spike time.

### P0 - Radio spike (GO/NO-GO gate)

| Field | Detail |
|---|---|
| **Objectives** | Prove phone-to-phone BLE GATT can carry the flood: advertise/discover, connect, fragment exchange, measure sustained throughput, latency, discovery time, battery drain |
| **Node IDs** | MESH-1, MESH-2, MESH-4 (transport/discovery/fragmentation only - no flood logic yet) |
| **OSS deps** | sfourdrinier `react-native-ble-plx` 3.9.x **and** `react-native-ble-manager` 12.x (spike both, pick one); bare RN or Expo dev-client scratch app - throwaway |
| **Custom work** | Scratch peripheral+central app; GATT service with 1 characteristic (write/notify); 512 B fragmentation |
| **Field-script task (audit M3)** | Author `tools/field-test/measure.sh` + `checklist.md` as a first-class deliverable (the plan currently only *references* it): trial matrix (pairs × distances × orientations × N trials), per-gate measurement procedures for all 6 GO/NO-GO gates (discovery, latency, throughput, battery, interop), CSV schema, pass/fail scorecard. **Owner:** P0 spike DRI (build coordinator names one person at P0 kickoff). |
| **Prerequisites** | 2 Android + 1 iPhone in hand; BT/location permissions granted |
| **Integration boundaries** | None - throwaway spike, nothing lands in `packages/` |
| **Tests / validation** | Trial matrix: pairs (A↔A, A↔i, i↔A), distances 1 m / 3 m / 10 m, foreground-only; 50 fragment-exchange trials per pair; 60 s sustained-transfer runs; battery %/h via OS stats |
| **Deliverables** | `tools/field-test/` harness + results CSV; P0 report with GO/NO-GO verdict; BLE lib decision ADR (adr/0002) |
| **Acceptance criteria** | See GO/NO-GO below - all must pass. Plus M3: `tools/field-test/measure.sh` + `checklist.md` exist in the repo and cover discovery/latency/throughput/battery/interop measurements per the GO/NO-GO gates (an engineer can run the trials tomorrow from the checklist alone). |
| **Risks / open Qs** | Android OEM BLE stack variance; iOS MTU 185 ceiling; background modes untestable in spike (foreground-only by design) |
| **Definition of done** | Verdict recorded, lib chosen, `tools/field-test` committed, P1 unblocked or project pivoted |
| **Assumptions retired** | Radio viability (all NF targets - assumptions until two physical phones say otherwise); Q1 (iOS↔Android background discovery effectively impossible); BLE library choice; MTU floor (assume 185); iOS↔Android foreground interop |

**GO/NO-GO criteria (all required for GO):**
1. **Discovery:** median foreground-to-foreground discovery ≤ 15 s at 3 m; p95 ≤ 60 s - per pair type (A↔A, A↔i).
2. **Exchange:** 512-byte fragmented event round-trips successfully in ≥ 95% of 50 trials at 3 m; median latency ≤ 2 s.
3. **Throughput floor:** ≥ 8 kbps effective payload throughput sustained over 60 s continuous transfer (this is a floor - the flood needs only ~1–2 kbps for realistic post rates; headroom is the point).
4. **Battery:** Android foreground relay adds ≤ 20%/h drain over idle baseline on test device.
5. **iOS↔Android foreground interop:** discovery + exchange works both directions (background interop is *assumed impossible* - see Q1 §24; not a GO criterion).
6. **NO-GO triggers:** any pair type fails discovery in > 20% of trials; sustained throughput < 2 kbps; or iOS refuses custom-service discovery from Android foreground in > 50% of trials → pivot evaluation (Wi-Fi Aware / Wi-Fi Direct / re-scope).

### P1 - Foundation

| Field | Detail |
|---|---|
| **Objectives** | Scaffold monorepo; freeze protocol types + `Transport` interface; event model (CBOR + Ed25519); storage schema; simulator transport; CI green |
| **Node IDs** | EVENT-1…3, EVENT-5/6 (EVENT-4 LZ4 deferred - C13), STORE-1…4, MESH-2/3/4 (flood-router decision + fragmentation as pure logic), FEED-1/2 (scorer + receipt dedup as pure functions), LOC-1/2, TEST-1…3, DIST-1, OBS-1 (log facade), APP-1/4 (config + DI skeleton). CRYPTO-1…3 (KeyStorePort + stable identity) is an explicit **P2** task - P1 ships sign/verify primitives only (see "What P1 already gives" below) |
| **OSS deps** | `cbor-x` (CBOR), `@noble/ed25519` (assumption: pure-JS acceptable for ≤ few signs/s - verify in P1 benchmarks; fallback `react-native-quick-crypto`), `expo-sqlite`, `react-native-mmkv` **3.3.3** (pinned; v4.x evaluation deferred to P5 hardening - C5), `expo-router`, EAS |
| **Custom work** | `docs/spec/wire-format.md` + `flood.md` (spec-first, code follows spec); flood engine state machine; ranking + receipt-dedup pure functions; SQLite migrations v1; simulator transport with latency/loss knobs; golden-event fixtures |
| **Prerequisites** | P0 = GO; BLE lib chosen |
| **Integration boundaries** | `protocol` ↔ `crypto` (sign adapter), `protocol` ↔ `storage` (repo interfaces), `protocol` ↔ `native-ble` (Transport interface - stub only in P1), `apps/mobile` DI seam (`lib/di.ts` swaps simulator/real) |
| **Tests / validation** | Unit: codec round-trip, sign/verify, ranking math (see §23), receipt 24 h dedup, flood property tests (no infinite relay, TTL respected, dedup convergence - TEST-3 *starts* here); CI: lint + typecheck + unit on every PR |
| **Deliverables** | Monorepo scaffold; `docs/spec/*`; `docs/adr/0001-*`; CI workflows; threat-model stub; simulator demo (two virtual peers flooding in Node) |
| **Acceptance criteria** | `pnpm -w build+test` green; spec↔code parity review signed off; simulator shows 3-peer flood converging with no duplicates past TTL |
| **Risks / open Qs** | LZ4: **defer** - payloads are ~200–500 B; compression only pays off above ~1–2 KB. Decision recorded in ADR; revisit in P5 dense-crowd work (Q3 §24). Noble/ed25519 perf on low-end Android (benchmark in P1) |
| **Definition of done** | Types frozen (breaking changes after this need an ADR); CI green on main; simulator flood demo passes |
| **Assumptions retired** | Q8 (noble pure-JS fast enough - P1 benchmark decides); Q9 (secure key storage - ADR: expo-secure-store vs MMKV); SQLite driver choice (C9 - op-sqlite vs expo-sqlite spike); TTL-7 wiring (Q12 resolved - 8/16 are property-test variables only); 280-char bound; ranking math; receipt 24 h dedup mechanics |

### P2 - Local MVP (mesh UI, no radio)

| Field | Detail |
|---|---|
| **Objectives** | Feed UI + composer + ranking running on local/simulated data; full UX loop (write → store → rank → view → receipt) without BLE |
| **Node IDs** | UI-1…7, APP-1/2, FEED-3/4 (feed query/merge, geohash filter), LOC-1 (permission-aware) + UI-6 (onboarding permission UX), OBS-2 (mesh-stats UI hooks, fed by simulator), STORE (repos consumed for real) |
| **OSS deps** | `@shopify/flash-list`, `expo-location`, `expo-secure-store` (assumption: Ed25519 seed storage - confirm vs MMKV in P1 ADR) |
| **Custom work** | Feed list (FlashList), composer, post detail, settings/identity (keypair display, rotation), onboarding; `mesh-service.ts` wired to **simulator** transport; geohash cell filter UI |
| **Prerequisites** | P1 types frozen; simulator transport stable |
| **Integration boundaries** | UI talks only to `storage` repos + `protocol` ranking - never to BLE directly; radio swap is one DI line in `lib/di.ts` |
| **Tests / validation** | Component tests for feed/composer; ranking snapshot tests (fixed now → deterministic order); simulated 50-peer flood → feed renders converged state; manual UX pass on 1 Android + 1 iPhone |
| **Deliverables** | Installable Expo dev build; demo video (simulated 3-phone mesh on one desk); UX feedback log |
| **Acceptance criteria** | Cold start → feed renders ≤ 1 s with 500 local posts; composer → signed event → visible in feed ≤ 500 ms; view increments receipt counters; no crashes on airplane-mode toggle |
| **Risks / open Qs** | Feed perf at 10k posts (FlashList windowing - validate in P2); geohash precision UX (Q4 §24) |
| **Definition of done** | Tuba can demo the full loop on two phones side-by-side (both on simulator) without touching code |
| **Assumptions retired** | Feed perf (≤ 1 s cold start with 500 posts; 10k-post scroll ≥ 55 fps); composer → signed → visible ≤ 500 ms; Q4 (partial - geohash precision UX via simulated density); Q11 (partial - gravity 1.5 feel via simulator A/B) |

### P3 - Mesh MVP (two-phone flood)

| Field | Detail |
|---|---|
| **Objectives** | Real BLE flood between 2+ physical phones: discovery, fragment exchange, view receipts over mesh, geohash scoping enforced |
| **Node IDs** | MESH-1/2/4 (engine, flood router, reassembler), MESH-5 (peer discovery), MESH-6/7 (connection manager, GATT transport), MESH-8 (store-forward sync), MESH-11 (broadcast scheduler/backoff), FEED-2 (receipts over mesh), LOC-2 (cell-scoped relay), OBS-2 (live mesh metrics), TEST-4 (field runs) |
| **OSS deps** | Chosen BLE lib (P0 output); `native-ble` expo config plugin |
| **Custom work** | `packages/native-ble` full impl of `Transport`; GATT roles (peripheral + central simultaneously); fragment reassembly; receipt gossip; `lib/di.ts` flips to real transport; field-test runs per `tools/field-test/checklist.md` |
| **Prerequisites** | P2 DoD; P0 numbers reproduced on P2-era code path |
| **Integration boundaries** | `native-ble` ↔ `protocol` strictly via `Transport` interface - no BLE types leak upward; `mesh-service` owns reconnect/backoff policy |
| **Tests / validation** | 2-phone: post on A appears on B (median ≤ 10 s at 3 m); view on B increments A's view count within 60 s; TTL respected (3-hop chain test with 3 phones); kill-app-on-B → no crash on A, rejoin converges |
| **Deliverables** | Two-phone field-test report; `docs/spec/flood.md` updated with measured constants (jitter windows, MTU) |
| **Acceptance criteria** | 20/20 posts propagate A→B→(C) in field test; receipt round-trip works; battery delta within P0 bounds; no ANR/crash over 30-min soak |
| **Risks / open Qs** | Android Doze killing central scans (foreground service? - Q5 §24); iOS foreground-only UX copy; OEM BLE flakiness |
| **Definition of done** | Tuba posts from one phone, reads it on the other, views counted - all over real radio, airplane mode on (no internet) |
| **Assumptions retired** | Q2 (OEM variance - field tests expand to ≥ 4 OEMs; conservative constants into `docs/spec/flood.md`); Q5 (Doze kill timing on test OEMs); receipt round-trip ≤ 60 s; 3-hop TTL chain behavior; FEED-4 scope enforcement in the wild |

### P4 - Global relay (opportunistic uplink/downlink)

| Field | Detail |
|---|---|
| **Objectives** | "World" feed: when the viewer's phone has internet, show posts relayed from meshes everywhere, each tagged with origin geohash. Any phone in a mesh with internet uplinks that mesh's **opt-in** posts to public Nostr relays. Relays are dumb pipes run by anyone - **no Airplane backend, no Airplane-run relay**. Uplink is **OPT-IN per post at compose time, default OFF** (safety-critical: never auto-broadcast local posts globally). |
| **Node IDs** | RELAY-1…5 (new - see §14); touches FEED-1 (world-feed query mode), FEED-5 (opt-in flag), UI-1 (World tab), UI-2 (opt-in toggle), UI-6 (onboarding copy: public-not-encrypted + IP exposure), EVENT-1/2 (envelope build + verify-before-render), STORE-2 (persist world posts), CRYPTO-1 (unlinkable Nostr keypair via KeyStorePort), OBS-2 (relay metrics) |
| **OSS deps** | `nostr-tools` (evaluate vs hand-rolled minimal NIP-01 client - relay protocol surface is small: EVENT/REQ/CLOSE/EOSE; ADR the choice); platform WebSocket (built-in - no new native module) |
| **Custom work** | `packages/relay/` (RELAY-1…5 per §14); opt-in flag in the signed event (SYSTEM_DESIGN.md EVENT-1 `["uplink","1"]` tag convention); world-feed query in FEED-1 (same ranking formula, origin-geohash tag); IP-exposure disclosure copy in UI-6 + composer |
| **Prerequisites** | P1 gap-closure (audit G1 KeyStorePort + stable identity, G2 EVENT-2 ingest, G7 tombstone authorship - mandated pre-P2 fixes); P3 scope semantics stable (FEED-4); stable per-device Ed25519 keypair (Worker 2 `KeyStorePort` spec) |
| **Integration boundaries** | `relay` ↔ `protocol` strictly via EVENT-2 (inbound verify-before-render) and EVENT-1/3 (envelope build); Nostr envelope signing uses the *unlinkable Nostr keypair*, never the mesh identity key; `relay` never touches BLE; FEED-1 reads world posts only from STORE-2; world posts (`source='world'`) are **never** admitted to the mesh flood |
| **Tests / validation** | NostrAdapter golden vectors (wrap→unwrap byte-identical; invalid envelope rejected; mesh pubkey ≠ Nostr pubkey); uplink queue: kill app mid-queue → resumes; downlink REQ against ≥ 3 public relays; relay-outage drill: all relays down → Around-you feed unaffected, failover silent (DIAGRAMS.md I8) |
| **Deliverables** | `packages/relay/` + unit/integration tests; World tab in dev build; `docs/adr/` relay decisions (client lib, envelope kind/NIP mapping, default relay list) |
| **Acceptance criteria** | Phone A (offline mesh) post with opt-in → phone B (online) uplinks → phone C (online, other continent) sees it in World feed with origin geohash ≤ 5 min; opt-in-OFF post **never** leaves the mesh (negative test); relay down → Around-you feed unaffected |
| **Risks / open Qs** | Public relays filtering unknown event kinds (Q15); courier IP exposure (Q18 - disclosed, VPN/Tor out of scope v1); NIP-42/auth or paid relays (Q19); relay spam → filtering hooks (Q17, policy in P5) |
| **Definition of done** | Two-continent relay round-trip demoed; negative opt-in test green; relay directory + health checks working; filtering hooks (relay blocklist, kind allowlist) in place for P5 policy |
| **Assumptions retired** | Nostr dumb-pipe model viable in practice (Q15); opt-in courier semantics - any online peer may uplink others' opt-in posts (Q16); world-feed ranking approach (Q17); IP-exposure disclosure accepted (Q18); free no-auth relays sufficient (Q19) |
| **What P1 already gives vs what P4 adds** | P1 gives: signed events (EVENT-1/3), verify-before-render (EVENT-2), sign/verify *primitives* only (no KeyStorePort, no stable per-device identity - the v1 audit P0 stands open in code), port abstractions (Transport/Store/Crypto). **P2 must deliver: CRYPTO-1/KeyStorePort + stable per-device Ed25519 keypair in Keychain/Keystore** - this gates tombstone authorship, receipt dedup, and per-key rate limits. P4 adds: the whole relay subsystem (RELAY-1…5, incl. the unlinkable Nostr secp256k1 key via CRYPTO-1), opt-in flag plumbing, world-feed query/render, relay directory + health, Nostr envelope mapping (SYSTEM_DESIGN.md §7; this phase implements it) |

**Why P4 sits here (dependency rationale):** the relay needs P1's signed events + stable identity and P3's
settled scope semantics, but it needs *no radio* - so it can start as P3 field work winds down and run
partly in parallel. It must come *before* hardening because P5's threat model, spam policy, and moderation
gates all have relay-facing halves (relay trust boundary, relay-level filtering hooks) - hardening a
mesh-only system and bolting the relay on after would repeat the v1 seam-rot the audit found.

### P5 - Hardening (renumbered from v1 P4)

| Field | Detail |
|---|---|
| **Objectives** | iOS background best-effort; battery optimization; dense-crowd congestion control; full security review; spam/moderation story for an anonymous network |
| **Node IDs** | MESH-11 (congestion: adaptive jitter, gossip throttling), EVENT-4 (LZ4 revisit), MESH-9 + APP-2/5 (background lifecycle), OBS-1…3 (diagnostics export + opt-in crash reporting), CRYPTO-3 (rotation UX), SECURITY.md, `docs/threat-model.md` (full - incl. relay trust boundary + state-level adversary) |
| **OSS deps** | None new expected; possibly `react-native-background-actions` (Android foreground service - evaluate vs Expo TaskManager) |
| **Custom work** | Crowd simulator: 200-peer storm in `test-doubles` → tune jitter/backoff; per-key rate limits (posts/hour, receipts/hour) enforced at ingest (**launch-gate**, see below); TTL caps; client-side blocklist (hash-based, no identity); local mute/block + keyword filter UI (**launch-gate**); relay filtering-hooks default policy - relay blocklist, kind allowlist, per-key mute applied to world feed (**launch-gate**); iOS background-central opportunistic sync + honest "foreground for full mesh" UX; battery profiler pass; opt-in crash reporting (OBS-3 → GlitchTip) behind explicit consent toggle - file-export diagnostics remains the default |
| **Crash reporting (decided - audit M4)** | File-export diagnostics in v1; opt-in reporting lands here in P5 (v1 numbering called this phase P4). SYSTEM_DESIGN OBS-3's "certain + upload-when-online" is superseded: no upload without explicit consent, ever. |
| **Prerequisites** | P3 field data; P4 relay subsystem built (threat model + moderation gates harden both halves); threat-model draft from P1 |
| **Integration boundaries** | Rate-limit policy lives in `protocol/flood` (pure, testable); platform background code isolated in `native-ble` + `APP-2` |
| **Tests / validation** | 200-peer simulated storm: convergence < 5 min, no peer exceeds 2× median battery cost; fuzz codec + signature verification (malformed CBOR, wrong-key sigs - must reject, never crash); security review checklist (§23) signed off |
| **Deliverables** | `docs/threat-model.md` v1.0; `SECURITY.md`; congestion tuning ADR; background-mode behavior matrix (iOS vs Android, documented limitations) |
| **Acceptance criteria** | Storm test passes; fuzz corpus clean; threat model reviewed by ≥1 external reviewer (assumption: recruit from OSS security community - Q9 §24); Apple Guideline 1.2 risk assessed (see Q6) |
| **Risks / open Qs** | Spam without identity is fundamentally rate-limit + TTL only - residual abuse accepted and documented; dense-crowd is the highest *product* risk after P0 |
| **Definition of done** | Threat model published; storm + fuzz + security checklist green; background behavior documented honestly in-app; moderation launch-gates (below) all green |
| **Assumptions retired** | Q3 (LZ4 revisit - adopt or permanently defer, with crowd-sim data); Q6 (Apple Guideline 1.2 - review-risk assessment); Q7 (spam posture - per-key rate limits + TTL; residual abuse accepted and documented); threat model v1.0 incl. state-level adversary + device seizure (M6); crash-reporting decision (file-export v1, opt-in reporting P5); MMKV v4.x evaluation (C5) |

#### P5 sideload-launch gates (audit M1 - must land BEFORE P6 distribution)

v1 launches via **sideload (no store review)**, so moderation cannot be gated on store submission. Minimum
abuse-tooling set, each with a named owner - not floating future work:

| # | Gate | Owner | Acceptance |
|---|---|---|---|
| G-M1 | **Per-key rate limits** (posts/hour, receipts/hour) enforced at EVENT-2 ingest; tunables in one config file | P5 hardening builder (requirement: Worker 1) | Storm test: spammer key throttled, honest keys unaffected; fuzz corpus clean |
| G-M2 | **Local mute/block**: per-key mute, per-post hide, keyword filter; blocklist survives restart; applies to both feeds | P5 UI/FEED builder (requirement: Worker 1) | Muted key's posts hidden in Around-you + World; hidden post stays hidden across restart |
| G-M3 | **Relay-level filtering hooks**: relay blocklist, Nostr kind allowlist, per-key mute applied to world-feed ingest (hooks built in P4, default policy wired here) | P4 relay builder (hooks) + P5 hardening builder (policy) | Blocked relay never queried; disallowed kinds dropped at RELAY-5; hooks covered by tests |

### P6 - Distribution (renumbered from v1 P5)

| Field | Detail |
|---|---|
| **Objectives** | Signed sideload-first releases; Obtainium; TestFlight; docs; public launch |
| **Node IDs** | DIST-1…2, APP-3 (release config), docs/launch |
| **OSS deps** | EAS Build; GitHub Releases; Obtainium (client-side, no integration needed beyond release assets) |
| **Custom work** | `eas-build.yml` release profile; `scripts/release.sh` (version bump, changelog, APK+AAB signing, checksums); Obtainium-ready release notes format; TestFlight submission; install docs (sideload guides per Android OEM); launch checklist |
| **Prerequisites** | P5 DoD; signing keys generated and backed up (Tuba-held, never in repo) |
| **Integration boundaries** | Release pipeline touches only build config - no code changes after P5 freeze except release-blockers |
| **Tests / validation** | Fresh-device install from GitHub Release APK (no dev tooling); Obtainium import → update flow; TestFlight external-tester install on clean iPhone |
| **Deliverables** | v0.1.0 GitHub Release (APK + AAB + checksums); TestFlight build; `docs/launch/*` runbooks; README install section |
| **Acceptance criteria** | Three clean devices (2 Android OEMs + 1 iPhone) install and mesh with zero developer intervention; rollback plan documented |
| **Risks / open Qs** | Apple review under Guideline 1.2 (anonymous broadcast - Q6 §24); TestFlight rejection → iOS becomes AltStore/sideload-only, documented fallback; India's Oct-2026 takedown climate - GitHub Releases mirror plan (Q10 §24) |
| **Definition of done** | Public release tagged, installable by a non-technical user from the README alone |
| **Assumptions retired** | Q10 (takedown resilience - mirror steps executed); Q6 (final verdict - TestFlight submitted early, fallback ready); non-technical install path |

---

## 23. Acceptance criteria & architecture validation checklist

Check each item before the phase it gates. `[Pn]` = must hold by end of that phase.

### 23.1 Feature → node mapping
- [ ] [P0] `tools/field-test/measure.sh` + `checklist.md` exist in the repo and cover all 6 GO/NO-GO gates (audit M3)
- [ ] [P1] Every product requirement in the blueprint maps to ≥1 node ID; no requirement is node-orphaned
- [ ] [P1] Every node ID in §14's allocation is owned by exactly one worker/package - no overlaps, no gaps
- [ ] [P2] Feed UI actions (post, view, filter) trace to FEED/STORE/EVENT nodes in code review
- [ ] [P3] Every BLE code path traces to a MESH node; no ad-hoc radio code in `apps/mobile`

### 23.2 Dependency justification
- [ ] [P0] BLE library decision recorded in ADR with measured trial data, not preference
- [ ] [P1] Each OSS dep has a one-line justification + evaluated alternative in `docs/adr/` (cbor-x, noble/ed25519, expo-sqlite, MMKV, FlashList)
- [ ] [P1] `packages/protocol` dependency audit: zero RN/Expo/native imports (enforced by eslint `no-restricted-imports` in CI)
- [ ] [P5] LZ4 revisit decision (adopt or permanently defer) recorded with crowd-sim data

### 23.3 Contract coverage
- [ ] [P1] `Transport` interface covers advertise, scan, connect, disconnect, send, onReceive - `native-ble` and simulator both implement it; compile-checked
- [ ] [P1] `docs/spec/wire-format.md` ↔ `protocol/src/codec` parity reviewed (field order, CBOR tags, size limits)
- [ ] [P1] `docs/spec/flood.md` ↔ `protocol/src/flood` parity reviewed (TTL default, jitter window, LRU size, dedup key)
- [ ] [P3] GATT service/characteristic UUIDs frozen and documented; changing them requires ADR (deployed peers must interop)

### 23.4 ID stability
- [ ] [P1] Event IDs are content-derived and stable across encode/decode cycles (golden fixtures byte-compare)
- [ ] [P1] Key IDs (Ed25519 pubkey hash) stable across app restarts and key rotation (rotation links old→new)
- [ ] [P3] Peer/session IDs never leak into persisted event data (anonymity boundary test)

### 23.5 Critical-path test coverage
- [ ] [P1] Flood correctness: property tests prove no infinite relay (TTL strictly decreases), seen-cache dedup converges, reordered/duplicate fragments reassemble identically
- [ ] [P1] Signature verification: valid sigs accept; tampered payload, wrong key, truncated sig → reject; fuzz corpus (≥10k mutated inputs) → zero crashes, zero false accepts
- [ ] [P1] Ranking math: `score = log(views)/age^gravity` snapshot tests - fixed timestamps/views produce deterministic order; edge cases (0 views, age 0, huge age) don't NaN/Infinity
- [ ] [P1] Receipt dedup: (key, post, 24 h) window - same key re-viewing within 24 h counts once; after 24 h counts again; different keys count independently
- [ ] [P3] Two-phone field test: 20/20 propagation, receipt round-trip, 30-min soak without crash
- [ ] [P5] 200-peer storm simulation: convergence < 5 min, per-peer cost ≤ 2× median

### 23.6 Security review
- [ ] [P5] `docs/threat-model.md` v1.0 published and reviewed by ≥1 external reviewer (incl. relay trust boundary, state-level adversary, device seizure)
- [ ] [P5] Private keys never leave secure storage; no key material in logs, diagnostics exports, or crash reports (grep-verified)
- [ ] [P5] Ingest path rejects: oversize payloads (> cap), TTL > max, future timestamps (> skew), unknown payload types, replayed events (seen-cache)
- [ ] [P5] Per-key rate limits enforced at ingest (posts/hour, receipts/hour) - tunables in one config file
- [ ] [P5] Diagnostics export contains zero PII by construction (no location finer than geohash cell, no keys) - verified by test

### 23.7 Performance targets
- [ ] [P0] GO/NO-GO radio numbers met (see §15 P0)
- [ ] [P2] Feed renders ≤ 1 s cold start with 500 local posts; 10k-post scroll stays ≥ 55 fps on mid-range Android
- [ ] [P2] Composer → signed event → visible ≤ 500 ms on-device
- [ ] [P3] Post propagation A→B median ≤ 10 s at 3 m; receipt round-trip ≤ 60 s
- [ ] [P5] Foreground relay battery overhead within P0 bounds (≤ 20%/h); background (where supported) ≤ 5%/h incremental

### 23.8 Store / sideload readiness
- [ ] [P6] Release APK installs on clean device from GitHub Release with no dev tooling; SHA-256 checksums published
- [ ] [P6] Obtainium can track the repo's releases (standard GitHub release asset naming)
- [ ] [P6] TestFlight build submitted; Apple Guideline 1.2 risk disposition documented (Q6 §24); iOS fallback (AltStore/sideload docs) ready if rejected
- [ ] [P6] Rollback plan: previous release assets retained; version-code monotonicity enforced in `scripts/release.sh`
- [ ] [P6] Non-technical install path works from README alone (tested by someone other than the author)

### 23.9 Relay & sideload-launch gates
- [ ] [P4] Opt-in default OFF verified end-to-end: composer default, mesh courier honors the flag, negative test (opt-in-OFF post never uplinked)
- [ ] [P4] NostrAdapter golden vectors: wrap→unwrap byte-identical; invalid envelope rejected; mesh pubkey ≠ Nostr pubkey (unlinkable keypairs)
- [ ] [P4] Relay-outage drill: all relays down → Around-you feed unaffected; uplink queue persists; failover silent (no error storm)
- [ ] [P4] IP-exposure disclosure copy present in onboarding (UI-6) and composer opt-in toggle ("public everywhere, not encrypted")
- [ ] [P5] Moderation launch-gates G-M1…G-M3 green (per-key rate limits, local mute/block/keyword filter, relay filtering hooks)
- [ ] [P5] Crash reporting: file-export default; opt-in (GlitchTip) behind explicit consent - no upload without consent (audit M4)

---

## 24. Open questions & assumptions

Format: **Q# - question.** *Why it matters. Assumption the blueprint makes. How/when to resolve.*

1. **iOS↔Android background discovery over pure BLE.** *Matters:* decides whether the app can relay with the screen off - core to the protest use case. *Assumption:* effectively impossible (iOS background peripheral advertises into the overflow area; Android can't reliably discover it; iOS background central scanning is throttled). Product is foreground-first by design. *Resolve:* P0 spike documents the exact failure modes; P4 ships best-effort iOS background-central opportunistic sync and honest in-app copy. Revisit only if Apple changes background BLE policy.
2. **Android OEM BLE stack variance (MTU negotiation, scan throttling).** *Matters:* P0 numbers on 2 devices may not generalize to the Xiaomi/Oppo/Vivo devices common in India. *Assumption:* BLE 5.x + Android 12+ behaves within 2× of P0 measurements. *Resolve:* P3 field tests expand to ≥4 OEMs; `docs/spec/flood.md` records conservative constants (assume MTU 185 floor, iOS ceiling).
3. **Is LZ4 compression worth it?** *Matters:* dependency + CPU/battery cost vs payload savings. *Assumption:* deferred - typical events are 200–500 B, below the ~1–2 KB threshold where LZ4 pays off; fragmentation (MESH-4) ships without compression in P3. *Resolve:* P5 crowd simulation measures aggregate bandwidth with/without; ADR records final call.
4. **Geohash precision for cell scoping.** *Matters:* too fine = feed fragments into empty cells; too coarse = location anonymity weakens and flood scope explodes. *Assumption:* precision 5 (~4.8 × 4.8 km) default, user-adjustable 4–6. *Resolve:* P2 UX testing with simulated density; P3 field test in a real crowd; decision ADR in P3.
5. **Android Doze / background execution for relay.** *Matters:* a phone in a pocket that stops relaying shrinks the mesh. *Assumption:* foreground service with persistent notification is acceptable UX for the target user (protest/concert = phone out anyway); no background work promised beyond best-effort. *Resolve:* P3 measures Doze kill timing on test OEMs; P4 implements foreground-service path behind a user toggle with battery-cost disclosure.
6. **Apple App Store Guideline 1.2 (Feb 2026: anonymous chat/broadcast apps) vs TestFlight.** *Matters:* iOS distribution could be blocked at review even for TestFlight. *Assumption:* TestFlight-only distribution *reduces* but does not eliminate review risk; sideload/AltStore fallback documented from day one. *Resolve:* P5 legal/review-risk assessment; P6 submits early to TestFlight to get a verdict before launch marketing; if rejected, iOS goes AltStore + sideload docs.
7. **Spam/DoS resistance without identity.** *Matters:* anonymous flood + no server = anyone can spam the mesh. *Assumption:* per-key rate limits + TTL caps + client-side hash blocklists are sufficient; residual spam is accepted and documented as a known limitation (same tradeoff as Bitchat). *Resolve:* P5 threat model + 200-peer spam simulation; post-launch tuning via config, not protocol change.
8. **Ed25519 implementation: pure-JS noble vs native.** *Matters:* signing latency on low-end Android affects composer responsiveness. *Assumption:* `@noble/ed25519` pure JS is fast enough for ≤ a few signs/second; benchmark in P1 decides, fallback `react-native-quick-crypto`. *Resolve:* P1 benchmark on the slowest test device; ADR.
9. **Secure key storage mechanism.** *Matters:* seed compromise = identity compromise (and view-receipt forgery). *Assumption:* `expo-secure-store` (Keychain/Keystore) for the Ed25519 seed; MMKV only for non-secret settings. *Resolve:* P1 ADR confirming vs alternatives; P5 grep-audit that no secret touches MMKV/SQLite/logs.
10. **Takedown resilience of distribution (India Oct-2026 context).** *Matters:* Bitchat/Briar/Bridgefy were taken down from stores; GitHub Releases could face pressure too. *Assumption:* sideload-first + Obtainium + mirrored release assets (IPFS/direct APK mirror noted as option) keeps the app obtainable; repo itself is the fallback distribution channel. *Resolve:* P6 launch runbook includes mirror steps; no action needed before P6.
11. **View-receipt 24 h dedup window and `gravity` constant tuning.** *Matters:* ranking feel - too sticky and stale posts dominate; too twitchy and the feed churns. *Assumption:* 24 h window, gravity ≈ 1.5–1.8 (Hacker-News-like). *Resolve:* P2 simulator A/B with synthetic view patterns; P3 field data; tunables stay in one config file, no protocol change needed.
12. **TTL default and max hop count - RESOLVED.** *Resolution (audit C1):* **default TTL 7, hard ceiling 7** (BitChat ceiling; ARCHITECTURE.md §7 Q2). The 8/max-16 values were a stale assumption - they survive only as P1 property-test variables. Wire-frozen at PROTO_VER 1.
13. **CRDTs deferred - is last-writer-wins on receipts enough?** *Matters:* concurrent view receipts from many peers must converge to the same count. *Assumption:* yes - receipts are idempotent, monotonically additive per (key, post, 24 h) dedup key; no conflict resolution needed, so CRDTs stay deferred indefinitely. *Resolve:* P1 property test proves count convergence under reordering/duplication; revisit only if a mutable-post feature (edits) is ever proposed.
14. **Expo dev build vs bare prebuild for native BLE module maintenance.** *Matters:* config plugins vs hand-maintained native code - affects contributor onboarding. *Assumption:* Expo dev build + config plugin in `packages/native-ble/expo-plugin`; no bare workflow unless the chosen BLE lib requires it. *Resolve:* P0 spike validates the chosen lib works under Expo dev client; ADR if bare becomes necessary.
15. **Will public Nostr relays carry our events?** *Matters:* the "World" feed depends on third-party dumb pipes; some relays filter unknown event kinds or rate-limit aggressively. *Assumption:* enough permissive relays exist; the client publishes to several and treats relays as interchangeable. *Resolve:* P4 integration test publishes/subscribes against ≥ 5 public relays; default relay list ships only relays that accepted our traffic in testing.
16. **Uplink courier semantics - whose posts may I uplink?** *Matters:* "any phone in a mesh with internet can uplink that mesh's posts" means a courier broadcasts *someone else's* post globally. *Assumption:* the opt-in flag travels inside the signed event, so any peer that received an opt-in post may uplink it; the author's opt-in is the consent, not the courier's. *Resolve:* P4 policy + disclosure copy (courier sees "relaying N opt-in posts" in MeshStatusIndicator).
17. **World-feed spam and ranking.** *Matters:* the global firehose has no geohash scoping to bound it; relay spam lands directly in the World feed. *Assumption:* same ranking formula as Around-you; relay-level filtering hooks (kind allowlist, relay blocklist) + local per-key mute keep it usable; residual spam accepted like Q7. *Resolve:* P4 builds the hooks; P5 wires default policy + documents residual risk.
18. **Courier IP exposure on uplink.** *Matters:* a relay operator sees the uploader's IP and timing - in a protest context that is identifying metadata. *Assumption:* disclosed honestly in onboarding + composer copy; VPN/Tor routing out of scope v1. *Resolve:* P4 copy; P5 threat model records the residual risk.
19. **Relay auth (NIP-42) and paid relays.** *Matters:* some relays require auth or payment; our client must not silently fail or leak identity to them. *Assumption:* default directory lists free no-auth relays only; NIP-42/auth support deferred; paid relays never. *Resolve:* P4 directory policy + ADR.

---

*End of worker-5 deliverable. Proposed node ranges (§14 table) are suggestions for the node-catalog owners to confirm or renumber. All version numbers and device behaviors are assumptions as marked - re-verify at P0 time.*
