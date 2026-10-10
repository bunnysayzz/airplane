# Airplane — Architecture Blueprint (Master Index)

> **Synthesized 2026-10-10** by the architecture coordinator from 6 worker agents
> (2 OSS researchers, system architect, reliability/ops, roadmap planner, diagram specialist).
> **Status: planning only.** Nothing in this blueprint has been built; `enginoor/airplane` is empty.
> Do not push, commit, or scaffold from this doc without explicit approval.
> Values tagged **ASSUMPTION** need physical-device validation (P0 radio spike).

## 0. Document map

| Document | Covers (master-prompt sections) |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) (this file) | Executive summary, scope, requirements, ADR index, roadmap summary, validation checklist, open questions |
| [OSS_RESEARCH.md](OSS_RESEARCH.md) | Ecosystem research + technology selection matrix (§2, §3) |
| [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) | Layers, node inventory, data model, API/event contracts (§0, §1, §2, §3, §4, §5, §6, Appendices A–E) |
| [DIAGRAMS.md](DIAGRAMS.md) | Mermaid diagram mesh A–P, stable node IDs (§6) |
| [OPERATIONS.md](OPERATIONS.md) | Runtime strategy, dependency map, threat model (§10), reliability/perf/security, failure analysis, gaps, full ADRs (§1, §2, §8, §10, §11, §12, §13, §O) |
| [ROADMAP.md](ROADMAP.md) | Proposed repo structure, phased roadmap P0–P5, acceptance criteria (§14, §15, §23, §24) |
| [PLAN_CHANGELOG.md](PLAN_CHANGELOG.md) | v1→v2 change log: what changed, why, who decided (coordinator-owned) |
| [docs/assumption-register.md](docs/assumption-register.md) | All ASSUMPTION tags: statement, source, validation plan, owner |

**How to read:** start here for decisions and sequencing; go to SYSTEM_DESIGN.md for buildable detail;
DIAGRAMS.md for traceability; OSS_RESEARCH.md before adding any dependency; OPERATIONS.md before
any release; ROADMAP.md for what to do next.

---

## 1. Executive summary

**Airplane** is an open-source iOS+Android app: an anonymous **public broadcast feed** (not 1:1
chat) with **two feeds, one identity model, zero Airplane-operated servers**:
- **"Around you"** — the BLE mesh feed, exactly as originally planned. Phones store-and-forward
  each other's posts with no internet and no central server. Always works, geohash-scoped,
  zero internet needed. This is the product's soul: built for protests, concerts, and anywhere
  the network is gone.
- **"World"** — an opportunistic global layer. When *your* phone has internet, you also see posts
  relayed from meshes everywhere, each tagged with its origin geohash. Any phone in a mesh that
  has internet can uplink that mesh's posts to public relays. Uplink is **opt-in per post at
  compose time, default OFF** — a protester posting "cops at gate 3" locally must never have it
  auto-broadcast globally.

The relays are **dumb pipes**: standard Nostr-protocol relays (`wss`), run by anyone. Our events
are Ed25519-signed, so relays are untrusted by design — they can't forge posts, only
withhold/spam them (mitigated by multi-relay publish/fetch + client-side signature
verification). There is **NO Airplane backend and NO Airplane-run relay**. (ADR-09)

**Privacy model, stated plainly:** post *contents* are NOT encrypted — a post is shouting in a
public square; anyone in radio range (mesh) or any relay operator (world feed) can read it.
What is protected is *identity*: no accounts, no phone numbers, no PII — a stable per-device
Ed25519 keypair (a pseudonym, linkable across posts, user-rotatable) is all there is. The app
must say this in plain language at onboarding and in the composer — never "encrypted", never
"private" for post contents. (Full model: §2.4; threat consequences: OPERATIONS.md §10.)

