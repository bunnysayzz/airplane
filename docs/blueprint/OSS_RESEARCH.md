# Airplane — Open-Source Research & Technology Selection

> Synthesized 2026-10-10 by the architecture coordinator from two OSS research workers
> (transport/crypto/storage; platform/observability/build/test). Verification discipline:
> **HIGH/MEDIUM/LOW** confidence per matrix row; nothing below was invented — package names,
> versions, licenses, and maintenance claims were checked against official repos/docs/registries
> on 2026-10-10. Items marked **UNVERIFIED** must be re-checked at scaffold time (P0/P1).

---

## 1. Recommendation summary (one line per capability)

| Capability | Recommended | Why (one line) | Confidence |
|---|---|---|---|
| BLE central (scan/connect/GATT) | `react-native-ble-manager` 12.x (v12.5.3 observed) | Most battle-tested RN central lib; Apache-2.0; healthy 2026 cadence | HIGH |
| BLE peripheral (advertise/GATT server) + background | `react-native-bluetooth-ble` | Only RN lib with peripheral on iOS+Android + L2CAP + background + Expo plugin | MEDIUM (young: Jun 2026, 1 star) |
| Central fallback | `@sfourdrinier/react-native-ble-plx` 3.9.x | Excellent central-only; peripheral is explicit backlog — verify license file | MEDIUM |
| Mesh protocol reference | BitChat **iOS** repo (Unlicense, public domain) | Borrow packet format, fragmentation, TTL-flood, store-and-forward design; reimplement in TS | HIGH |
| Set reconciliation (catch-up sync) | Nostr NIP-77 negentropy (reimplement algo in TS) | O(difference) sync is exactly the BLE catch-up problem | MEDIUM-HIGH |
| Ed25519 sign/verify | `@noble/ed25519` v2 (+ `@noble/hashes`) | MIT, maintained, pure-JS/Hermes-safe, ~11× faster than tweetnacl | HIGH |
| Secure key storage | `expo-secure-store` | Keychain/Keystore-backed, zero native config in Expo flow | HIGH |
| Binary encoding | `cbor-x` | MIT, maintained, RFC 8949, pure-JS works on Hermes; define canonical encoding for signed bytes | HIGH |
| Compression | **Skip for v1** | Sub-KB posts gain nothing; revisit at media-attachment milestone | MEDIUM |
| Message store + search | `@op-engineering/op-sqlite` | MIT, healthy, FTS5 plugin, SQLCipher option | HIGH |
| Hot KV (view counters, cursors) | `react-native-mmkv` (**start v3.3.3**; evaluate v4.3.2 in dev build) | Sync JSI, ~30× AsyncStorage; v4 had a 2026 revert incident at MetaMask — caution | HIGH (v3) / MEDIUM (v4) |
| App framework | Expo SDK 57 + expo-dev-client | Managed BLE manifests, config plugins, EAS pipeline; bare RN adds nothing | HIGH |
| Navigation | `expo-router` | File-based, typed routes, auto deep-linking | HIGH |
| Feed list | `@shopify/flash-list` v2 | View recycling, no blank cells; watch Android flattening bug #2399 (workaround known) | HIGH |
| UI state (offline-first) | `zustand` v5 + persist → MMKV | ~3KB, no provider, selectors, one-line persist | HIGH |
| Crash reporting | `@sentry/react-native` → **self-hosted GlitchTip**, OPT-IN default-off | Offline event queue; no third-party data; PII scrub in `beforeSend` | HIGH |
| On-device logs | Custom SQLite ring-buffer Logger + Share-sheet export | No maintained ring-buffer lib found in 2026 (~150 lines, we own it) | MEDIUM |
| Metrics | Custom local counters + in-app diagnostics screen | Hard privacy constraint: NO analytics SDKs, ever | HIGH |
| Native builds | EAS Build (free tier, 30/mo) | Zero infra, iOS without a Mac; fastlane+GH Actions as documented escape hatch | HIGH |
| Android signing | `apksigner` in CI, keystore as GH secret | Stable key = working Obtainium updates | HIGH |
| iOS distribution | EAS Submit (fastlane pilot fallback) | One command with EAS Build; needs $99/yr Apple Dev account | HIGH |
| Release automation | `softprops/action-gh-release@v3` (SHA-pinned) | Maintained, idempotent; pin SHA (supply-chain surface) | HIGH |
| Sideload updates | Obtainium (primary) + ~50-line in-app GitHub-release checker | Zero code for primary; offline-tolerant; defer expo-updates OTA to v2 | HIGH |
| Unit/component tests | Jest (jest-expo) + RNTL v14 | Standard, React 19, async APIs | HIGH |
| E2E tests | Maestro | YAML, black-box, physical-device capable, minutes of setup; Detox as fallback | HIGH |
| Protocol property tests | `fast-check` v4 | Flood/dedup/TTL invariants with shrinking; needs the simulator transport double | HIGH |
| Lint/format | Biome 2.x + `eslint-plugin-react-hooks` | One binary, ms-scale; plugin covers the one rule Biome lacks | HIGH |
| Git hooks | `lefthook` | Go binary, parallel, one YAML | HIGH |
| Vuln scanning | `google/osv-scanner-action` (SHA-pinned) + Dependabot + dependency-review | Credential-free, SARIF, OSV.dev malicious-packages feed | HIGH |
| i18n | Scaffold `i18next` now, English only; translate in v2 | Near-zero cost now, prevents string debt | MEDIUM |

