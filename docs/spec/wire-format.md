# Airplane Wire Format (source of truth)

This document is the **source of truth** for the Airplane event wire format.
Code in `packages/protocol` follows it; if code and this doc disagree, this doc
wins and the code is a bug. Changes to this document require an ADR.

## 1. Event encoding

Events are CBOR-encoded as an **8-position array** (positions are fixed):

| Pos | Field      | CBOR type | Size / constraint                              |
|-----|------------|-----------|------------------------------------------------|
| 0   | `id`       | bstr      | exactly 32 bytes: `sha256` of the pre-image    |
| 1   | `pubkey`   | bstr      | exactly 32 bytes: ed25519 public key           |
| 2   | `created_at` | uint    | seconds since Unix epoch, non-negative integer |
| 3   | `kind`     | uint      | 1 = post, 2 = view receipt, 3 = tombstone      |
| 4   | `geohash`  | tstr      | exactly 5 chars, geohash base32 alphabet       |
| 5   | `tags`     | array     | array of string arrays, e.g. `[["e", postIdHex]]` |
| 6   | `content`  | tstr      | NFC-normalized UTF-8; see §3                   |
| 7   | `sig`      | bstr      | exactly 64 bytes: ed25519 signature over `id`  |

Library: `cbor-x` (canonical settings; byte strings encode as CBOR bstr).

## 2. Canonical pre-image, id, and signature

The **canonical pre-image** is the CBOR encoding of the 7-position array:

```
[0, pubkey(32B bstr), created_at(uint), kind(uint), geohash(tstr), tags(arr), content(tstr)]
```

The leading `0` is a domain-separation tag so a pre-image can never be
confused with a full event.

- **`id`** = `SHA-256(canonical pre-image)` (32 bytes).
- **`sig`** = `ed25519_sign(secretKey, id)` (64 bytes, over the id - not the
  pre-image - so verifiers hash once and compare).
- Verification = recompute `id` from fields 1–6, constant-time-compare with
  field 0, then `ed25519_verify(sig, id, pubkey)`.

## 3. Content rules

- Posts (`kind=1`): content NFC-normalized, **1–280 Unicode characters**
  (counted as code points, not UTF-16 units, not bytes).
- View receipts (`kind=2`): content MUST be `""`; `tags` MUST be
  `[["e", "<64-char lowercase hex post id>"]]`.
- Tombstones (`kind=3`): content MUST be `""`; `tags` MUST be
  `[["e", "<post id hex>"]]`; only the post's own author may tombstone it
  (app layer enforces `tombstone.pubkey == post.pubkey`).

## 4. Size limits

| Limit | Value | Enforced at |
|-------|-------|-------------|
| `MAX_CONTENT_CHARS` | 280 chars | `createPost` / `decodeEvent` |
| `MAX_EVENT_BYTES` | 4096 bytes (encoded) | `decodeEvent` (throws `CodecError`) |
| `GEOHASH_PRECISION` | 5 chars | `decodeEvent`, payload constructors |

Any violation → `CodecError`. Receivers MUST drop (never relay) undecodable
events.

## 5. Fragment header (BLE transport)

Encoded events larger than one BLE frame are split. Every fragment carries an
**11-byte big-endian header**:

| Offset | Field    | Type | Meaning                                              |
|--------|----------|------|------------------------------------------------------|
| 0      | `magic`  | u8   | `0xA1`                                               |
| 1–4    | `msgTag` | u32  | first 4 bytes of the event `id` (reassembly key)     |
| 5–6    | `total`  | u16  | fragment count (≥ 1)                                 |
| 7–8    | `index`  | u16  | this fragment's index, 0-based (`< total`)           |
| 9      | `ttl`    | u8   | remaining flood TTL stamped by the sender            |
| 10     | `flags`  | u8   | reserved, MUST be 0                                  |

- `FRAG_WIRE_MAX` = 469 bytes per frame → payload ≤ **458 bytes**/fragment.
- Reassembly key is `msgTag`; frames may arrive out of order or duplicated.
- Incomplete reassembly buffers are dropped after `REASSEMBLY_TIMEOUT_MS` =
  30000 ms.
- Receivers MUST ignore frames with bad magic, `total == 0`,
  `index >= total`, or `msgTag` collisions with a differing `total`.

## 6. Protocol versioning

`PROTO_VER = 1`. There is no version field inside the event (the array shape
*is* the version). Any future breaking change bumps `PROTO_VER`, adds a new
documented layout, and requires an ADR. Receivers treat undecodable bytes as
opaque and drop them.
