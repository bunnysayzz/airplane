// SPDX-License-Identifier: Apache-2.0
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