**The architecture in one paragraph:** a single mobile app process (React Native + Expo dev build,
TypeScript) with a strict layered core — UI → FEED (views-ranking domain) → EVENT (signed CBOR
events, Ed25519) → MESH (BitChat-style controlled flood over BLE GATT: TTL, jitter, LRU seen-dedup,
~469 B fragments) and STORE (SQLite event log + MMKV hot KV), plus a new RELAY subsystem (uplink
publisher, Nostr downlink fetcher, relay manager — client-side, untrusted-relay posture). Crypto and
platform-native code live behind TypeScript port interfaces (`BleTransportPort`, `StorePort`,
`KeyStorePort`, `CryptoPort`), so the young peripheral BLE library can be swapped without touching
domain logic. There is **no Airplane-run backend, no cloud, no analytics SDK** — distribution is
sideload-first (GitHub Releases → Obtainium; TestFlight for iOS). 58 nodes across 11 subsystems
(+ RELAY-\* nodes defined by Worker 2 in SYSTEM_DESIGN.md §1), every node with an owner, interface,
and phase.

**What makes it differentiated (verified 2026-10-10):** no shipped or open-source product combines
phone-only BLE mesh + anonymous location feed + offline-first + views-based ranking — and now +
opportunistic global relay over untrusted third-party pipes. Closest prior art: Bitchat (live OSS
BLE mesh, but chat/rooms — mesh design is reusable), Nearcast (unreleased prototype), and the dead
2021 Grapevine project (React Native BLE gossip ranked by reach — the nearest historical match,
abandoned). Tagline: *"the feed that works in airplane mode."*

---

## 2. Project scope

### 2.1 Product definition — two feeds, local-first

v1 assumed pure offline: a Delhi protest would be invisible in Mumbai. **Corrected product model:
local-first mesh + opportunistic global relay.** The mesh core is unchanged; the World feed is a
client-side layer on top, and the internet is never a dependency — only an opportunity.

- **"Around you" feed (the soul of the product):** the BLE mesh feed, exactly as v1 planned.
  Always works, geohash-scoped, zero internet needed. Posts live and die in the local mesh
  (24 h default retention). This feed is fully functional on a phone that has never seen the
  internet and never will.
- **"World" feed (the window):** when the *viewer's* phone has internet, it also fetches posts
  relayed from meshes everywhere — each tagged with its origin geohash. Any phone in a mesh
  that has internet can **uplink** that mesh's posts to public relays. The relays are
  **dumb pipes**: standard Nostr-protocol relays (`wss://`), run by anyone — not by Airplane.
  Our events are Ed25519-signed, so relays are untrusted by design (can't forge; can only
  withhold/spam — mitigated by multi-relay publish/fetch + client-side signature
  verification; OPERATIONS.md §10). **NO Airplane backend. NO Airplane-run relay.** (ADR-09)
- **Uplink is OPT-IN per post at compose time, default OFF (local mesh only).** This is a
  coordinator decision, not a tuning knob: a protester posting "cops at gate 3" locally must
  never have it auto-broadcast globally. There is **no global "always uplink" switch in v1** —
  the toggle lives on the composer, per post, every time.
- **One identity, two feeds:** the stable per-device Ed25519 keypair signs mesh posts (§2.4);
  a *separate* Nostr secp256k1 keypair is the relay-protocol identity (unlinkable by default;
  optional signed binding for users who want continuity). Tombstones and rate limits ride the
  stable mesh identity; the world feed carries the mesh view-count snapshot, never raw
  receipts (OPERATIONS.md §10, §12 G-9).

### 2.2 In scope (v1)
- Anonymous posting to a location-scoped (geohash) public feed, text-first (280 chars **ASSUMPTION**)
- BLE GATT mesh: discovery, controlled flood, store-and-forward, catch-up sync (negentropy-style)
- Signed immutable events (Ed25519, CBOR); tombstones for deletion; no edits
- Stable per-device identity keypair via `KeyStorePort` (Keychain/Keystore); user-initiated rotation ("new identity")
- View receipts (signed, deduped per key/post/24h); feed ranked `score = log(views) / age^gravity`
- **Per-post uplink opt-in** at compose (default OFF); uplink flag is part of the signed event
- **World feed downlink:** fetch from user-configured Nostr relays when online; client-side
  signature verification; origin-geohash tags on every world post; recency-primary ranking with
  mesh-view snapshot as secondary signal; all counts labeled approximate
