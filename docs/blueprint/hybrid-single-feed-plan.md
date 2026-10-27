# Airplane: Single-Feed Hybrid Architecture Plan

**Status:** Approved by Tuba, 2026-10-10
**Supersedes:** Two-feed design (Around You / World tabs)

## 1. Product Decision

**One feed.** No tabs, no separate destinations. Every post lives in a single
chronological-by-relevance feed. "World" is not a place you post to — it's a
*status* a post earns when any copy reaches the global relay network.

**Key shifts from the old plan:**
- Killed: Around You / World tab split, opt-in World gate
- New: everything is relay-eligible by default; no "local only" privacy
- Rationale: mesh is already broadcast; the opt-in was a false promise.
  Honest design: if you post, assume it can reach the world.

## 2. Transport Architecture

### 2.1 Hybrid, not either/or

The phone uses every available transport concurrently. No mode switching.

```
                    ┌──────────────┐
                    │  Post (signed)│
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌──────────────┐          ┌──────────────┐
     │ BLE Mesh     │          │ Nostr Relays │
     │ (always on)  │          │ (when online)│
     └──────┬───────┘          └──────┬───────┘
            │                         │
            └────────────┬────────────┘
                         ▼
              ┌────────────────────┐
              │ HybridTransport    │
              │ dedupe by event ID │
              └────────────────────┘
```

### 2.2 Components

**`packages/transport` (new)**
- `BleTransport` — wraps the existing flood engine (TTL 7, seen-cache,
  jitter). Unchanged behavior.
- `NostrTransport` — new. Connects to configured public relays when online.
  Publishes signed events, subscribes to new events. Nostr event format maps
  1:1 to our signed post envelope (we already use Ed25519).
- `HybridTransport` — orchestrates both. Single ingress point for incoming
  posts regardless of source. Deduplicates by event ID (SHA-256 of signed
  payload). Emits to the feed store.

### 2.3 Connectivity handling

- `NetInfo` monitors online/offline (no Google Play Services dependency).
- Online → NostrTransport activates: push unsynced posts, pull new events.
- Offline → NostrTransport idles; BLE continues uninterrupted.
- Flaky connections → opportunistic sync; no state machine, just "try when
  you can." Posts queue locally until a transport succeeds.

## 3. Silent World Relay

**No user approval. No prompts. No Google.**

When your phone has internet and receives a post (via BLE or otherwise) that
isn't yet confirmed on World, it uploads the exact signed bytes to relays.
Silently, in the background.

**Why this is safe:**
- Posts are anonymous broadcast by design. Relay is the intended behavior,
  not a leak.
- Signatures cover the full payload. Relays cannot modify, only copy.
- Worst case (manual copy-paste) exists for any public content.

**Onboarding disclosure (one time, then never again):**
> "Posts you send may reach the wider network through other phones."

### 3.1 Background execution (dedicated work item)

Without FCM/Google Play Services:
- **Android:** Doze mode throttles background network. Relay happens during
  allowed windows + when app is foregrounded. Use `expo-background-fetch`
  with conservative intervals; request battery optimization exemption at
  onboarding (explained, not forced).
- **iOS:** Background is OS-crippled (known limit). BLE already degraded;
  Nostr sync will be foreground + Background App Refresh only.
- Net result: relay is *opportunistic*, not guaranteed instant. The protocol
  must not assume timely delivery.

## 4. World Confirmation Tracking

### 4.1 States (client-side only, never in signed payload)

| State | Meaning | UI |
|-------|---------|----|
| `mesh-only` | Not seen on any relay yet | No icon (default, clean) |
| `syncing` | Online, push in flight | No icon (transient) |
| `on-world` | Event ID found on ≥1 relay | Tiny 🌐 |

**UI rule (Tuba):** mesh-only shows nothing. Only World-confirmed posts get
the very small globe. The icon means something because it's rare.

### 4.2 Confirmation mechanism

- Local store keeps `worldConfirmed: boolean` per event ID (in SQLite, not
  in the post itself).
- When online, client queries relays for its unconfirmed event IDs
  (Nostr `REQ` with `ids` filter).
- On match → mark confirmed, update UI.
- Another phone relaying your post doesn't notify you; you discover it on
  next sync. "Pending World sync" is the honest interim state.

### 4.3 Dedup across transports

- Event ID = SHA-256 of canonical signed bytes. Identical across BLE/Nostr.
- Seen-cache (existing) prevents reprocessing.
- Relay dedupes naturally by event ID.

## 5. Feed & Ranking (unchanged)

- Single feed, ranked by views (log-scaled decay) — the novel bit, unchanged.
- View receipts still need Sybil resistance (open design problem, not
  blocking v1).
- No topic/channel filtering in v1. "Proper audience" = geographic +
  temporal proximity via mesh; global via relays.

## 6. Privacy & Safety Implications

- **No local-only posts.** If this is a problem for a use case, that use
  case needs a different app. Be explicit in onboarding.
- **Anonymous, not encrypted.** Relay operators and mesh peers see plaintext.
  UI must say "anonymous," never "private" or "encrypted."
- **Tombstones:** existing authorship enforcement (kind-3) carries over.
  Deletion propagates the same hybrid path.
- **Spam:** mesh range is the natural rate limit locally; relays need
  per-relay rate limiting (Nostr relays already do this).

## 7. Build Order

1. ✅ Protocol (no change — event ID + Ed25519 already sufficient)
2. `NostrTransport` — relay pub/sub, event mapping
3. `HybridTransport` — dual ingress, cross-transport dedup
4. Storage: `worldConfirmed` per event ID (SQLite)
5. Sync engine: push unsynced, pull new, confirm on match
6. NetInfo wiring + background fetch setup
7. UI: single feed, tiny 🌐 for confirmed posts only
8. Onboarding: one-time World disclosure
9. P0: physical phone testing (2 Android + 1 iPhone) — BLE + relay
   interop cannot be verified in cloud builds

## 8. Open Risks

- **Background relay on Android without FCM** is best-effort. May need
  user to disable battery optimization for reliable relay.
- **iOS background** remains crippled; iOS users are primarily consumers,
  not relays.
- **Relay availability:** which public Nostr relays? Need a curated default
  list with fallback. Relay censorship is out of scope (client can switch).
- **View receipt Sybil** still unsolved; ranking is gameable in v1.
- **EAS build quota:** ~30/month free; hybrid testing will burn builds.
