# docs/

Project Airplane documentation. Start here if you are new to the repo, or jump straight to the [root README](../README.md) for setup.

## Index

Status tags: current (the live design or process), draft (incomplete by its own label), history (kept as working history, not rewritten).

| Document | One line | Status |
|---|---|---|
| [`blueprint/hybrid-single-feed-plan.md`](blueprint/hybrid-single-feed-plan.md) | The single-feed hybrid design (current) | current |
| [`blueprint/ARCHITECTURE.md`](blueprint/ARCHITECTURE.md) | Executive summary, two-feed product scope, requirements, and the 10 headline architecture decisions | history |
| [`blueprint/OSS_RESEARCH.md`](blueprint/OSS_RESEARCH.md) | Open-source ecosystem research plus dependency selection matrix (read before adding a dep) | history |
| [`blueprint/SYSTEM_DESIGN.md`](blueprint/SYSTEM_DESIGN.md) | Layers, 63-node inventory (incl. RELAY plus CRYPTO subsystems), data model, event contracts, Nostr adapter spec | history |
| [`blueprint/DIAGRAMS.md`](blueprint/DIAGRAMS.md) | Mermaid diagram mesh: layering, uplink/downlink flows, sequences, failure chains | history |
| [`blueprint/OPERATIONS.md`](blueprint/OPERATIONS.md) | Runtime strategy, dependency map, threat model, reliability/perf/security analysis, full ADR texts | history |
| [`blueprint/ROADMAP.md`](blueprint/ROADMAP.md) | Phased build plan P0-P6 with acceptance criteria and definitions of done | history |
| [`blueprint/PLAN_CHANGELOG.md`](blueprint/PLAN_CHANGELOG.md) | What changed between blueprint v1 (pure offline) and v2 (hybrid mesh plus relay) | history |
| [`assumption-register.md`](assumption-register.md) | Every ASSUMPTION tag with validation plan plus owner | current |
| [`spec/wire-format.md`](spec/wire-format.md) | Event encoding spec - **source of truth** for `packages/protocol` (code follows spec) | current |
| [`spec/flood.md`](spec/flood.md) | Controlled-flood relay spec: TTL, jitter, seen-cache dedup, fragments | current |
| [`spec/ble-gatt.md`](spec/ble-gatt.md) | BLE GATT transport spec: service and characteristic layout, discovery, datagrams | current |
| [`adr/0001-template.md`](adr/0001-template.md) | ADR template - use it for every new architecture decision | current |
| [`release-runbook.md`](release-runbook.md) | How releases are cut: tagging, signing, checksums, GitHub Releases plus Obtainium plus TestFlight *(landing - in progress)* | current |
| [`threat-model.md`](threat-model.md) | Security posture. Currently a P1 DRAFT stub; the full threat model lands in P4 | draft |

## Blueprint status

The `blueprint/` files are a byte-identical snapshot of the research and design pass that kicked off the project. As the code matures, `spec/` and `adr/` supersede them - but nothing here gets edited in place. New decisions go in ADRs.

## Getting started

For setup, build, test, and the repository layout, see the [root README](../README.md). For the release process, see [`release-runbook.md`](release-runbook.md).