- **Relay management:** add/remove relay URLs; sensible multi-relay defaults shipped; no
  Airplane-operated relay; relay-level filtering hooks (blocklist + subscription filters)
- **Per-post locality indicator in UI:** "around you" vs "world" badge + origin geohash label
- **Privacy-model UX copy as a launch gate** (§2.5): onboarding lines, composer reminder,
  "how privacy works" explainer; terminology discipline — "anonymous", never
  "encrypted"/"private" for post contents
- **Moderation launch-gate set** (§3 F-16): per-key rate limits, local mute/block, per-post
  hide, keyword filter, relay filtering hooks — ships in P5 as the sideload-launch gate
- Local persistence (SQLite), search (FTS5), retention pruning
- Foreground-first mesh; background relay best-effort only (honest OS limits)
- Sideload distribution: signed APK via GitHub Releases, Obtainium updates, TestFlight for iOS
- Privacy: no accounts, no PII, keys in Keychain/Keystore, no analytics; diagnostics are
  file-export in v1, opt-in reporting in P5 (ADR-10)

### 2.3 Explicitly out of scope (v1)
- 1:1 chat / DMs / rooms, media attachments (images/video), replies/threads, reactions
- CRDTs, libp2p, Wi-Fi Direct / Multipeer transports, LZ4 compression
- Any **Airplane-operated** server/cloud component, OTA JS updates, i18n beyond English scaffolding
- A global "always uplink" switch (deliberately absent — per-post opt-in only)
- Raw view-receipt uplink (mesh view-count snapshot only — anti-gaming + viewer-privacy)
- Relay reputation scoring; Tor support (deferred post-v1 — OPERATIONS.md §10, §12)
- Global moderation beyond the launch-gate set (no server exists to run it; user-curated, not platform-moderated)
- Store-first distribution (Play/App Store are secondary, conditional)

### 2.4 Privacy model (binding — not a feature, a constraint)

1. **Post CONTENTS are NOT encrypted — public by design.** A post is shouting in a public
   square: anyone in radio range (mesh) or any relay operator (world feed) can read it. The
   app must never imply otherwise.
2. **Identity is what's protected (anonymous).** No accounts, no phone numbers, no PII.
   **Identity model (coordinator decision):** stable per-device Ed25519 keypair, generated on
   first launch, stored in Keychain/Keystore via `KeyStorePort` (Worker 2 specs the mechanism).
   Rationale: tombstones need authorship continuity and receipt-dedup needs stable viewer
   keys — a throwaway-keypair-per-post makes both meaningless.
   **Trade-off, documented:** a stable key is a *pseudonym* — linkable across posts by anyone
   who reads them. No PII is bound to it. The user can rotate via "new identity" in settings;
   rotation orphans old posts' tombstones (they become unauthorizable — the app says this).
3. **Relay identity is a SEPARATE Nostr secp256k1 keypair** (protocol requirement), unlinkable
   by default; an optional signed binding event gives continuity to users who want it.
4. **Threat-model consequences** (full: OPERATIONS.md §10): a passive local observer sees ALL
   mesh traffic *content* — anonymity protects *who said it*, not *what was said*. On uplink,
   relay operators additionally see uploader IPs (IP↔post linkage risk — mitigations: opt-in
   uplink, no PII anywhere, identity rotation; **Tor is explicitly out of scope v1**, deferred
   to post-v1 exploration). Note the deniability property: the phone that uplinks a post is
   whichever online mesh member relays it, not necessarily the author.

### 2.5 Privacy UX copy — launch gate (actual copy, v1)

The app must tell users §2.4 in plain language. This copy is a **launch gate** (F-15): the v1
build does not ship without it.
- **Onboarding (3 lines):**
  1. "Airplane is anonymous, not encrypted."
  2. "Everyone nearby can READ what you post — like shouting in a public square."
  3. "Nobody knows WHO posted it — no accounts, no phone numbers."
