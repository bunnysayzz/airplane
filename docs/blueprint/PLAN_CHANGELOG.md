# Airplane — PLAN_CHANGELOG (v1 → v2)

> **Date:** 2026-10-10 · **Status:** planning only — nothing here is pushed to `enginoor/airplane`.
> **Review gate:** per Tuba's standing rule, nothing from this re-plan lands in the repo until she has reviewed these deltas.
> v1 lives at `~/workspace/airplane-blueprint/` (frozen); v2 is `~/workspace/airplane-blueprint-v2/` (this directory).

## 0. Why v2 exists — the correction

Tuba's challenge, verbatim in spirit: *"pure offline can't show a Delhi protest to the world — everywhere in every corner can't use it and see what's happening."*

She was right. v1 assumed pure offline: posts travel phone-to-phone only, so a mesh is invisible
beyond radio range. That solves local coordination (people *at* the protest) but not global
visibility (the world seeing *what's happening there*). v2 keeps the mesh core untouched and adds
an opportunistic global layer.

## 1. Headline deltas (the 8 things that changed)

1. **Two-feed product.** "Around you" (BLE mesh, always works, geohash-scoped, zero internet —
   the v1 product, unchanged) + "World" (when the *viewer's* phone has internet, posts relayed
   from meshes everywhere, each tagged with origin geohash).
2. **Opportunistic Nostr relay uplink/downlink (new RELAY subsystem, RELAY-1…5).** Any phone in a
   mesh with internet can uplink opt-in posts to third-party Nostr relays (wss) as dumb pipes.
   Our events are Ed25519-signed, so relays are untrusted by design — they can't forge posts.
   **There is NO Airplane backend and NO Airplane-run relay** — the "no backend" principle holds;
   relays are third-party infrastructure like Nostr's.
3. **Uplink is OPT-IN per post at compose time, default OFF.** Safety-critical: a protester posting
   "cops at gate 3" to the local mesh must never have it silently broadcast globally. No global
   "always uplink" switch in v1. The opt-in is a signed `["uplink","1"]` tag inside the event, so
   *any* online mesh member (courier) can uplink it — which doubles as the deniability mitigation
   for relay IP↔post linkage.
4. **Privacy model made explicit: contents are PUBLIC, identity is ANONYMOUS.** A post is shouting
   in a public square — anyone in radio range or any relay operator can read it. No end-to-end
   encryption on post bodies in v1. What *is* protected: no accounts, no phone numbers, no PII —
   posts are signed by a device pseudonym. The app must say this in plain language (onboarding +
   composer copy drafted in ARCHITECTURE.md §2.5 — v1 launch gate). Docs and all future UI copy
   say "anonymous", never "encrypted"/"private" for contents.
5. **Identity model decided: stable per-device Ed25519 keypair** (new `packages/crypto` +
   `KeyStorePort`, Keychain/Keystore storage) — because tombstones need authorship continuity and
   receipt-dedup needs stable viewer keys. P1's throwaway-keypair-per-post made both meaningless;
   fixing it is an explicit **P2** task. Trade-off documented: stable key = linkable pseudonym
   across posts; rotation via settings burns old authorship. Relay identity is a *separate*
   unlinkable Nostr secp256k1 keypair (Nostr protocol requirement).
6. **New phase P4 = Global relay; hardening → P5; distribution → P6.** P0 (radio spike) and P1
   (foundation, already pushed) are unchanged. Moderation tooling is now a **sideload-launch gate**
   (G-1, built P5): per-key rate limits, local mute/block, relay filtering hooks — because v1
   launches via sideload with zero abuse tooling on an anonymous broadcast network, and the World
   feed amplifies abuse globally.
7. **All 25 v1 contradictions resolved.** One value per constant everywhere: TTL 7 (default+ceiling),
   jitter 50–500 ms, battery 20 %/h (P0 gate) / 8 %/h (P5 stretch), MMKV v3.3.3 pinned (v4→P5),
   crash reporting = file-export v1 / opt-in P5. Recorded in ADR-10 with a supersession list.
   Fragment header frozen to the P1 code layout (spec note, no ADR churn).
8. **Assumption register + named owners.** All 68 v1 ASSUMPTION tags registered
   (`docs/assumption-register.md`, +14 new v2); every §12 gap has a named owner (Tuba PM + subsystem).

## 2. Per-doc changes

| Doc | v1 → v2 |
|---|---|
| ARCHITECTURE.md | §1/§2 rewritten (two-feed product, binding privacy model §2.4, launch-gate UX copy §2.5, terminology discipline); §3 new FRs F-11…F-16 (uplink opt-in, downlink, relay management, locality indicator, privacy UX, moderation gate); NF-4/NF-5/NF-7 updated + NF-9 (world feed never degrades mesh); ADR-09/ADR-10 indexed; §5 roadmap table rewritten P0…P6 |
| SYSTEM_DESIGN.md | 58 → 63 nodes: RELAY-1…5 (§4.12, full per-node fields), CRYPTO subsystem + `KeyStorePort` (§4.7); normative Nostr adapter spec §7 (kind 1919 wrap, base64 embedding, `g`/`client`/`v` tags, two-trust-root signatures, receipts mesh-only, tombstones→kind 5); signed `["uplink","1"]` tag convention (EVENT-1/2); `IRelayClient`/`IRelayDirectory`/`IModerationStore` contracts (§6.7); Appendix D migration 002 (relay tables); unified constants |
| DIAGRAMS.md | 26 → 31 Mermaid diagrams: RELAY subsystem + third-party relay actor (A), L4b layer (B), RELAY component graph (C4), uplink/downlink data flows (G2), three new sequences (I6 round-trip, I7 offline viewer, I8 relay failure), trust boundary TB3 (K). All v1 IDs byte-identical |
| OPERATIONS.md | New §10 threat model (passive local observer sees all content; relay IP↔post linkage + mitigations; malicious relays; takedowns; device seizure; protected-vs-not table); §12 gaps all owned + Priority/Phase columns split; ADR-09 (hybrid transport) + ADR-10 (constants freeze); Tor → P5+ exploration; relay reputation → P5 |
| OSS_RESEARCH.md | New §7 Nostr ecosystem: NIP-01 essentials, relay software landscape, verified default relay list (`wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`, `wss://purplerelay.com`), client library matrix → **`nostr-tools` v2.x recommended (HIGH confidence)**, fallback hand-rolled NIP-01 codec |
| ROADMAP.md | P0 gains field-script authoring task (the missing GO/NO-GO gate script); **P4 = Global relay** fully specified (objectives, nodes, tests incl. two-continent round-trip ≤5 min + negative opt-in test, DoD); moderation launch-gates in P5 with owners; `packages/relay/` + `packages/crypto` in repo structure; "Deliberately absent" bans an Airplane-run relay |
| docs/assumption-register.md | **New.** 68 v1 + 14 v2 assumptions, each with validation plan + owner |

## 3. Audit P0 resolutions (from PLAN_REVIEW.md)

- **Missing identity/keystore layer** → decided (stable per-device keypair, `packages/crypto`, `KeyStorePort`) + explicit P2 task. P1 code reality: sign/verify primitives only.
- **Unenforced tombstone authorship** → authorship = stable keypair continuity; rotation semantics documented.
- **Missing P0 field script** → explicit P0 deliverable (`tools/field-test/`).
- **Crash-reporting contradiction** → decided once (file-export v1, opt-in P5), propagated everywhere.
- **Moderation gated on wrong event** → now a sideload-launch gate (G-1, P5) with acceptance bar.
- **25 contradictions** → unified constants + ADR-10; fragment header frozen to code.
- **64 orphaned ASSUMPTION tags** → register with owners and validation plans.

## 4. What stayed the same (do NOT churn)

- The 8 headline ADRs (RN+Expo, BLE GATT only, append-only signed events, views ranking, op-sqlite+MMKV behind ports, sideload-first, foreground-first mesh, no backend/analytics).
- The entire mesh core: flood engine, fragmenter, ranking formula, storage schema v1, port abstractions.
- P0 (radio spike) and P1 (foundation, pushed as `d7e9b01`) — still valid; P1's code needs no changes for v2 except the planned P2 identity work.
- The honest-limits posture (iOS background BLE crippled, no perfect Sybil resistance, traffic-analysis resistance out of scope).

## 5. Open items needing Tuba

1. **A-016 RESOLVED 2026-10-10:** English-only v1 — Tuba's call (was: Hindi-at-launch disputed).
2. **Kind 1919:** verified absent from the NIP kind registry on 2026-10-10 — re-check at build time (gated in P4).
3. **Default relays:** the 4 verified relays must be re-probed in the P3 interop test before shipping as defaults.
4. **Review gate:** nothing from this re-plan enters `enginoor/airplane` until she approves these deltas.
