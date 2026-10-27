// SPDX-License-Identifier: Apache-2.0
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Feed scope wiring (0.1.3): the feed tab passed `cells={[]}` to Timeline,
  and an empty cell set matches no post by construction — so the feed stayed
  permanently empty even though posts saved fine. The tab now resolves the
  viewer's geohash-5 cell (permission checked first, never prompting) and
  passes the cell + 8 neighbours; cells re-resolve on tab focus and on
  feed-change notifications, so a post published right after granting
  location appears immediately. Resolution failure keeps the previous cells
  and logs to Sentry instead of flashing the feed empty.

### Added

- CI/CD hardening: CodeQL, dependency-review, nightly spec-drift checks,
  release automation, and issue/PR templates.
- v2 blueprint: hybrid mesh+relay architecture, two-feed (Around / World)
  product model, privacy model, and an assumption register with validation
  plans.
- Mobile UI shell (anonymous onboarding, mesh status, compose, two-feed
  timeline, panelui Post cards) wired to the airplane protocol; `PRIVACY.md`
  and `NOTICE` added.

### Changed

- Badges, docs links, and CODEOWNERS repointed from `enginoor/airplane` to
  `bunnysayzz/airplane`.

## [0.1.0] - 2026-10-10

P1 foundation scaffold — the protocol, storage, simulation, and app-skeleton
layers, wired together by CI. Nothing here is radio-tested yet; the P0 radio
spike on physical phones is still to come.

### Added

- npm monorepo (`apps/*`, `packages/*`) with shared typescript/eslint/prettier
  tooling.
- `@airplane/protocol`: Ed25519-signed CBOR event codec (`cbor-x`,
  `@noble/curves`), fragmenter for BLE-sized MTUs, flood-relay engine,
  view-receipt handling, log-scaled time-decay ranking, geohash scoping —
  with 71 passing jest tests (`npm test`), strict `tsc --noEmit`, and
  eslint clean.
- `@airplane/storage`: store port interfaces and SQLite schema with a working
  in-memory implementation; native `op-sqlite`/MMKV wiring is a TODO stub.
- `@airplane/mesh-sim`: in-memory `TransportPort` mesh simulator so protocol
  logic can be exercised without radios.
- `apps/mobile`: Expo SDK 53 skeleton app (TypeScript).
- `docs/blueprint/` and `docs/spec/`: architecture blueprint, wire-format and
  flood specs.
- GitHub Actions CI (`ci.yml`) and Android EAS build (`build-android.yml`);
  build workflow needs an `EXPO_TOKEN` secret (owner to add).
