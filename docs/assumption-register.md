# Airplane - Assumption Register

> **Created 2026-10-10 (v2 re-plan, Worker 1).** Resolves audit finding: 64 `ASSUMPTION` tags
> in SYSTEM_DESIGN.md + 4 in ARCHITECTURE.md with no register, ~half lacking any phase/owner
> tie. Every tag now has an ID, statement, source, validation plan (which phase/test retires
> it), owner, and status.
>
> **Conventions:** IDs are stable (`A-001`…); cite section/node, not line numbers (line numbers
> shift on edit). **Status:** `OPEN` = needs the validation plan · `FROZEN` = locked by ADR-10
> (wire/interop commitment) · `RESOLVED` = coordinator decision recorded · `DEFERRED` = named
> phase, not a validation item · `CONVENTION` = process rule, retired by this register ·
> `DISPUTED` = contradicts another doc, needs a decision.
>
> **How to retire an OPEN tag:** run the validation plan, record the outcome (confirm / change /
> reject) in PLAN_CHANGELOG.md, flip status. A changed wire-affecting value needs a PROTO_VER
> bump process, not a silent edit (ADR-10).
>
> **Excluded:** 2 `ASSUMPTION` mentions in PLAN_REVIEW.md are quotes inside the audit report
> itself (the "default TTL 8" alternative), not plan values - not registered.

## A. SYSTEM_DESIGN.md tags (A-001…A-064)

