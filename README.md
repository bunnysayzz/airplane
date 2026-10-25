<p align="center">
  <img src="./logo.png" width="120" alt="Airplane logo" />
</p>

# Airplane

*the feed that works in airplane mode.*

[![CI](https://github.com/bunnysayzz/airplane/actions/workflows/ci.yml/badge.svg)](https://github.com/bunnysayzz/airplane/actions/workflows/ci.yml)
[![CodeQL](https://github.com/bunnysayzz/airplane/actions/workflows/codeql.yml/badge.svg)](https://github.com/bunnysayzz/airplane/actions/workflows/codeql.yml)
[![License](https://img.shields.io/github/license/bunnysayzz/airplane)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/bunnysayzz/airplane)](https://github.com/bunnysayzz/airplane/releases)

**Airplane** is an open-source Android + iOS app: an anonymous, location-based **public broadcast feed** that works over a phone-to-phone Bluetooth mesh and, when the internet is available, public Nostr relays. No accounts, no phone numbers, no servers, no Google services. Built for protests, concerts, and anywhere the network is gone.

Posts are ranked by **views, not likes**: what people actually see rises, what nobody sees dies out.

## One feed, hybrid transport

There is **one feed**. No tabs, no separate destinations.

"World" is not a place you post to — it is a *status* a post earns when a copy of it reaches the relay network:

- **Mesh-only** posts show no icon. This is the default, and it is clean on purpose.
- **World-confirmed** posts show a tiny 🌐. The icon means something because it is rare.

Every post is signed on-device with your Ed25519 key and sent over every transport available at the same time:

- **BLE mesh** — always on. Phones relay posts hop-by-hop (controlled flood, TTL 7) whether or not the internet exists.
- **Nostr relays** — when the phone is online (tracked with NetInfo, no Google Play Services). The app pushes unsynced posts, pulls new events, and checks relays for its unconfirmed event IDs.

Dedup is by event ID (SHA-256 of the signed bytes), identical across BLE and Nostr, so a post arriving twice is one post.

**Silent background uplink.** When your phone is online and receives a post that is not yet World-confirmed, it uploads the exact signed bytes to relays — silently, in the background, with no approval and no prompts. Relays cannot modify a post (the signature covers the full payload); they can only copy it. Onboarding says this once, then never again:

> "Posts you send may reach the wider network through other phones."

There is no local-only post. If you post, assume it can reach the world. The old opt-in World gate was a false promise — mesh is already broadcast — so it was removed.

## Features

- **Text posts** — 280 Unicode chars (NFC-normalized), append-only, no edits.
- **Anonymous by design** — no accounts, no phone numbers. Posts are signed with a locally generated Ed25519 key that never leaves your device.
- **Location-scoped feed** — the feed shows posts from your geohash-5 cell (≈4.9 km × 4.9 km) plus its 8 neighbours. Raw coordinates are never stored.
- **Ranked by views, not likes** — `score = log₁₀(1+views) / (ageHours+2)^1.5`. Log scaling dampens Sybil gaming; one countable view per (device, post, UTC day).
- **Offline mesh relay** — BLE GATT controlled flood (TTL 7 hops, 50–500 ms relay jitter, 10k-entry seen-cache dedup), fragmented into ≤469-byte frames.
- **Store-and-forward** — posts live on-device in SQLite; your post propagates when peers show up. Being alone is the normal case, not an error.
- **Persistent storage** — on-device SQLite (`OpSqliteStore`) for events, MMKV for hot key/value state. Secrets are never stored in KV.
- **Connectivity-aware transport** — NetInfo wiring starts Nostr/WorldSync when online and stops them when offline; BLE keeps running either way.
- **Delete your own posts** — deletions are tombstone events the network honors.
- **No backend** — no server to deploy, rate-limit, subpoena, or take down.
- **Anonymous, not encrypted** — post *contents* are public by design (anyone in radio range can read them, like shouting in a square). What is protected is your *identity*. The app never promises encryption.

## Install

Sideload-first — the threat model includes store takedowns, so stores are not the primary channel.

**Android:** install the APK from [GitHub Releases](https://github.com/bunnysayzz/airplane/releases). Current known-good build:

- **v0.1.3-prod** — [`airplane-v0.1.3-prod-gradle-test.apk`](https://github.com/bunnysayzz/airplane/releases/download/v0.1.3-prod/airplane-v0.1.3-prod-gradle-test.apk)

Android will warn about unknown sources; that is expected for a sideloaded app. Import the releases page in [Obtainium](https://obtainium.imranr98.com/) for updates. Install only from the official releases page — never from forwarded files or mirrors you cannot verify.

**iOS:** no public build yet. Note also that iOS background BLE is OS-crippled (Apple throttles background advertising/scanning hard), so iOS participates opportunistically; Android is the relay backbone.

## Build from source

Prerequisites: **Node 24** (pinned via `.nvmrc`), npm.

```bash
git clone https://github.com/bunnysayzz/airplane.git
cd airplane
npm install
npm test            # full Jest suite
npm run typecheck   # strict tsc --noEmit across all 6 projects
npm run lint        # eslint, zero warnings allowed
```

Run the app:

```bash
cd apps/mobile
npx expo start      # scan the QR code with Expo Go, or press `a` / `i` for an emulator
```

Android release APK (the route release builds actually use — EAS is not used):

```bash
cd apps/mobile/android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon
```

The `android/` directory is committed; no Expo prebuild runs in CI. Release APKs are attached to GitHub Releases by [`.github/workflows/publish-test-apk.yml`](.github/workflows/publish-test-apk.yml). See [`docs/release-runbook.md`](docs/release-runbook.md) for the release pipeline.

## Architecture

Strict layering, one-way dependencies:

```
apps/mobile (React Native + Expo)
  → packages/transport (BLE + Nostr hybrid, WorldSync)
  → packages/protocol (signed CBOR events, flood engine, ranking, geohash)
  → packages/storage (StorePort / KvPort / DatabasePort)
  → packages/crypto (Ed25519)
  → packages/mesh-sim (in-memory radio for tests + dev)
```

| Package | Responsibility |
|---|---|
| `apps/mobile` | Expo app: feed, composer, settings, onboarding; services wiring |
| `packages/transport` | `BleTransport`, `NostrTransport`, `HybridTransport` (dual ingress, dedup by event ID), WorldSync confirmation tracking |
| `packages/protocol` | Wire truth: signed CBOR events, flood engine, fragmentation, view-receipt dedup, views ranking, geohash |
| `packages/storage` | Port interfaces + schema; `OpSqliteStore` (op-sqlite) + MMKV KV drivers |
| `packages/crypto` | Ed25519 sign/verify/keygen |
| `packages/mesh-sim` | In-memory `TransportPort` network (latency/loss knobs) so mesh behavior is testable without radios |

Port interfaces (the seams everything crosses):

| Interface | Package | One-line job |
|---|---|---|
| `TransportPort` | `packages/protocol` | BLE contract: advertise, scan, connect, send frames |
| `CryptoPort` | `packages/protocol` | Ed25519 sign/verify/keygen adapter |
| `StorePort` | `packages/storage` | Events, receipts, peers, feed query, pruning |
| `KvPort` | `packages/storage` | Hot key/value state (cursors, flags, prefs — never secrets) |
| `DatabasePort` | `packages/storage` | Low-level SQL behind the SQLite driver |

**Data flow (one post, end to end):**

```
compose → createPost → signEvent (Ed25519) → fragmentEvent (≤469 B frames)
→ flood (TTL 7, jitter 50–500 ms, seen-cache LRU 10k)
→ verifyEvent → saveEvent → receipts → rankPosts → listFeed → render
```

**Protocol constants** (from [`packages/protocol/src/events/types.ts`](packages/protocol/src/events/types.ts)):

| Constant | Value | Meaning |
|---|---|---|
| `PROTO_VER` | 1 | Wire version; unknown versions rejected |
| `DEFAULT_TTL` | 7 | Flood hop limit |
| `FLOOD_JITTER_MS_*` | 50–500 | Uniform relay jitter before forwarding |
| `SEEN_LRU_CAP` | 10000 | Deduplication cache size (event ids) |
| `MAX_CONTENT_CHARS` | 280 | Post length limit (Unicode chars, NFC-normalized) |
| `MAX_EVENT_BYTES` | 4096 | Max CBOR-encoded event size |
| `GEOHASH_PRECISION` | 5 | Location cell ≈ 4.9 km × 4.9 km |
| `RANK_GRAVITY` | 1.5 | Time-decay exponent in the ranking formula |
| `FRAG_WIRE_MAX` / `FRAG_HEADER_LEN` | 469 / 11 | BLE frame budget: 458 B payload per fragment |
| `REASSEMBLY_TIMEOUT_MS` | 30000 | Incomplete fragment buffers are dropped |
| `RECEIPT_DAY_BUCKET_S` | 86400 | One countable view per (device, post, UTC day) |

Event kinds: `1 = post`, `2 = view receipt`, `3 = tombstone`. Wire encoding is the 8-position CBOR array `[id, pubkey, created_at, kind, geohash, tags, content, sig]` — see [`docs/spec/wire-format.md`](docs/spec/wire-format.md).

**Design docs:**

- [`docs/blueprint/hybrid-single-feed-plan.md`](docs/blueprint/hybrid-single-feed-plan.md) — the single-feed hybrid design (current)
- [`docs/blueprint/ARCHITECTURE.md`](docs/blueprint/ARCHITECTURE.md) — headline decisions, scope, requirements
- [`docs/blueprint/SYSTEM_DESIGN.md`](docs/blueprint/SYSTEM_DESIGN.md) — layers, node inventory, data model, contracts
- [`docs/blueprint/DIAGRAMS.md`](docs/blueprint/DIAGRAMS.md) — diagram set, sequence flows
- [`docs/blueprint/ROADMAP.md`](docs/blueprint/ROADMAP.md) — phased plan with acceptance criteria
- [`docs/spec/`](docs/spec/) — source of truth for `packages/protocol`

## Verification status

Stated honestly — what has actually run on a real device, and what has not:

| Item | Status | Evidence |
|---|---|---|
| App launches (ExpoLinking crash) | ✅ Fixed in v0.1.0 | Alive on real phones: BrowserStack Pixel 8 Pro (~5 min, onboarding verified), pCloudy Pixel 9 Pro XL |
| Publishing throws (Hermes `crypto.getRandomValues`) | ✅ Fixed in v0.1.2 | No publish error dialog on any real device since; polyfill imported first in entry |
| Feed shows your post (viewer-cell scoping) | ✅ Verified 2026-10-25 | pCloudy Galaxy M53, v0.1.3: "v013 test" posted and shown as top post in feed, no error dialog |
| Unit / integration tests | ✅ Green at HEAD | 411 tests, 35 suites; tsc clean (6 projects), eslint 0/0 |
| Post survives app restart (persistent storage) | ⏳ Code done, device proof pending | SQLite store implemented; last device attempt blocked by the test device's GPS state + exhausted trial minutes |
| NetInfo connectivity wiring | ⏳ Code done, device check pending | Single connectivity funnel implemented; real-device online/offline toggle check still to run |
| BLE radio interop (two phones) | ❌ Unverified | Needs two physical phones in range; cannot be proven on cloud devices |

## Roadmap

Current direction, in the order work is landing: background relay, thread screen, relay configurability in settings, keystore hardening (key rotation), location edge cases, in-app updater from GitHub Releases. Full phased plan: [`docs/blueprint/ROADMAP.md`](docs/blueprint/ROADMAP.md).

## Repository structure

```
airplane/
├── apps/
│   └── mobile/            # Expo app - feed, composer, settings, onboarding, services
│       ├── app/           # expo-router: (tabs)/feed, (tabs)/settings, post/[id], onboarding
│       ├── services/      # airplane services: feed, composer, transport, storage adapters
│       └── android/       # committed Android project (no prebuild in CI)
├── packages/
│   ├── protocol/          # @airplane/protocol - events, CBOR codec, flood, ranking, geohash
│   ├── storage/           # @airplane/storage - ports, schema, op-sqlite/MMKV drivers
│   ├── crypto/            # @airplane/crypto - Ed25519
│   ├── transport/         # @airplane/transport - BLE + Nostr hybrid, WorldSync
│   └── mesh-sim/          # @airplane/mesh-sim - in-memory radio for tests + dev
├── docs/
│   ├── blueprint/         # architecture + roadmap + single-feed hybrid plan
│   ├── spec/              # wire-format.md + flood.md - source of truth for protocol
│   ├── adr/               # architecture decision records
│   ├── release-runbook.md # how releases get cut and published
│   └── threat-model.md    # security posture (draft)
├── scripts/               # repo tooling (incl. native-module payload gate)
├── .github/workflows/     # ci.yml, build-apk-no-eas.yml, publish-test-apk.yml, release.yml, ...
├── .nvmrc                 # Node 24
├── CONTRIBUTING.md        # dev setup, commit style, PR bar
├── SECURITY.md            # disclosure policy, supported versions
├── PRIVACY.md             # privacy posture
├── LICENSE                # Apache-2.0
└── CHANGELOG.md           # release notes per release
```

CI runs lint, typecheck, and the full Jest suite on every push/PR; CodeQL and dependency review run on schedule; release builds cut from tags. See [`docs/release-runbook.md`](docs/release-runbook.md) for the release pipeline.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, conventional commits, PR bar. Good first issues are marked on the issue tracker. The design docs above are worth reading before proposing protocol changes (anything touching `TransportPort` or the wire format needs an ADR).

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy and supported versions. Honest state: [`docs/threat-model.md`](docs/threat-model.md) is a draft; report vulnerabilities via GitHub Security Advisories, never as public issues. Key rotation and signing hardening are still open work (see Roadmap).

## FAQ

**Is it anonymous?**
No accounts, no phone numbers, no analytics — posts are signed with a locally generated Ed25519 key that never leaves your device. That makes you *pseudonymous per key*, not untraceable: BLE radio fingerprints exist, and we do not claim traffic-analysis resistance in v1. Raw coordinates are never stored; only the geohash-5 cell (≈4.9 km × 4.9 km).

**Does every post reach the world?**
Assume yes. Any online phone can silently relay your post to Nostr relays. There is no local-only post — onboarding says so once, plainly.

**Does it need the internet?**
No. Discovery, relay, storage, and ranking all happen between phones over BLE. The app is designed for the network being gone. Internet only adds the relay leg.

**What about battery?**
Mesh relay runs while the app is in the foreground with duty-cycled scanning/advertising. Background relay without Google services is best-effort (Doze throttles it); measured battery numbers on physical phones are still open work.

**What are the iOS limits?**
iOS background BLE is OS-crippled: Apple throttles background advertising/scanning hard, and iOS↔Android background discovery over pure BLE is effectively impossible. So the honest design is **foreground-first mesh** — Android is the relay backbone, iOS participates opportunistically. Note also Apple's Feb-2026 Guideline 1.2, which explicitly targets anonymous chat/broadcast apps — store review is a real risk, hence the sideload-first distribution.

**Why views, not likes?**
Likes are cheap, brigadable signals. Views measure actual reach: a post rises only if real devices actually receive and render it. The log₁₀ scaling means the 10,000th view matters far less than the 10th, which dampens Sybil-inflated counts. View receipts are signed and deduped per (device, post, UTC day), and counts are labeled *approximate device counts* — never used for trust or money.

**Is sideloading legal / safe?**
Yes, sideloading is legal. We sign every APK, and support Obtainium for verified updates. Only install builds from the official [releases page](https://github.com/bunnysayzz/airplane/releases) — never from forwarded files or mirrors you cannot verify.

**How are posts moderated?**
There is no central server, so there are no takedowns. You can delete your *own* posts (tombstone events the network honors). Spam without identity is fundamentally rate-limits + TTL only — residual abuse is accepted and documented rather than wished away.

**What happens if there are no peers around?**
Store-and-forward: your post is signed and stored locally, and the flood resumes the moment a peer appears. The mesh is asynchronous by design — being alone is the normal case, not an error.

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Acknowledgments

Design references and prior art, all verified open:

- [Bitchat](https://github.com/permissionlesstech/bitchat) (Unlicense / public domain) — iOS BLE-mesh flood design; the closest shipped reference for controlled flooding
- [Nostr](https://github.com/nostr-protocol/nostr) — signed-event structure and `["e", …]` tag conventions informed our event model
- [Reticulum](https://reticulum.network) — protocol ideas for resilient, infrastructure-independent networking

UI adapted from MIT-licensed open source (see [NOTICE](NOTICE) for details):

- [Pugdon](https://github.com/cajuuh/pugdomv2) (MIT, © cajuuh) — theme system, i18n infrastructure, TabBar, TopBar, Timeline/Thread/Settings/Setup screens, compose sheet, dialog host, and ui primitives; rebranded to Airplane and re-driven by `services/airplane`
- [panel-ui](https://github.com/panel-ui/panelui) (MIT, © panel-ui) — component primitives vendored via the panel-ui CLI, basis for shared UI in `components/ui`
