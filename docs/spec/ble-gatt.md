# Airplane BLE GATT Profile (v1, Android)

The over-the-air profile for the mesh radio. The event wire format stays in
`wire-format.md`; this document covers how frames move between phones over
Bluetooth LE. Code in `apps/mobile/services/airplane/ble/` follows it.

> **RADIO-UNVERIFIED.** No two physical devices exist in the test
> environment, so no over-the-air frame has ever flowed through this
> profile. Multi-phone interop is an open item for a two-phone test.

## 1. Roles

Every phone is **both** central and peripheral at all times:

| Role | Library | Duties |
|------|---------|--------|
| Central | `react-native-ble-manager` 12.6.0 | scan, connect, GATT client: writes frames to the peer's RX characteristic; receives the peer's frames via notifications on the peer's TX characteristic |
| Peripheral | `react-native-multi-ble-peripheral` 0.1.8 | advertise + GATT server: receives frames as writes to our RX characteristic; sends frames via TX notifications |

One connection per pair: on discovering a peer tag, the phone whose own tag
is lexicographically smaller (or equal) initiates the central connection.
The tag is the first 8 bytes of the Ed25519 pubkey — a discovery hint, never
identity.

## 2. GATT layout (fixed UUIDs, v1)

Service `7dd7bba6-fe73-4dde-b09e-db3ef75ec2ba` (primary):

| Characteristic | UUID | Properties | Direction |
|---|---|---|---|
| RX | `b44060bc-7918-4e95-aabd-fe08327ad228` | write, write-without-response | central → peripheral datagrams |
| TX | `09773929-00a4-49d7-9b1e-cfba4fb8c509` | notify, read | peripheral → central datagrams |
| IDENT | `9e849f21-2e3b-42d4-b3b7-4e9a0ead3116` | read, write | read returns the 64-char hex peerId |

## 3. Discovery

The peripheral advertises **manufacturer data only**: company id `0xFFFF`
(spec-reserved testing value — replace with a SIG-assigned id before any
production release) + the 8-byte peer tag. 12 bytes total, inside the 31-byte
legacy advertise budget.

The 128-bit service UUID is deliberately *not* in the advertise packet: it
costs 18 bytes and the peripheral library always attaches service data
alongside a service UUID (another 26), which blows the budget. Consequence:
the central scans **unfiltered** and filters by manufacturer id in JS. No
hardware scan filter in v1 (battery trade-off).

## 4. Identity resolution

- **Central side:** after connect + service discovery, read the peer's IDENT
  characteristic → full 64-char hex peerId (validated). Then write a hello
  datagram to the peer's RX characteristic.
- **Peripheral side:** the first datagram from a newly-connected central is
  the hello → map central BT address → full peerId. Before the hello, inbound
  frames are attributed to the provisional id `mac:<bt-address>`.

## 5. Port-layer datagrams

Below the protocol fragment layer (`wire-format.md` § fragments). Every
`TransportPort.send()` frame is wrapped as:

```
u16be(totalLen) || kind(u8) || payload
```

| Kind | Payload |
|------|---------|
| `0x01` hello | 32-byte pubkey \|\| u16be(central ATT MTU) |
| `0x02` frame | one protocol fragment (11-byte header + payload) |

Datagrams are chunked to `(link MTU − 3)` ATT PDUs per write/notify and
reassembled per remote (length-prefix framing). Reassembly buffers are
capped at 64 KiB per remote; oversized streams are dropped.

MTU: the central requests 512 after connect (falls back to 23). The hello
carries the central's negotiated MTU so the peripheral can size its notify
chunks; without a hello the peripheral chunks conservatively to 20 bytes.
The protocol frame size stays at the wire-spec maximum (469) on every link —
the port does the MTU-aware ATT chunking underneath.

## 6. Permissions (Android)

Manifest (install-time): `BLUETOOTH_SCAN` (`neverForLocation`),
`BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`; legacy `BLUETOOTH` /
`BLUETOOTH_ADMIN` / `ACCESS_FINE_LOCATION` with `maxSdkVersion=30`.
Runtime (`ble/permissions.ts`): request SCAN + ADVERTISE + CONNECT on API
31+, else `ACCESS_FINE_LOCATION`. Any denial → the radio stays off and the
mesh runs Nostr-only; never a crash.

## 7. Known limitations (v1)

1. **TX notify broadcasts** to all subscribed centrals (library limitation):
   `send()` to one peripheral-role peer also reaches the others. The mesh
   dedupes by event ID, so this wastes bandwidth, not correctness.
2. **No force-disconnect** of inbound centrals (library has no API); the port
   forgets the mapping and the central times out.
3. **Provisional peer ids** (`tag:<hex>`, `mac:<addr>`) exist until identity
   resolves; consumers must handle re-keying.
4. The peripheral library is v0.x, single-maintainer — the highest-risk
   dependency. Fallback if it misbehaves: a vendored Kotlin GATT-server
   module in `apps/mobile/android` (its Kotlin is the reference).
5. iOS is not implemented (permissions flow returns false; radio stays off).
