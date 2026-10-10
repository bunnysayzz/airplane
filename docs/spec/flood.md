# Airplane Flood Protocol (source of truth)

Controlled-flood dissemination over BLE. Every node that receives an event
decides, per the rules below, whether to relay it. This document is the
**source of truth**; `packages/protocol/src/flood/*` implements it.

## 1. Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `DEFAULT_TTL` | 7 | hops an event travels from its origin |
| `FLOOD_JITTER_MS_MIN` | 50 | relay jitter window lower bound (ms) |
| `FLOOD_JITTER_MS_MAX` | 500 | relay jitter window upper bound (ms) |
| `SEEN_LRU_CAP` | 10000 | max event ids in the seen cache |
| `RECEIPT_DAY_BUCKET_S` | 86400 | view-receipt dedup bucket (UTC day) |

## 2. Relay decision

On receiving an event with remaining TTL `ttl`:

```
if ttl <= 0:                      drop            # TTL exhausted
else if seen.has(event.id):       drop            # loop suppression
else:
    seen.add(event.id)
    wait uniform(50, 500) ms      # jitter: desynchronizes relays, avoids BLE collisions
    broadcast(event, ttl = ttl - 1)
```

Notes:

- `shouldRelay(seen, eventId, ttl)` returns false when the event was already
  seen **or** `ttl <= 0`. Callers MUST insert the id into `seen` when they
  relay (the check alone does not record).
- TTL is decremented **before** forwarding (`decrementTtl`, floors at 0), so
  an event with `DEFAULT_TTL = 7` is relayed at most 7 times along any path.
  Termination is guaranteed: TTL strictly decreases per hop and seen-caches
  suppress cycles.
- Jitter is uniform in `[50, 500]` ms (`sampleJitterMs`), sampled per relay.
- The originator broadcasts with `ttl = DEFAULT_TTL` and records the event in
  its own seen cache (so reflected copies are dropped).

## 3. Deduplication

- **Event dedup**: `SeenCache`, an LRU Map keyed by event-id hex, capped at
  `SEEN_LRU_CAP` (10000). Re-adding refreshes recency; the oldest entry is
  evicted past the cap. Relay and store paths share the same cache instance
  per node: an event is processed at most once per node per cache lifetime.
- **View-receipt dedup**: one countable view per `(device pubkey, post id,
  UTC day)`. Key = `${pubkeyHex}:${postIdHex}:${floor(created_at / 86400)}`
  (`ReceiptDedup`). Replays and duplicates return `false` and do not inflate
  counts. Counts are per post id.

## 4. Scoping

Events carry a precision-5 geohash cell. A node relays and displays an event
only when its cell is the node's own cell or one of the 8 neighbors
(`isInScope`). Scope is advisory for relay (a node MAY relay out-of-scope
events to keep the mesh connected - policy lives in the app layer); it is
mandatory for display.

## 5. Tombstones

A tombstone (`kind=3`) floods exactly like any other event (same TTL/jitter/
dedup rules). On receipt, the store deletes the referenced post **iff**
`tombstone.pubkey == post.pubkey`; otherwise the tombstone is dropped after
flood processing.