| ID | Statement | Source | Validation plan (phase/test) | Owner | Status |
|---|---|---|---|---|---|
| A-001 | Values tagged ASSUMPTION need physical-device validation (P0) | §0 conventions | Process rule - retired by this register | Tuba (PM) | CONVENTION |
| A-002 | ASSUMPTION = a design decision where the product spec / research did not fix the value | §0 conventions | Process rule - retired by this register | Tuba (PM) | CONVENTION |
| A-003 | `FLOOD_JITTER_MS` = 50–500 ms uniform per rebroadcast | §3 constants | FROZEN by ADR-10 (BitChat-verified); P0 spike measures crowd behavior against it | MESH | FROZEN |
| A-004 | `SEEN_LRU_CAP` = 10,000 entries (in-memory LRU + SQLite spillover) | §3 constants | P3 crowd test: memory use vs re-relay rate | MESH | OPEN |
| A-005 | `MAX_CONTENT_CHARS` = 280 (UTF-16 code units, NFC-normalized) | §3 constants; ARCHITECTURE.md §2.2 | Product review with Tuba at v1 scope freeze | Tuba (PM) | OPEN |
| A-006 | `MAX_EVENT_BYTES` = 4,096 (CBOR signed-event ceiling; posts ~200–600 B) | §3 constants | P1 property tests: oversize rejection at the boundary | EVENT | OPEN |
| A-007 | `IMPRESSION_MIN_MS` = 1,500 (≥50% visible counts as a view) | §3 constants | P2 UI testing (`onViewableItemsChanged` under rapid inserts) | FEED | OPEN |
| A-008 | `RANK_GRAVITY` = 1.5 | §3 constants | P2/P3 feed-quality review; tunable without wire impact | FEED | OPEN |
| A-009 | `DEFAULT_RETENTION_H` = 24 | §3 constants | Confirm with Tuba before beta (explicit in App E) | Tuba (PM) | OPEN |
| A-010 | `REASSEMBLY_TIMEOUT_MS` = 30,000 | §3 constants | P3 two-phone tests with slow/interrupted peers | MESH | OPEN |
| A-011 | `SYNC_BUDGET_EVENTS` = 50 per sync exchange | §3 constants | P3 catch-up sync tests | MESH | OPEN |
| A-012 | `SYNC_INVENTORY_N` = 200 newest event tags in SYNC_HELLO | §3 constants | P3 catch-up sync tests | MESH | OPEN |
| A-013 | Boot budget ≤ 2 s on mid-tier Android (migrations are the long pole) | §4.1 APP-1 | P2 boot profiling on target device class | APP | OPEN |
| A-014 | Background task timeout: OS kills at ~30 s iOS / ~10 min Android | §4.1 APP-3 | P5 background-behavior validation on devices | APP | OPEN |
| A-015 | Composer draft preserved across sheet dismiss via MMKV draft key | §4.2 UI-3 | P2 UI test | UI | OPEN |
| A-016 | English-only v1 (no Hindi locale bundle at launch) | §4.2 UI-7 | **RESOLVED 2026-10-10 - Tuba's call: English-only v1** (was: disputed en+hi) | Tuba (PM) | RESOLVED |
| A-017 | Feed re-rank tick every 30 s | §4.3 FEED-1 | P2: battery/jank trade-off measured on device | FEED | OPEN |
| A-018 | Full re-sort capped at 2,000 posts, then paginate by score cutoff | §4.3 FEED-1 | P2 perf test with 10k-event store | FEED | OPEN |
| A-019 | Views = lifetime-distinct-pubkeys (prior day-buckets carried forward) | §4.3 FEED-2 | Confirm with Tuba before beta (explicit in App E) | Tuba (PM) | OPEN |
| A-020 | Max 1 view receipt per 2 s app-wide (anti-storm on fast scroll) | §4.3 FEED-3 | P3 storm test: fast scroll, count emitted receipts | FEED | OPEN |
| A-021 | Geohash scope refresh on movement >~1 km | §4.3 FEED-4 | P3 field test | FEED / LOC | OPEN |
| A-022 | Jitter timers via single timer wheel, not per-event setTimeout (implementation guidance) | §4.4 MESH-2 | P1 code review | MESH | OPEN |
| A-023 | Broadcast fragmentation uses min MTU over connected peers | §4.4 MESH-3 | P0/P3 interop test with mixed-MTU peers | MESH | OPEN |
| A-024 | >4-fragment messages spill reassembly state to STORE-5 (survive background kills) | §4.4 MESH-4 | P3: large-post kill/resume test | MESH / STORE | OPEN |
| A-025 | Peer considered lost after 3 missed scan windows | §4.4 MESH-5 | P0 spike: RSSI/presence tuning | MESH | OPEN |
| A-026 | No device name in advertising packet (privacy; iOS background wouldn't carry it anyway) | §4.4 MESH-5 | Design rule - verify in P0 packet capture | MESH | OPEN |
| A-027 | Connection pool cap: 5 concurrent connects | §4.4 MESH-6 | P3 crowd test | MESH | OPEN |
| A-028 | Disconnect idle peers after >60 s | §4.4 MESH-6 | P3 crowd test | MESH | OPEN |
| A-029 | GATT profile layout - finalize before interop testing | §4.4 MESH-7; App B | P0 spike: freeze before any interop test | MESH | OPEN |
| A-030 | Balanced power mode: scan 30 s on / 30 s off | §4.4 MESH-9 | P0/P5 battery measurement | MESH | OPEN |
| A-031 | Auto-derate to saver on battery <30% unless user pins performance | §4.4 MESH-9 | P5 battery tuning | MESH | OPEN |
| A-032 | Per-peer broadcast queue cap 64 frames (shed lowest priority first) | §4.4 MESH-11 | P3 congestion test | MESH | OPEN |
| A-033 | BLE timeouts: connect 10 s, write 5 s, read 5 s | §4.4 MESH-12 | P0 spike on physical devices | MESH | OPEN |
| A-034 | On-device test matrix: Android 12–16, iOS 17–18 | §4.4 MESH-12 | Lab stand-up (OPERATIONS.md G-10); note audit C25 (iOS floor 16 vs 17) - align to 16+ unless BLE APIs require 17 | Tuba (PM) | OPEN |
| A-035 | `created_at` accept window [now−retention−skew, now+300 s] | §4.5 EVENT-2 | P1 property tests (boundary vectors) | EVENT | OPEN |
| A-036 | Tombstone whose target is unknown after sync: drop (vs store-and-apply) | §4.5 EVENT-2 | P2 decision review with Tuba | Tuba (PM) | OPEN |
| A-037 | Ed25519 verify ~1–2 ms via @noble/curves on mid Android (≤5 ms p99 budget) | §4.5 EVENT-2 | P1 benchmark gate (audit I8: one crypto stance + benchmark) | EVENT / CRYPTO | OPEN |
| A-038 | Skip LZ4 when input <64 B (LZ4 hurts tiny payloads) | §4.5 EVENT-4 | Deferred with EVENT-4 (P5 experiment); revisit only if compression ships | EVENT | OPEN (deferred) |
| A-039 | SQLite pragmas: `synchronous=NORMAL`, `foreign_keys=ON` | §4.6 STORE-1 | P1 corruption-recovery test | STORE | OPEN |
| A-040 | `queryFeed` ≤200 ms p99 at 10k events | §4.6 STORE-2 | P2: measure on device | STORE | OPEN |
| A-041 | `frag_buf` purged after 60 s (fragments are transport-ephemeral) | §4.6 STORE-5 | P1 unit test | STORE | OPEN |
| A-042 | Retention janitor runs every 15 min + on boot | §4.6 STORE-7 | P2: battery-impact review | STORE | OPEN |
| A-043 | `VACUUM` if janitor freed >10 MB | §4.6 STORE-7 | P2 | STORE | OPEN |
| A-044 | Private-key memory zeroing is best-effort (Hermes GC limits - documented limitation) | §4.7 CRYPTO-1 | Revisit when native crypto module lands | CRYPTO | OPEN |
| A-045 | Secure-store unavailable → fatal `KeyError` (identity required; no read-only boot) | §4.7 CRYPTO-1 | P2 UX review with Tuba | Tuba (PM) | OPEN |
| A-046 | `Accuracy.Low` (~1 km) is fine for geohash-5 | §4.8 LOC-1 | P3 field test (urban-canyon behavior) | LOC | OPEN |
| A-047 | OBS ring buffer: 1,000 entries | §4.9 OBS-1 | P2 | OBS | OPEN |
| A-048 | Persisted log tail: 200 entries to SQLite for post-crash inspection | §4.9 OBS-1 | P2 | OBS | OPEN |
| A-049 | Metrics: cumulative since boot, no history (boot-only) | §4.9 OBS-2 | P2 review | OBS | OPEN |
| A-050 | `sideload-ipa`: Apple ad-hoc distribution limits apply | §4.10 DIST-1 | Pre-TestFlight: verify ad-hoc limits | DIST / Tuba (PM) | OPEN |
| A-051 | Lint rule forbids test fixtures outside `test/` | §4.11 TEST-3 | P1: implement the lint rule | TEST | OPEN |
| A-052 | Peers pruned after 7 d inactive | §5.2 data-ownership | P2 | STORE | OPEN |
| A-053 | Cross-layer writes go through the owning repository interface (enforced by code review + import lint) | §5.2 data-ownership | P1: implement the import lint rule | TEST | OPEN |
| A-054 | Clock skew: accept `created_at` up to +300 s future (prevents rank gaming by future-dating) | §5.3 consistency | P1 property tests | EVENT | OPEN |
| A-055 | Tombstone row kept ≥ target post lifetime (late copies still suppressed) | §5.5 lifecycle | P1 unit test | STORE | OPEN |
| A-056 | MMKV draft key TTL 7 d | §5.5 lifecycle | P2 | STORE / UI | OPEN |
| A-057 | `requestMtu` timeout 5 s | §6 contracts (MESH-12) | P0 spike | MESH | OPEN |
| A-058 | `queryFeed` ≤200 ms p99 - contract restatement of A-040 | §6 contracts (STORE-2) | Same validation as A-040 | STORE | OPEN |
| A-059 | Fragment header: all multi-byte fields big-endian | App A | Frozen with the header layout (header layout itself needs ADR freeze per audit G4 - Worker 2/3's ADR) | EVENT / MESH | OPEN |
| A-060 | LZ4 magic branch (`0x4C5A`) in reassembler | App A | Deferred with EVENT-4 | EVENT | OPEN (deferred) |
| A-061 | GATT profile Appendix B - freeze before interop (restates A-029) | App B | Same validation as A-029 | MESH | OPEN |
| A-062 | BLE manufacturer company id `0xFFFF` (test range) | App B | Replace only if BLE-certified hardware ever ships; N/A for phones | MESH | OPEN |
| A-063 | Synced events decrement TTL as if flood-received | App C | P3: sync+flood interaction test | MESH | OPEN |
| A-064 | Retention default (24 h) + receipt day-bucket semantics - confirm with Tuba before beta | App E | Product review pre-beta | Tuba (PM) | OPEN |

## B. ARCHITECTURE.md tags (A-065…A-068)

| ID | Statement | Source | Validation plan (phase/test) | Owner | Status |
|---|---|---|---|---|---|
| A-065 | ASSUMPTION tags need P0 physical-device validation (convention) | §0 doc map | Process rule - retired by this register | Tuba (PM) | CONVENTION |
| A-066 | Post text-first, 280 chars (same value as A-005) | §2.2 in-scope | Same validation as A-005 | Tuba (PM) | OPEN |
| A-067 | NF targets are ASSUMPTIONs - validate P0/P3 (convention) | §3 requirements | Process rule - retired by this register | Tuba (PM) | CONVENTION |
| A-068 | TTL 7 / jitter 50–500 ms are BitChat-verified values tagged ASSUMPTION | §7 Q2 (resolved) | FROZEN by ADR-10 | MESH | FROZEN |

## C. New v2 assumptions (A-069…A-082 - added by Worker 1, 2026-10-10)

| ID | Statement | Source | Validation plan (phase/test) | Owner | Status |
|---|---|---|---|---|---|
| A-069 | Uplink is opt-in per post at compose time, default OFF; no global "always uplink" switch in v1 | ARCHITECTURE.md §2.1 | RESOLVED - coordinator decision 2026-10-10; revisit only with explicit product decision + threat-model review | Tuba (PM) | RESOLVED |
| A-070 | Third-party Nostr relays are untrusted dumb pipes; client verifies inner Ed25519 signatures on everything downlinked | ARCHITECTURE.md §2.1; OPERATIONS.md §10 | P3: interop test against ≥2 public relays | RELAY subsystem | OPEN |
| A-071 | World feed ranks primarily by recency; the mesh view-count snapshot is a secondary signal; all counts labeled approximate | ARCHITECTURE.md §3 F-12 | P3 UX review | FEED | OPEN |
| A-072 | Raw view receipts are NEVER uplinked; the uplink carries the post's mesh view-count snapshot only | ARCHITECTURE.md §3; OPERATIONS.md §10 | P3: network-capture test on the uplink path (assert no kind-2 events leave the device) | RELAY / FEED | OPEN |
| A-073 | Stable per-device Ed25519 identity keypair (not per-post throwaway); Keychain/Keystore via `KeyStorePort` | ARCHITECTURE.md §2.4; OPERATIONS.md ADR-10 | RESOLVED - coordinator decision; mechanism specified by Worker 2, built as KeyManager in P2 | CRYPTO (Worker 2) | RESOLVED |
| A-074 | Relay identity is a SEPARATE Nostr secp256k1 keypair (protocol requirement), unlinkable from the mesh keypair by default; optional signed binding for continuity | ARCHITECTURE.md §2.4; OPERATIONS.md ADR-10 | P3: verify unlinkability in relay traffic capture | CRYPTO / RELAY | OPEN |
| A-075 | "New identity" rotation orphans old posts' tombstones (they become unauthorizable) | ARCHITECTURE.md §2.4 | P2 UX review - settings copy must disclose this | Tuba (PM) | OPEN |
| A-076 | Tor is explicitly out of scope for v1; deferred to post-v1 exploration (P5+) | OPERATIONS.md §10.2 | Roadmap item, not a validation item | Tuba (PM) | DEFERRED |
| A-077 | Relay reputation scoring deferred post-v1 (P5 research); v1 relies on user curation | OPERATIONS.md §10.3 | Roadmap item, not a validation item | Tuba (PM) | DEFERRED |
| A-078 | Moderation launch-gate acceptance bar (F-16): per-key rate limits, local mute/block, per-post hide, keyword filter, relay filtering hooks - built in P5 as the sideload-launch gate | ARCHITECTURE.md §3; OPERATIONS.md §12 G-1 | P5 build + adversarial-spam test at protest density | Tuba (PM) + UI | OPEN |
| A-079 | Panic-wipe / duress flows deferred post-v1 (P5 exploration); v1 answer is honest disclosure | OPERATIONS.md §10.6 | Roadmap item, not a validation item | Tuba (PM) | DEFERRED |
| A-080 | Crash reporting: file-export diagnostics in v1, opt-in reporting in P5 | OPERATIONS.md §8.8, §12 G-3, ADR-10 | RESOLVED - coordinator decision 2026-10-10 | OBS | RESOLVED |
| A-081 | MMKV pinned v3.3.3 at scaffold; v4.3.2 evaluation deferred to P5 dev builds | OPERATIONS.md §8.4, ADR-10 | RESOLVED - coordinator decision 2026-10-10 | APP | RESOLVED |
| A-082 | Battery budget: ≤20 %/h foreground = P0 GO gate; 8 %/h = P5 stretch target | ARCHITECTURE.md §3 NF-4; OPERATIONS.md ADR-10 | RESOLVED - coordinator decision; gate measured at P0 | MESH | RESOLVED |

---

## Retired-orphan summary

Of the 68 v1 tags: **4 CONVENTION** (retired by this register), **2 FROZEN** (A-003, A-068 - ADR-10),
**1 RESOLVED** (A-016 - English-only v1, Tuba's call 2026-10-10), 2 deferred-with-node (A-038, A-060 - EVENT-4/LZ4),
**59 OPEN** with a phase/test and owner each. Zero tags remain without a validation plan or owner.