**Deliberately rejected:** Realm (EOL Sep 2025), Isar (unmaintained), WatermelonDB (~14 months stale),
`flutter_blue_plus` (proprietary at 2.0 + build phone-home — hostile to a privacy-first OSS project),
Bridgefy (proprietary, broken security history), OrbitDB/GunDB (wrong fit for production v1),
any analytics SDK (privacy constraint), EAS Update SaaS (privacy + offline-first — deferred to v2 self-host).

---

## 2. Transport / mesh / crypto / encoding / storage — full selection matrix

> Source: transport research worker, 2026-10-10. Verdicts: **bold** = recommended.

### MANDATORY (v1 ship path)

| Capability | Requirement | Candidates | Recommended | Reason | Alternatives considered | Integration method | Language/runtime compat | License implications | Performance | Maintenance/community | Known limitations | Confidence | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BLE central (scan/connect/GATT) | Pull feed items from peers | react-native-ble-manager 12.x; @sfourdrinier/react-native-ble-plx 3.9.x | **react-native-ble-manager 12.x** (v12.5.3 observed) | Most battle-tested RN central lib; Apache-2.0; healthy 2026 release cadence; 53k weekly downloads | sfourdrinier fork (excellent, but no peripheral either) | Embed (npm) | iOS 15.1+, Android API 23+, RN 0.76+ new-arch, Hermes OK | Apache-2.0 ✅ | Mature, event-driven | Snyk "Healthy"; active maintainer | **Central-only** — cannot advertise; no L2CAP | High | sfourdrinier fork as central fallback |
| BLE peripheral (advertise/GATT server) + background | Broadcast presence; serve feed items to centrals | react-native-bluetooth-ble; (ble-manager: no; ble-plx fork: backlog P3) | **react-native-bluetooth-ble** | Only RN lib covering peripheral on iOS+Android + L2CAP + background sessions + Expo plugin, with honest capability gating | Write custom native module (months of work) | **Wrap** behind a `MeshRadio` interface (npm dep, abstracted) | Expo SDK 50+, RN ≥0.78, Nitro; dev-build required (no Expo Go) | Apache-2.0 ✅ | Nitro (JSI) | Young (June 2026, 1 star, 78 commits); org active | Unproven at scale; iOS bg limits are OS-level and apply regardless | Medium | Custom native module if lib dies; ble-manager stays for central |
| Ed25519 sign/verify | Post authorship, self-certifying identities | @noble/ed25519 v2; tweetnacl; libsodium wrappers | **@noble/ed25519** (+ @noble/hashes) | MIT; maintained; pure JS (Hermes-safe); ~11× faster signing than tweetnacl (7,275 vs 651 ops/s) | tweetnacl (dead, slow — test oracle only) | Embed (npm) | Pure TS, any JS runtime; needs react-native-get-random-values | MIT ✅ | High (paulmillr) | Active | Async API in v2; verify 2k ops/s is fine for feed scale | High | tweetnacl for cross-check tests |
| Secure key storage | Persist identity private key | expo-secure-store; react-native-keychain | **expo-secure-store** | Keychain (iOS) / Keystore (Android) backed; zero native config in Expo flow; used for wallet keys in production apps | react-native-keychain (finer biometric control — later) | Embed (Expo module) | iOS + Android | Expo (MIT-ish/BSD) ✅ | Hardware-backed where device supports | High (Expo team) | Accessibility-level choice (bg access vs this-device-only) is a real tradeoff to document | High | react-native-keychain |
| Binary encoding | Tiny BLE payloads | cbor-x; msgpackr; cborg; @msgpack/msgpack | **cbor-x** | MIT; maintained (15d ago); RFC 8949; pure-JS path works on Hermes; tag registry useful for sig/pubkey fields | cborg (deterministic — consider for signing path); msgpackr | Embed (npm) | Any JS runtime | MIT ✅ | Tiny codec; correctness matters more than GB/s claims | High | Must define canonical-encoding rule for signed bytes; verify against 2nd impl | High | cborg |
| Embedded DB (message store + search) | Posts, fragments, receipts, sync state; local FTS | @op-engineering/op-sqlite; (Realm dead; Isar dead) | **@op-engineering/op-sqlite** | MIT; healthy (1k stars, updated ~10d ago); FTS5 plugin + custom tokenizers; SQLCipher option; reactive queries | margelo/react-native-nitro-sqlite (newer, Nitro — watch) | Embed (npm) | iOS/Android/macOS/web; C++/JSI | MIT ✅ | Fast; sync+async APIs | Medium-High | Overlaps MMKV's KV; FTS5 Indic tokenization is custom work | High | react-native-nitro-sqlite |
| Hot KV store | View counters (ranking!), cursors, prefs | react-native-mmkv v4; op-sqlite KV | **react-native-mmkv** | MIT; Nitro/JSI synchronous; ~30× AsyncStorage; healthy maintenance | op-sqlite built-in KV (drop MMKV if binary size bites) | Embed (npm) | iOS/Android/Web | MIT ✅ | Ideal for ranking hot path | High | <~100MB guidance; not for message history | High | op-sqlite KV store |

