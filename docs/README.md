# docs/

Project Airplane documentation. Start here if you're new to the repo — or jump straight to the [root README](../README.md) for setup.

## Index

| Document | One line |
|---|---|
| [`blueprint/ARCHITECTURE.md`](blueprint/ARCHITECTURE.md) | Executive summary, two-feed product scope, requirements, and the 10 headline architecture decisions |
| [`blueprint/OSS_RESEARCH.md`](blueprint/OSS_RESEARCH.md) | Open-source ecosystem research + dependency selection matrix (read before adding a dep) |
| [`blueprint/SYSTEM_DESIGN.md`](blueprint/SYSTEM_DESIGN.md) | Layers, 63-node inventory (incl. RELAY + CRYPTO subsystems), data model, event contracts, Nostr adapter spec |
| [`blueprint/DIAGRAMS.md`](blueprint/DIAGRAMS.md) | Mermaid diagram mesh: layering, uplink/downlink flows, sequences, failure chains |
| [`blueprint/OPERATIONS.md`](blueprint/OPERATIONS.md) | Runtime strategy, dependency map, threat model, reliability/perf/security analysis, full ADR texts |
| [`blueprint/ROADMAP.md`](blueprint/ROADMAP.md) | Phased build plan P0–P6 with acceptance criteria and definitions of done |
| [`blueprint/PLAN_CHANGELOG.md`](blueprint/PLAN_CHANGELOG.md) | What changed between blueprint v1 (pure offline) and v2 (hybrid mesh + relay) |
| [`assumption-register.md`](assumption-register.md) | Every ASSUMPTION tag with validation plan + owner |
| [`spec/wire-format.md`](spec/wire-format.md) | Event encoding spec — **source of truth** for `packages/protocol` (code follows spec) |
| [`spec/flood.md`](spec/flood.md) | Controlled-flood relay spec: TTL, jitter, seen-cache dedup, fragments |
| [`adr/0001-template.md`](adr/0001-template.md) | ADR template — use it for every new architecture decision |
| [`release-runbook.md`](release-runbook.md) | How releases are cut: tagging, signing, checksums, GitHub Releases + Obtainium + TestFlight *(landing — in progress)* |
| [`threat-model.md`](threat-model.md) | Security posture. Currently a P1 DRAFT stub; the full threat model lands in P4 |

## Blueprint status

The `blueprint/` files are a byte-identical snapshot of the research and design pass that kicked off the project. As the code matures, `spec/` and `adr/` supersede them — but nothing here gets edited in place. New decisions go in ADRs.

## Getting started

For setup, build, test, and the repository layout, see the [root README](../README.md). For the release process, see [`release-runbook.md`](release-runbook.md).