- **Composer reminder (persistent hint):** "Everyone nearby can read this. Nobody knows it's you."
- **Uplink toggle copy:** "Also publish to the World feed — readable by everyone on earth."
  (Default OFF. The toggle must convey planetary readability, not just "wider reach".)
- **"How privacy works" explainer (settings, short):** "Posts are public — not encrypted.
  Your identity is a random key on your phone, not your name or number. You can get a new
  identity anytime in settings (you'll lose the ability to delete old posts). We run no
  servers; public relays just pass posts along and can read them too."
- **Terminology discipline:** docs and all UI copy say **"anonymous"** (identity hidden),
  **NEVER "encrypted" or "private"** for post contents.

### Non-goals
- Microservices, Kubernetes, message brokers, AI agent frameworks — none apply to a mobile offline app
- Perfect Sybil resistance on view counts (accepted v1 risk, labeled "approximate device counts")
- Traffic-analysis resistance (documented v1 gap)
- Perfect relay availability (relays are third-party and untrusted; multi-relay is the mitigation)

---

## 3. Requirements inventory

### Functional
| ID | Requirement | Nodes |
|---|---|---|
| F-1 | Compose + broadcast a text post to nearby mesh | UI-3, FEED-2, EVENT-1, MESH-1..MESH-4 |
| F-2 | Receive, verify (CBOR→schema→Ed25519), and render posts | MESH-5..MESH-7, EVENT-2, UI-1 |
| F-3 | Feed ranked by views with time decay | FEED-1, FEED-3..FEED-5, STORE-2 |
| F-4 | Emit signed view receipts; dedupe per (key,post,24h) | FEED-6, EVENT-1, MESH-2 |
| F-5 | Location scoping via geohash cells | LOC-1, LOC-2, FEED-4 |
| F-6 | Store-and-forward + catch-up sync when rejoining | MESH-8, STORE-2, EVENT-4 |
| F-7 | Delete own post (tombstone event; authorship-checked) | UI-3, EVENT-1, STORE-2 |
| F-8 | Local search over received posts | UI-1, STORE-5 |
| F-9 | Offline diagnostics: log export, mesh stats screen | OBS-1..OBS-3, UI-6 |
| F-10 | Update via Obtainium / in-app release checker | DIST-1, DIST-2, APP-5 |
| F-11 | **Per-post uplink opt-in at compose** (toggle, default OFF); the uplink flag is part of the signed event; only flagged posts may be uplinked by online mesh members | UI-3, EVENT-1, RELAY-1 |
| F-12 | **World feed downlink:** fetch from user-configured Nostr relays over `wss` when internet is available; verify inner Ed25519 signatures client-side (relays untrusted); tag every world post with origin geohash; rank primarily by recency with the mesh view-count snapshot as secondary signal; label all counts approximate. Never blocks or delays the mesh path. | RELAY-2, RELAY-4, EVENT-2, UI-1 |
| F-13 | **Relay management:** add/remove relay URLs; ship sensible multi-relay defaults; relay-level filtering hooks (blocklist + subscription filters); no Airplane-operated relay | RELAY-3, UI-5 |
| F-14 | **Per-post locality indicator in UI:** "around you" vs "world" badge; origin-geohash label on world posts | UI-1, RELAY-4 |
| F-15 | **Privacy-model UX copy as launch gate** (§2.5): onboarding lines, composer reminder, "how privacy works" explainer, uplink-toggle copy; terminology discipline — "anonymous", never "encrypted"/"private" for contents | UI-2, UI-3, UI-5 |
| F-16 | **Moderation launch-gate set** (sideload-launch gate, built P5): per-key rate limits, local mute/block, per-post hide, keyword filter, relay filtering hooks (F-13). Acceptance bar: a protest-density feed stays usable under adversarial spam; no global takedown exists by design (user-curated, not platform-moderated) | UI-1, FEED-1, MESH-2, RELAY-3 |

RELAY-1…RELAY-n node IDs belong to the relay subsystem — defined by Worker 2 in
[SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) §1 and referenced here only. **Raw view receipts are NEVER
uplinked** (volume + gameability + viewer-privacy — threat rationale: OPERATIONS.md §10); the
uplink carries the post's mesh view-count snapshot only (Worker 2 specs the mechanism).

### Non-functional
| ID | Requirement | Target |
|---|---|---|
| NF-1 | Discovery latency (foreground) | ≤ 15 s median phone-to-phone (**ASSUMPTION** — validate P0) |
| NF-2 | Fragment delivery success | ≥ 95% over 50 trials, two phones (**ASSUMPTION** — validate P0) |
| NF-3 | Sustained GATT throughput floor | ≥ 8 kbps phone-to-phone (**ASSUMPTION** — validate P0) |
| NF-4 | Battery, foreground mesh | ≤ 20%/h — **P0 GO gate**; 8%/h is the **P5 stretch target** (ADR-10) |
| NF-5 | Cold start to interactive feed | ≤ 2 s on mid-range Android (**ASSUMPTION** — validate P2; supersedes the old 3 s; feed render ≤ 1 s for 500 posts) |
| NF-6 | Storage bound | LRU + TTL pruning; hard cap enforced |
| NF-7 | Privacy | **Contents public-by-design, identity anonymous** (§2.4): no accounts, no phone numbers, no PII anywhere; raw coordinates never stored; keys in Keychain/Keystore only; terminology — "anonymous", never "encrypted"/"private" for post contents |
| NF-8 | iOS↔Android interop | Foreground only (background cross-OS discovery: assumed impossible) |
| NF-9 | World feed never degrades the mesh | Uplink/downlink are opportunistic, internet-gated, and best-effort; the "Around you" feed is fully functional with zero internet; relay failures degrade only the World feed |

Full node inventory, data model, and contracts: [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md).
Reliability/perf/security analysis: [OPERATIONS.md](OPERATIONS.md) §11. Failure chains: §O.
Threat model (v2): [OPERATIONS.md](OPERATIONS.md) §10.

---

## 4. Headline architecture decisions

1. **React Native + Expo (dev build) over Flutter** — healthiest 2026 RN BLE plugin layer; Flutter's
   `flutter_blue_plus` went proprietary at 2.0 with a build phone-home (hostile to a privacy-first OSS
   project). ~30–40% of the hard work stays native Swift/Kotlin regardless of framework. (ADR-01)
2. **BLE GATT only — no Wi-Fi Direct / Multipeer interop** — the only transport that exists on both
   OSes with background modes; one transport = one security boundary, one test matrix, one battery
   model. (ADR-02)
3. **Append-only signed events, no CRDTs for v1** — flood meshes give at-least-once, unordered,
   duplicated delivery; append-only + idempotent upserts handle that trivially. Edits/deletes are new
   events (tombstones). (ADR-03)
4. **Views-based ranking via signed receipts** — `score = log(views)/age^gravity`, receipts deduped per
   (key, post, 24h); log scaling dampens Sybil gaming; counts labeled approximate, never used for
   trust or money. (ADR-04)
5. **SQLite (op-sqlite) + MMKV, behind port interfaces** — SQLite owns the event log (transactions,
   upserts, FTS5); MMKV owns hot sync scalars (ranking counters, cursors); secrets live in neither.
   Realm is dead (EOL Sep 2025); WatermelonDB stale. (ADR-05)
6. **Sideload-first distribution** — GitHub Releases APK + Obtainium updates; TestFlight for iOS.
   The product's threat model *includes* store removal (India §69A takedowns Oct 2026; Apple
   Guideline 1.2) — designing around stores makes the primary risk unmitigable. (ADR-06)