### OPTIONAL / EXPERIMENTAL

| Capability | Requirement | Candidates | Recommended | Reason | Alternatives considered | Integration method | Language/runtime compat | License implications | Performance | Maintenance/community | Known limitations | Confidence | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| L2CAP CoC streams | Future media attachments | react-native-l2cap; (bundled L2CAP in react-native-bluetooth-ble) | **defer** — use bundled L2CAP APIs in react-native-bluetooth-ble if needed | Standalone lib is experimental (120d since update, license unverified); bundled API avoids a 2nd native dep | — | Later | iOS + Android 10+ | Unverified for standalone lib ⚠️ | High throughput when needed | Low (standalone) | Not needed for tiny text payloads | Medium | Write custom if bundled path fails |
| Compression (LZ4) | Shrink payloads | lz4js (stale); custom native LZ4 module | **skip for v1** | Sub-KB posts gain ~nothing (frame overhead can expand); CPU cost on Hermes not worth it | gzip/deflate via JS (slow) | Later: custom Nitro module wrapping LZ4 C | BSD-2-Clause (LZ4) ✅ | N/A now | Stale pure-JS option only | Low-Medium | Revisit at media-attachment milestone | Medium | Ship uncompressed |
| libsodium native crypto | Faster crypto / future XChaCha20, Argon2 | @void/sodium-universal; react-native-sodium (ammarahm-ed) | **defer** — keep `CryptoProvider` interface | noble is fast enough for Ed25519 at feed scale; native modules add build complexity for zero v1 benefit | — | Later | JSI/native | ISC ✅ | 10-40× faster than JS | Fragmented; ammarahm-ed fork most active (41d) | Community thin; prebuild complexity | Medium | Stay on noble |
| Mesh spec reference | Packet format, flood logic | BitChat (Unlicense iOS) | **spec/design reference only** | Public domain; 36.5k stars; WHITEPAPER.md + 1,078 commits of real-world BLE mesh lessons | — | Vendored docs w/ pinned commit | Swift/Kotlin (reimplement in TS) | Unlicense ✅ (iOS repo; Android repo license ambiguous — avoid copying from it) | Proven flood+fragment design | Very high | Had historical security issues — reuse framing, not trust model | High | Reticulum addressing ideas |
| Set reconciliation | Store-and-forward catch-up ("what did I miss?") | NIP-77 negentropy | **reimplement algorithm in TS from spec** | O(difference) sync is exactly the BLE catch-up problem; TS ref impl exists for study | naive "send everything since X" (wasteful) | Custom TS (~200 lines) | Pure TS | Spec open ✅ | Bandwidth-optimal | Spec stable; ndk TS impl exists | Frame budget must be tuned down for BLE MTU | Medium-High | Timestamp/cursor-based sync |
| Biometric-bound keys | Higher-assurance identity keys | react-native-keychain | **defer to post-v1** | SecureStore suffices for v1 | — | Later | iOS + Android | MIT ✅ | — | Healthy | Adds auth UX friction | Medium | expo-secure-store |

### Overlapping libs (call-out)

- **react-native-ble-manager ∩ react-native-bluetooth-ble ∩ ble-plx fork:** all three do central scan/connect/GATT. Only react-native-bluetooth-ble does peripheral. Keep ble-manager (central, proven) + wrap react-native-bluetooth-ble (peripheral + extras); the overlap is intentional redundancy on the central path during the lib's infancy.
- **op-sqlite KV ∩ react-native-mmkv:** real overlap; keep both deliberately (MMKV = sync hot path for ranking counters; op-sqlite = durable message store + FTS5). Revisit if binary size matters.
- **cbor-x ∩ cborg:** both CBOR; cbor-x for general codec, cborg only if you want its deterministic-encoding strictness for the signing path.

---

---

## 3. Platform / observability / build / distribution / testing / tooling — full selection matrix

> Source: platform research worker, 2026-10-10.

### MANDATORY

