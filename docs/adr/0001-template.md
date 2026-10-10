# ADR-XXXX: <Title>

- **Status:** proposed | accepted | deprecated | superseded by ADR-YYYY
- **Date:** YYYY-MM-DD
- **Deciders:** <who made the call>

## Context

What problem are we solving, what constraints apply, and what happens if we
don't decide. Keep it to the facts a new contributor needs to follow the
reasoning.

## Decision

What we chose, stated plainly.

## Consequences

What this choice buys us and what it costs us. Be honest about the downsides —
that's the point of writing it down.

## Alternatives considered

The real options we weighed and why each lost. Skip strawmen.

## Reconsider when

The trigger conditions that should make us reopen this record (e.g. "if
react-native-bluetooth-ble stops being maintained", "once we have on-device
benchmarks showing X"). ADRs are living documents; stale decisions are worse
than no decisions.

---

# ADR-0001: React Native + Expo over Flutter

- **Status:** accepted
- **Date:** 2026-10-10
- **Deciders:** Tuba

## Context

Airplane needs a cross-platform mobile app with first-class Bluetooth LE,
offline-first local storage, and a privacy-first posture (no analytics phones
home). The realistic 2026 options were React Native/Expo and Flutter, with
Kotlin Multiplatform as a second-tier fallback.

## Decision

We build with React Native + Expo. The decisive factor was BLE: RN's BLE
ecosystem (`react-native-ble-plx`, `react-native-ble-manager`,
`react-native-bluetooth-ble` with central + peripheral + L2CAP + background)
is healthier than Flutter's, where the leading library (`flutter_blue_plus`)
went proprietary at v2.0 with a free tier that phones home — hostile to an
open-source privacy-first project.

## Consequences

We get a faster feed build (FlashList), mature offline storage (`op-sqlite` +
MMKV), and Expo's EAS build pipeline. We inherit RN's native-module
fragmentation risk and still face the universal hard limits: iOS background
BLE is OS-crippled, iOS↔Android background discovery over pure BLE is
impossible, and ~30–40% of the BLE work is native Swift/Kotlin regardless.
Apple Guideline 1.2 (Feb 2026) explicitly targets anonymous chat apps, so
store review risk is real — the app ships sideloadable open source.

## Alternatives considered

Flutter (lost on BLE library health and telemetry), KMP + Compose
Multiplatform (best of the second tier, but less BLE ecosystem and more
bespoke native code).

## Reconsider when

If Apple's App Store review rules harden further, or if a Flutter BLE library
emerges that is fully open-source and maintained — re-score before P3 (real
BLE wiring).

*Full rationale lives in `docs/blueprint/OPERATIONS.md` §13 (UI verdict) and
`docs/blueprint/OSS_RESEARCH.md`.*