7. **Foreground-first mesh, background best-effort** — iOS background BLE is OS-crippled; promising
   background relay would be dishonest. Android is the relay backbone; iOS is opportunistic. (ADR-07)
8. **No backend / cloud, no analytics SDKs** — every server function has a serverless answer
   (discovery via BLE scan, updates via Obtainium, diagnostics local-first). Crash reporting is
   file-export diagnostics in v1, opt-in reporting in P5 (ADR-10). Third-party Nostr relays are
   untrusted dumb pipes, not our infrastructure (ADR-09). (ADR-08)

**New in v2 (full texts in [OPERATIONS.md](OPERATIONS.md) §13):**
9. **ADR-09 — Hybrid transport:** local-first BLE mesh ("Around you") + opportunistic global
   relay over standard third-party Nostr relays ("World"); no Airplane backend, no Airplane-run
   relay; per-post uplink opt-in, default OFF.
10. **ADR-10 — Frozen v2 protocol constants + two standing decisions:** TTL 7 (default and
    ceiling), jitter 50–500 ms, battery budget 20%/h foreground, MMKV pinned v3.3.3 (v4
    evaluation deferred to P5); crash reporting = file-export diagnostics in v1, opt-in
    reporting in P5; identity model = stable per-device Ed25519 keypair (summary; mechanism in
    SYSTEM_DESIGN.md).

