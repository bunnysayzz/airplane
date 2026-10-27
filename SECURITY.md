// SPDX-License-Identifier: Apache-2.0
# Security Policy

## Reporting a vulnerability

Report vulnerabilities via **GitHub Security Advisories** on the
[`bunnysayzz/airplane`](https://github.com/bunnysayzz/airplane) repository
(Security tab → "Report a vulnerability"). Please do not open a public issue
for a security report.

We will acknowledge a report within 72 hours and aim to ship a fix before
public disclosure. We follow coordinated disclosure: give us a reasonable
window to fix before publishing details.

## Supported versions

| Version | Support status                                  |
| ------- | ----------------------------------------------- |
| 0.1.x   | Pre-release — best effort, no guarantees        |

The project is pre-1.0. We triage on a best-effort basis and prioritise
issues that compromise anonymity or message integrity.

## Scope and threat-model notes

- **Anonymous by design.** Airplane has no accounts, no logins, and no PII
  by design. The network is an offline, location-bounded BLE mesh of
  pseudonymous broadcast events. We will not "fix" reports that amount to
  "anyone nearby can read the feed" — that is the product, not a bug.
- **Keys in the OS keystore.** Device identity keys and signing keys live in
  the platform keystore (Android Keystore / iOS Secure Enclave). Reports
  about key extraction require a demonstrated keystore compromise, not a
  rooted-device thought experiment.
- **View counts are approximate.** Feed ranking is based on aggregated,
  log-scaled, decaying view receipts from an unauthenticated mesh. Sybil
  inflation of view counts is a known, accepted limitation of the 0.1.x
  design — we care about forgery and integrity, not about gaming a number
  that is approximate by construction.
- **Out of scope:** store-review policy disputes, takedown requests, and
  anything that requires breaking anonymity to "fix".

## What makes a good report

- Affected version / commit, platform, and steps to reproduce.
- What you expected vs. what happened, focused on anonymity, integrity, or
  availability of the mesh feed.
- Proof-of-concept code or packet captures are welcome; live attacks against
  other users' devices are not.
