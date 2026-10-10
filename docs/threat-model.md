# Threat Model — DRAFT

> **Status: P1 DRAFT stub.** This file is a placeholder, not a threat model.
> The full threat model lands in **P4** per the blueprint. It is being written
> early so the security posture is visible from day one, but nothing here is
> final.

## Scope

- **In scope (P1):** the protocol layer and the in-mesh simulator —
  `packages/protocol`, `packages/storage`, `packages/mesh-sim`. No radio yet,
  so this phase's threat surface is data structures, serialization, and
  simulated flooding behavior.
- **Explicitly not yet modeled:** real BLE transport attacks (MAC tracking,
  GATT abuse, MitM on pairing-free links), on-device key storage, store
  distribution / sideloading trust, and server-side anything (there is no
  server).

## Assets

| Asset | Why it matters |
|---|---|
| Identity keys (Ed25519 private keys) | Whoever holds the key *is* the author in a system with no accounts. Key theft = identity theft. |
| Feed content (posts) | Integrity and attribution: a post must be attributable to exactly the key that signed it, and relayed content must not be silently altered. |
| View counts | The ranking signal. Approximate and gameable by design — see below. |

## Out of scope for now

- Real BLE radio attacks (P3, when the transport is real).
- On-device keystore design (platform keychain/Keystore wiring).
- Store review / sideloading distribution trust.
- Moderation (there is no central authority to moderate; abuse handling is a P4 design question).

## Known threat-model-relevant facts

These are settled design facts that the full threat model will inherit. They
are stated here so nobody is surprised by them later.

| # | Fact |
|---|---|
| 1 | **No accounts, no PII by design.** There is nothing to leak server-side because there is no server and no identity beyond a locally generated keypair. |
| 2 | **View counts are approximate and gameable.** Views are relayed as receipts in an offline flood; any peer can inflate or fabricate them. Ranking treats views as a *signal*, never as ground truth. |
| 3 | **Peer-ID / MAC rotation is planned, not implemented.** BLE address rotation and ephemeral peer IDs are in the design for P3; in P1 the simulator uses stable identifiers. |
| 4 | **Traffic-analysis resistance is explicitly out of scope for v1.** An adversary watching BLE traffic can observe who broadcasts when. We are not attempting anonymity at the radio layer. |
| 5 | **No confidentiality on the feed.** Posts are signed, not encrypted — it's a *public broadcast* feed. Anyone in range can read everything. |
| 6 | **Relayed content integrity rests on signatures.** A relaying peer cannot alter a post without invalidating its Ed25519 signature; verification happens at ingestion. |

## Next step

P4 produces the real threat model: full STRIDE-style walkthrough of the BLE
transport, key management, identity rotation, and the sideloaded distribution
path. Until then, treat this file as a sketch, not a sign-off.