Full ADR texts (context/options/rationale/trade-offs/risks/reconsideration): [OPERATIONS.md](OPERATIONS.md) §13.
Key dependency picks: [OSS_RESEARCH.md](OSS_RESEARCH.md) §1.

### Highest-risk dependency (flagged, not assumed away)
`react-native-bluetooth-ble` (peripheral/advertise path) is **brand new (June 2026, 1 star)**. It is
wrapped behind the `MeshRadio`/`BleTransportPort` interface; `ble-manager` 12.x covers the proven
central path. If the lib dies, the fallback is a custom native module — the port interface is what
makes that survivable. **P0 must validate it on physical devices.**

### License facts that constrain reuse
- BitChat **iOS** repo: Unlicense (public domain) — safe design reference. **Do not copy from
  bitchat-android** (README says public domain, release notes say GPLv3 — unresolved).
- Reticulum: protocol public-domain, Python code under custom license — spec ideas only.
- Briar/Bramble: GPL-3.0 — ideas only, zero code.
- Project license recommendation: **Apache-2.0** (patent grant for protocol code; permissive for adoption).

---

## 5. Phased roadmap (summary)

| Phase | Name | Gate / outcome |
|---|---|---|
| **P0** | Radio spike (2 Android + 1 iPhone) | **GO/NO-GO:** discovery ≤15 s median, ≥95% fragment success, ≥8 kbps floor, ≤20%/h battery, iOS↔Android foreground interop. If the radio can't carry the flood, the thesis dies here. Deliverable includes the field-test script (`tools/field-test/`) — the gate is only real if it's scripted. |
| P1 | Foundation | Repo scaffold, `packages/protocol` (pure TS), event model, storage, simulator transport, CI; **protocol types + `Transport` interface frozen**. (Shipped 2026-10-10; sign/verify primitives only — KeyStorePort/stable identity is a P2 task.) |
| P2 | Local MVP (mesh UI, no radio) | Feed UI + composer + ranking against simulated data; **CRYPTO-1/KeyStorePort + stable per-device identity**; UI parallelizes after P1 freeze |
| P3 | Mesh MVP (two-phone flood) | Real flood, view receipts, geohash scoping; field tests on ≥4 Android OEMs |
| **P4** | **Global relay (NEW in v2)** | Uplink/downlink via third-party Nostr relays (RELAY-1…5); per-post opt-in (default OFF); World feed with origin-geohash tagging; relay directory + health. Acceptance: two-continent round-trip ≤5 min; negative opt-in test green |
| P5 | Hardening | iOS background best-effort, battery tuning (8%/h stretch), dense-crowd congestion, security review, **moderation launch-gate set** (per-key rate limits, local mute/block, relay filtering hooks), opt-in crash reporting |
| P6 | Distribution | Signed releases, Obtainium docs, TestFlight submission, launch runbook + mirrors |

Single highest-risk phase: **P0** (physics, not software). Second: P5 dense-crowd congestion (tunable).
Full phase plans with acceptance criteria and definitions of done: [ROADMAP.md](ROADMAP.md) §15.
Proposed repo structure (monorepo, node-mapped): [ROADMAP.md](ROADMAP.md) §14.