| Capability | Requirement | Candidates | Recommended | Reason | Alternatives considered | Integration method | Language/runtime compat | License implications | Performance | Maintenance/community | Known limitations | Confidence | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| App framework | iOS+Android, BLE native modules, OSS-friendly | Expo SDK 57 dev builds; bare RN | **Expo SDK 57 + expo-dev-client** | Managed BLE permission manifests, config plugins, EAS/dev-build pipeline; bare RN adds nothing | Bare RN | Embed (managed workflow, CNG) | RN 0.86 / React 19.2 / Hermes / Node ≥22 | MIT (Expo) | New Arch mandatory, Hermes default | SDK 57 stable; 58 in beta | Expo Go not on stores for newest SDKs — dev builds required anyway | HIGH | Bare RN + prebuild |
| Navigation | Simple feed/compose/settings, deep links | expo-router; React Navigation | **expo-router** (~57.0.x) | File-based, typed routes, auto deep-linking; built on RN underneath | React Navigation direct | Embed | TS, Hermes | MIT | Equivalent to RN | Default for new Expo apps 2026 | Less low-level control (not needed here) | HIGH | React Navigation static config |
| Feed list | Long dynamic list, views-ranked | FlashList v2; FlatList | **@shopify/flash-list v2** | View recycling, no blank cells, JS-only, new-arch | FlatList | Embed (npm) | RN new-arch only | MIT | Best-in-class for long lists | v2.3.1 Sep 2026, active | Android flattening bug #2399 (workaround known); v2 won't run on old arch | HIGH | FlatList |
| UI state (offline-first) | Small-team, persistable, Hermes-safe | zustand v5; jotai; Redux Toolkit | **zustand v5** (+persist→MMKV) | ~3KB, no provider, selectors, one-line persist | jotai (atomic, good 2nd), RTK (overkill) | Embed (npm) | TS-first, Hermes-safe | MIT | Negligible overhead | v5.0.14 in 2026 stacks, active | v5 dropped default exports (small migration) | HIGH | jotai |
| Fast KV storage | Settings, persist, counters | react-native-mmkv; AsyncStorage | **react-native-mmkv** (v3.3.3 start, eval v4.3.2) | Sync, fast (~20ms cold persist), no 6MB cap | AsyncStorage (6MB cap, 2MB/entry limit) | Embed (npm, native module) | Nitro/TurboModules, new-arch | MIT (+BSD-3 MMKV core) | Fastest option | 4.3.2 Jun 2026, active; v4→v3 revert seen at MetaMask — verify | v2 crashes on new-arch; v4 needs Nitro | HIGH (MEDIUM on v4) | AsyncStorage |
| Crash reporting | Offline-tolerant, privacy-respecting | Sentry SDK→sentry.io; Sentry SDK→GlitchTip; none | **@sentry/react-native → self-hosted GlitchTip, OPT-IN** | Offline event queue; same-SDK DSN swap; no third-party data | sentry.io SaaS (privacy ✗), no reporter (blind) | Embed SDK (npm) + self-host backend (compose) | Hermes, new-arch, Expo plugin | MIT (SDK); GlitchTip MIT | Negligible when opted out (no-op) | Sentry SDK active; GlitchTip active | Need to run the GlitchTip box; free SaaS tier is 1 user | HIGH | No reporter in v1; file-based export only |
| On-device logs | Ring buffer, user-exportable, offline | custom module; react-native-logs [UNVERIFIED] | **Custom Logger (SQLite ring buffer + Share export)** | No maintained lib verified; keeps data on-device | react-native-logs (check first) | Wrap (our code) | TS | Ours (MIT) | Bounded (5k entries/2MB) | N/A (ours) | We own the code (~150 lines) | MEDIUM | console-only + export |
| Offline metrics | Aggregates, no phoning home | custom SQLite counters; PostHog/Amplitude (✗) | **Custom local counters + in-app diagnostics screen** | Hard privacy constraint rules out all analytics SDKs | Any analytics SDK — REJECTED | Wrap (our code) | TS/SQLite | Ours | Trivial | N/A | No remote dashboards by design | HIGH | None needed |
| Native builds | Signed APK/IPA, no Mac owned | EAS Build free; GH Actions+gradle/xcodebuild | **EAS Build (free tier, 30/mo)** | Zero infra, iOS without Mac, 30 builds/mo enough for v1 | fastlane+GH Actions local (escape hatch) | SaaS (account) | Cloud | SaaS ToS (no license issue for OSS) | Standard queue at peak | Expo active | Paid-tier pricing fluid; cloud dependency | HIGH | expo prebuild + fastlane |
| Android signing | Stable key for sideload updates | apksigner+GH secret; EAS-managed | **apksigner in CI, keystore as GH secret** | Same-key + versionCode = Obtainium updates work | EAS-managed creds (opacity) | Embed standard tooling | JDK/Gradle | Apache-2.0 (build-tools) | N/A | Android platform | Guard the keystore; document SHA-256 | HIGH | EAS credentials |
| iOS distribution | TestFlight without store listing risk | EAS Submit; fastlane pilot | **EAS Submit** (fastlane pilot fallback) | One command with EAS Build | fastlane pilot (if local pipeline) | SaaS/CLI | macOS cloud or local | fastlane MIT | N/A | fastlane 2.233.1 Apr 2026, active | Needs $99/yr Apple Dev account | HIGH | fastlane pilot |
| Release automation | Tag → signed APK on Releases | softprops/action-gh-release; gh CLI | **softprops/action-gh-release@v3 (SHA-pinned)** | Maintained, node24, idempotent | `gh release create` (zero-dep alternative) | GH Action | N/A | MIT | N/A | v3.0.3 Sep 2026, active | Third-party action = supply-chain surface (pin SHA) | HIGH | gh CLI run-step |
| Sideload updates | Update prompts without a store | Obtainium; in-app checker; expo-updates OTA | **Obtainium (primary) + in-app GH-release checker (secondary)** | Zero code for primary; ~50 lines for checker; offline-tolerant | expo-updates+self-host (defer to v2) | Docs + tiny fetch | N/A | Obtainium GPL-3.0 (app, not linked) | N/A | Obtainium active | Android shows install confirmation per update (OS-level) | HIGH | Manual APK download |
| Unit/component tests | Fast, RN-aware | Jest+jest-expo; RNTL v14 | **Jest (jest-expo) + RNTL v14** | Standard, async APIs, React 19 | — | Embed (devDeps) | Node 22+, TS | MIT | Fast | RNTL v14 Jun 2026, active | — | HIGH | — |
| E2E tests | Real-device capable, low setup | Maestro; Detox | **Maestro** | YAML, black-box, physical devices, minutes setup | Detox (gray-box, sim-only-ish, heavy setup) | External CLI (no app changes) | N/A | Apache-2.0 | Fast iteration | Rising default 2026 | YAML limits for complex logic | HIGH | Detox |
| Protocol fuzz | Flood/dedup/TTL invariants | fast-check; none | **fast-check v4** | Dominant TS PBT lib, shrinking, Jest-native | Hand-rolled random (worse) | Embed (devDep) | TS | MIT | Test-time only | v4.7.0 Apr 2026, active | Needs the simulator transport double to be useful | HIGH | Example-only tests |
| Lint/format | Fast CI, greenfield | Biome 2.x; ESLint+Prettier | **Biome 2.x + eslint-plugin-react-hooks** | One binary, 20–100× faster, near-Prettier output | ESLint+Prettier (slower, bigger ecosystem) | Embed (devDep) | N/A | MIT (Biome) | ms-scale | Biome 2.5.7 Aug 2026, active | No native react-hooks rules (covered by plugin) | HIGH | ESLint flat + Prettier |
| Git hooks | Fast staged checks | lefthook; husky | **lefthook** | Go binary, parallel, one YAML | husky (fine, heavier) | Embed (devDep) | N/A | MIT | ~10ms startup | Active, growing | Smaller community than husky | HIGH | husky |
| Vuln scanning | OSS supply-chain trust | OSV-Scanner; npm audit; Dependabot | **google/osv-scanner-action (SHA-pinned) + Dependabot + dependency-review** | Credential-free, SARIF, OSV.dev incl. malicious-packages feed | npm audit (noisy), Trivy (overkill) | GH Action | N/A | Apache-2.0 | CI-only | v2.3.8 Sep 2026 pattern, active | Advisory-based (can't catch novel malware pre-disclosure) | HIGH | npm audit |

### OPTIONAL / EXPERIMENTAL

| Capability | Requirement | Candidates | Recommended | Reason | Alternatives considered | Integration method | Language/runtime compat | License implications | Performance | Maintenance/community | Known limitations | Confidence | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OTA JS updates | Patch JS without full APK | EAS Update SaaS; xprem self-host; cloudflare worker | **DEFER to v2; then xprem or CF worker self-hosted** | Offline-first app gains little; adds server ops | EAS Update (privacy ✗) | Self-host server + expo-updates client | TS/JS | xprem: MIT+Enterprise (read terms) | N/A | xprem updated Oct 2026 | Native/BLE changes still need APK; useless offline | MEDIUM | Obtainium full-APK updates |
| i18n | v2 translations | i18next+react-i18next+expo-localization | **Scaffold now (en only), translate in v2** | Near-zero cost, prevents string debt | — | Embed | TS | MIT | Negligible | Standard stack | Exact latest versions unverified — pin at scaffold | MEDIUM | Hardcoded en (debt) |
| MMKV v4 | Nitro-based speed | v4.3.2 vs v3.3.3 | **Evaluate v4 in dev build; ship v3.3.3 if any doubt** | MetaMask reverted v4→v3 over a migration crash in 2026 | — | Embed | Nitro Modules | MIT | v4 marginally faster | Active | v4 API changes (factory vs class) | MEDIUM | v3.3.3 |

### Overlap callouts
- **Sentry SDK vs GlitchTip:** not competitors — GlitchTip is the *backend* for the Sentry SDK (DSN swap). Do not add Bugsnag/Crashlytics alongside.
- **EAS Build vs fastlane+GH Actions:** alternatives, not complements. Pick EAS for v1; keep the fastlane path as documented escape hatch (CNG makes switching cheap).
- **Maestro vs Detox:** pick Maestro; Detox only if gray-box RN sync becomes necessary.
- **softprops/action-gh-release vs gh CLI:** pick one (softprops pinned, or gh CLI for zero third-party code).
- **lefthook vs husky:** pick one.
- **Biome vs ESLint+Prettier:** Biome primary; the only ESLint retained is `eslint-plugin-react-hooks`.

---

---

## 4. Overlap callouts (one choice per capability)

**Transport overlaps:**

### Overlapping libs (call-out)

- **react-native-ble-manager ∩ react-native-bluetooth-ble ∩ ble-plx fork:** all three do central scan/connect/GATT. Only react-native-bluetooth-ble does peripheral. Keep ble-manager (central, proven) + wrap react-native-bluetooth-ble (peripheral + extras); the overlap is intentional redundancy on the central path during the lib's infancy.
- **op-sqlite KV ∩ react-native-mmkv:** real overlap; keep both deliberately (MMKV = sync hot path for ranking counters; op-sqlite = durable message store + FTS5). Revisit if binary size matters.
- **cbor-x ∩ cborg:** both CBOR; cbor-x for general codec, cborg only if you want its deterministic-encoding strictness for the signing path.

**Platform overlaps:**

### Overlap callouts
- **Sentry SDK vs GlitchTip:** not competitors — GlitchTip is the *backend* for the Sentry SDK (DSN swap). Do not add Bugsnag/Crashlytics alongside.
- **EAS Build vs fastlane+GH Actions:** alternatives, not complements. Pick EAS for v1; keep the fastlane path as documented escape hatch (CNG makes switching cheap).
- **Maestro vs Detox:** pick Maestro; Detox only if gray-box RN sync becomes necessary.
- **softprops/action-gh-release vs gh CLI:** pick one (softprops pinned, or gh CLI for zero third-party code).
- **lefthook vs husky:** pick one.
- **Biome vs ESLint+Prettier:** Biome primary; the only ESLint retained is `eslint-plugin-react-hooks`.

**Coordinator resolutions (conflicts between workers):**

- **MMKV version:** start `v3.3.3`; evaluate `v4.3.2` in the dev build before adopting (platform worker's caution wins — MetaMask's 2026 v4→v3 revert).
- **LZ4:** **skip for v1** (sub-KB payloads; stale pure-JS option). Revisit at the media-attachment milestone (post-v1 measurement).
- **Crash reporting — DECIDED (ADR-10):** file-export diagnostics in v1 (local ring buffer + user-triggered export); opt-in reporting (Sentry-protocol sink behind `DiagnosticsPort`, self-hosted GlitchTip) lands in P5. No upload without explicit consent, ever.
- **BLE stack shape:** `ble-manager` (central, proven) + `react-native-bluetooth-ble` wrapped behind a `MeshRadio`/`BleTransportPort` interface (peripheral, young). The ble-plx fork stays a central-only fallback; verify its license file before use.
- **BitChat reference:** use the **iOS** repo (Unlicense) for packet/flood/fragment design; **do not copy from bitchat-android** (README says public domain, release notes say GPLv3 — unresolved conflict).

---

## 5. License compatibility summary

| Dependency | License | Compatible with Apache-2.0 app | Notes |
|---|---|---|---|
| react-native-ble-manager | Apache-2.0 | ✅ | |
| react-native-bluetooth-ble | Apache-2.0 | ✅ | Young project; re-verify at scaffold |
| @noble/ed25519, @noble/hashes | MIT | ✅ | |
| expo-secure-store / Expo SDK | MIT/BSD | ✅ | |
| cbor-x | MIT | ✅ | |
| @op-engineering/op-sqlite | MIT | ✅ | |
| react-native-mmkv | MIT (+BSD-3 core) | ✅ | |
| @shopify/flash-list | MIT | ✅ | |
| zustand | MIT | ✅ | |
| expo-router | MIT | ✅ | |
| @sentry/react-native | MIT | ✅ | SDK only; GlitchTip backend is MIT, self-hosted |
| Jest, RNTL, fast-check, Biome, lefthook | MIT | ✅ | devDeps |
| Maestro | Apache-2.0 | ✅ | external CLI, not linked |
| Obtainium (update channel) | GPL-3.0 | ✅ | Not linked — separate app the user installs |
| BitChat iOS (reference only) | Unlicense (public domain) | ✅ | Design reference; reimplement in TS, do not vendor code blindly |
| Briar/Bramble (ideas only) | GPL-3.0 | ⚠️ ideas only | Do not ship derived code |
| Reticulum Python code | custom "Reticulum License" | ⚠️ spec only | Protocol is public domain; use spec ideas, not code |
| react-native-l2cap (standalone) | **UNVERIFIED** | ❓ | Do not use until license verified |

**Project license recommendation: Apache-2.0** (see ROADMAP.md §14.1 — patent grant matters for protocol/mesh code; permissive for maximum adoption; GPL would deter forks/ports).

---

## 6. Unverified / needs validation (re-check at scaffold / P0)

**Transport/crypto/storage:**

## Unverified / needs physical-device testing

1. **react-native-bluetooth-ble real-world behavior** — peripheral advertising + background sessions on physical iOS and Android devices (only 1 star, 78 commits; emulator testing is insufficient for BLE). Highest-risk dependency in the stack.
2. **iOS background BLE limits on iOS 26** — verify suspend/terminate behavior on a physical device running current iOS; AccessorySetupKit relaunch rules may further restrict the mesh.
3. **@sfourdrinier/react-native-ble-plx fork license file** — verify Apache-2.0 (or compatible) before making it the central fallback.
4. **react-native-l2cap license** — unverified; check before any use.
5. **bitchat-android license conflict** — release notes say MIT→GPLv3, README says public domain; resolved by using only the iOS repo as reference, but flag for the record.
6. **cbor-x on Hermes** — pure-JS path should work, but encode/decode round-trip + canonical-encoding tests must run on-device (Hermes lacks some JS builtins).
7. **@noble/ed25519 v2 async API + react-native-get-random-values** — verify CSPRNG wiring and sign/verify round-trip on both platforms.
8. **op-sqlite FTS5 plugin in the Expo prebuild flow** — verify the FTS5 compilation flag actually ships in the EAS-built binary.
9. **BLE throughput reality check** — GATT notify throughput phone-to-phone (expect ~1–5 KB/s usable); this sizes the fragment budget and the negentropy frame size. Measure on two physical phones, not emulators.
10. **Reticulum Python "Reticulum License" terms** — not fully read; irrelevant if only the public-domain protocol spec is used, but confirm before quoting any Reticulum text in docs.

**Platform/build/test:**

## Unverified / needs validation

- [ ] Exact latest versions at scaffold time: `i18next`/`react-i18next`, `@sentry/react-native`, `expo-router` 57.0.x patch, `jotai` (if reconsidered) — pin from npm, don't copy from this doc.
- [ ] `react-native-mmkv` v4.3.2 vs v3.3.3 in the actual dev build (Nitro Modules interaction with the BLE native module).
- [ ] `react-native-logs` maintenance status — only if the custom logger is reconsidered.
- [ ] EAS paid-tier pricing at decision time (sources disagree: $29 vs $99/mo) — free tier terms re-check before launch.
- [ ] xprem license ("MIT + Enterprise") terms — read before any v2 OTA adoption.
- [ ] GlitchTip deployment target/ops owner (who runs the box, backup of crash data).
- [ ] Apple Guideline 1.2 review risk for the TestFlight build (anonymous broadcast feed) — worker 5/6 scope, but the TestFlight path assumes it passes.
- [ ] FlashList v2.3.x + `onViewableItemsChanged` behavior for the views counter under rapid inserts (validate with the simulator transport).
- [ ] Whether `expo-updates` (if ever adopted) is acceptable in the TestFlight build under Apple's OTA rules — keep to bug-fix-only updates.

---

## 7. Nostr ecosystem — relay subsystem (v2 research, worker 2, 2026-10-10)

> Verification discipline: protocol facts checked against `nostr-protocol/nips` (NIP-01 `01.md`,
> NIP-09 `09.md`) and the NIP kind registry via web search on 2026-10-10. Relay liveness claims are
> second-hand (2026 field probes by third-party clients) — the directory re-validates at build time.

### 7.1 Protocol essentials (NIP-01, verified)

- **Event** (the only object type): `{id, pubkey, created_at, kind, tags, content, sig}`.
  `id` = 32-byte lowercase-hex sha256 of the UTF-8 JSON (no whitespace) of
  `[0, pubkey, created_at, kind, tags, content]`. `pubkey` = 32-byte hex **x-only secp256k1** key.
  `sig` = 64-byte hex **Schnorr signature per BIP-340** over `id`. (NIP-01: "Signatures, public key
  and encodings are done according to the Schnorr signatures standard for the curve `secp256k1`.")
  This is why Airplane needs a *separate* relay keypair — our Ed25519 mesh key cannot sign Nostr
  events. Verified 2026-10-10.
- **Wire:** WebSocket (`wss://`). Client→relay: `["EVENT", <event>]`, `["REQ", <sub-id>, <filter>...]`,
  `["CLOSE", <sub-id>]`. Relay→client: `["EVENT", <sub-id>, <event>]`, `["OK", <id>, <bool>, <msg>]`,
  `["EOSE", <sub-id>]`, `["CLOSED", <sub-id>, <msg>]`, `["NOTICE", <msg>]` (plus `AUTH`/`ECOUNT` in
  later NIPs). Filters support `ids`, `authors`, `kinds`, `#<single-letter>` tag queries (indexed by
  relays), `since`/`until`/`limit`.
- **Kind ranges (NIP-01):** regular/stored `1000–9999` (+ `4–44`, `1`, `2`); replaceable
  `10000–19999` (+ `0`, `3`); ephemeral/not-stored `20000–29999`; parameterized-replaceable
  `30000–39999` (NIP-33). Our wrapped posts use **kind 1919** (regular; absent from the NIP kind
  registry as of 2026-10-10 — see SYSTEM_DESIGN §7.1 for the collision check and rationale).
- **NIP-09 (verified):** kind `5` = deletion request; `e` tags reference event ids, `k` tags name
  the kind; relays SHOULD honor same-pubkey requests but compliance is voluntary — clients MUST
  still apply deletions locally. Our tombstone uplink maps to this.
- **NIP-56:** kind `1984` = reporting — the standards-based abuse-report mechanism.
- **NIP-65:** kind `10002` = relay lists — the protocol-native relay-discovery mechanism.
  v1 uses the local directory only; NIP-65 read support is a P3 candidate (named, not built).

### 7.2 Relay software landscape (brief)

Anyone can run a relay; ~600+ active relays across 50+ countries (ecosystem survey, early 2026).
Common implementations: **strfry** (C++, LMDB — highest throughput, negentropy sync), **nostr-rs-relay**
(Rust, SQLite — single binary), **nostream** (TypeScript, PostgreSQL), **relayer** (Go), **khatru**
(Go framework — note: archived upstream, medium maturity). Airplane runs **none of these** and needs
no relay-side code: our events are standard NIP-01, so every implementation stores/serves them as
dumb pipes. (Sources: nostr-knowledge relay guides; enhansome-nostr implementation list, Aug 2026.)

### 7.3 Default public relay list — verification (2026-10-10)

| URL | Status evidence | Verdict |
|---|---|---|
| `wss://nos.lol` | clean in 2026 field probes (nvpn relay-quality session; flock e2e tests 2026-09) | **default** |
| `wss://relay.primal.net` | clean in 2026 field probes; large operator | **default** |
| `wss://nostr.mom` | probed clean 2026-09 (flock: publish + read-back via `#p` filter) | **default** |
| `wss://purplerelay.com` | clean in 2026 field probes | **default** |
| `wss://relay.damus.io` | high uptime historically, but rate-limits aggressive publishers ("rate-limited: you are noting too much", 2026) — bad default for a broadcast app | user-addable, NOT default |
| `wss://relay.nostr.band` | connect/recv timeouts, flaky (2026) | NOT default |
| `wss://relay.snort.social` | intermittent 504s (2026) | NOT default |
| `wss://nostr.wine` | 403 (paid relay) | NOT default |

Four independent operators as defaults = no single takedown/censorship target; the directory is
user-editable (add/remove/disable) and persisted in settings. Relay quality drifts — re-validate
this table at build time (P1/P2 scaffold task, owner: relay worker).

### 7.4 Nostr client library — selection matrix

| Capability | Requirement | Candidates | Recommended | Reason | Alternatives considered | Integration method | Language/runtime compat | License implications | Performance | Maintenance/community | Known limitations | Confidence | Fallback |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Nostr client (event build/sign, relay wss, REQ/sub) | Wrap/unwrap Airplane events; publish fanout; downlink subscribe | `nostr-tools` v2.x (nbd-wtf); `@nostr/gadgets` (JSR); `@nostr-dev-kit/ndk`; `nostr-fetch`; `nostr-relaypool` | **`nostr-tools` v2.x** | The foundational JS/TS Nostr toolkit (event creation/signing, relay pool, NIP-19); pure-JS entrypoint; the ONLY candidate with a documented React Native recipe in its own README (polyfills: `react-native-get-random-values`, `text-encoding-polyfill`, `react-native-url-polyfill`) | @nostr/gadgets (modular, newer — less battle-tested); NDK (full-featured but heavier, Node/bun-oriented, RN compat UNVERIFIED); nostr-fetch/nostr-relaypool (narrower scope) | **Wrapped** behind RELAY-5 `NostrAdapter` (npm dep, abstracted — swappable); import the pure-JS entrypoint only | Pure TS; Hermes-safe (no Node APIs on the pure path); RN needs the 3 documented polyfills | **Unlicense (public domain)** ✅ — compatible with Apache-2.0 app | Schnorr sign ~1 ms (noble); relay read/verify benchmarks published in-repo | **Active**: repo updated ~9 days ago; v2.24.1 on jsDelivr; v2.23.5 released 2026-05-18; 854 stars; commit 2026-09-08 making wasm an optional peer dep | **`nostr-tools/wasm` does NOT work on React Native** (no WebAssembly on Hermes — stated in the lib's own README); use the pure-JS build | HIGH | Hand-rolled ~150-line NIP-01 codec (JSON-array wire format is trivial) + `@noble/secp256k1` for Schnorr — the `NostrAdapter` interface doesn't change |

**Library notes:**
- The v2 package layout exposes `@nostr/tools` on JSR from the same `nbd-wtf/nostr-tools` repo;
  npm consumers use `nostr-tools`. Pin the exact version at scaffold (P1); do not copy a version
  from this doc.
- Schnorr signing itself may alternatively come from `@noble/secp256k1` (already in the stack's
  trust perimeter via `@noble/curves`) — the adapter only needs it if we bypass nostr-tools'
  sign helpers. Key custody NEVER comes from the lib (CRYPTO-1 owns keys; the lib receives bytes).
- Add `nostr-tools` (Unlicense) to the §5 license table.

## 8. License compatibility — v2 addition

| Dependency | License | Compatible with Apache-2.0 app | Notes |
|---|---|---|---|
| `nostr-tools` v2.x | Unlicense (public domain) | ✅ | Pure-JS path only on RN; wasm entrypoint excluded |
| `@noble/secp256k1` (if used directly) | MIT | ✅ | Same author/perimeter as @noble/curves |