---

## 6. Architecture validation checklist (section 16 pass — coordinator)

- [x] **Feature→node mapping:** every F-1..F-16 maps to ≥1 node (§3 above; full mapping in ROADMAP.md §23.1; RELAY-* nodes defined by Worker 2 in SYSTEM_DESIGN.md §1)
- [x] **Node ownership:** 58 nodes, each with owner subsystem, interface, lifecycle (SYSTEM_DESIGN.md §4)
- [x] **Dependency justification:** every OSS dep has a matrix row with reason + fallback (OSS_RESEARCH.md)
- [x] **ID stability:** 58/58 registry IDs present in DIAGRAMS.md (script-verified by diagram worker)
- [x] **No dangling references:** spot-checked — MESH/EVENT/STORE port names consistent across SYSTEM_DESIGN, DIAGRAMS, OPERATIONS
- [x] **Contract coverage:** 6 boundaries with TS signatures, error contracts, timeouts (SYSTEM_DESIGN.md §6)
- [x] **Prohibited directions:** UI→FEED→EVENT→{MESH,STORE}; nothing depends upward; native behind TS ports (DIAGRAMS.md B)
- [x] **No cycles:** dependency graph manually verified acyclic (DIAGRAMS.md B)
- [x] **Failure coverage:** 8 failure chains with containment + recovery (OPERATIONS.md §O)
- [x] **Security in the design:** verify-before-render pipeline, trust boundaries, key storage (DIAGRAMS.md K/P)
- [x] **Testing mapped to nodes:** unit/property/simulator/device/E2E pyramid (DIAGRAMS.md N)
- [ ] **Mermaid render pass:** syntax-checked only — render DIAGRAMS.md once before publishing
- [ ] **P0 measurements:** all NF targets are assumptions until two physical phones say otherwise

---

## 7. Open questions & decisions for the parent

**Unresolved inconsistencies found during validation (flagged, not assumed):**
1. **MMKV version — RESOLVED:** pin **`react-native-mmkv` v3.3.3** at scaffold (MetaMask's 2026
   v4→v3 revert incident); v4.3.2 evaluation deferred to P5. Recorded in ADR-10; dependency
   map (OPERATIONS.md §8.4) updated.
2. **TTL default — RESOLVED:** `DEFAULT_TTL = 7`, hard ceiling 7, jitter 50–500 ms
   (BitChat-verified). Frozen as v2 protocol constants in ADR-10 (OPERATIONS.md §13).
3. **Crash reporting — RESOLVED:** **file-export diagnostics in v1; opt-in reporting in P5**
   (opt-in consent screen naming what leaves the device; Sentry-protocol sink behind
   `DiagnosticsPort`). Recorded in ADR-10; propagated to OPERATIONS.md §8.8 and §12 G-3.
   (SYSTEM_DESIGN.md OBS-3 is Worker 2's to reconcile.)
4. **minSdk 26** (ops worker's question): recommend **minSdk 26 (Android 8.0)** — BLE 5 advertising features need it; sub-26 is <5% of devices in 2026 and doubles the BLE test matrix. Needs your confirm.
5. **Hotfix-as-rollback:** Android forbids downgrades, so rollback = fast-forward hotfix. The release pipeline must stay <30 min or this is fiction. Confirm as policy.

**Highest-risk unknowns (need devices, not more docs):** iOS 26 background BLE behavior; GATT
throughput phone-to-phone; `react-native-bluetooth-ble` peripheral reliability; OEM BLE variance
(Xiaomi/Oppo/Vivo); FlashList `onViewableItemsChanged` under rapid inserts; cbor-x + noble on Hermes.
Full lists: [ROADMAP.md](ROADMAP.md) §24 (14 questions), [OPERATIONS.md](OPERATIONS.md) §12 (12 gaps).

**Next step when you're ready:** P0 radio spike — needs two Android phones + one iPhone and a
half-day field script (in ROADMAP.md §15). Everything after P0 depends on its numbers.
