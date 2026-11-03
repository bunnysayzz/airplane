# DM transport: relay plus BLE, with honest delivery states

DMs in Airplane move over two transports: Nostr relays and BLE to
directly connected peers. There is no multi-hop DM in v1. This doc is
the merged truth after the DM transport parity track. It supersedes any
older line that said DMs are relay only, and any older line that said
DMs are kept only for the app session.

## Envelope shape

A DM is a sealed envelope addressed to one peer. The shape follows
NIP-17 (ephemeral key gift wrap, kind 1059 style wrapper, kind 14 rumor)
and the payload follows NIP-44 v2, but the ECDH curve is X25519, not
secp256k1, so payloads are not byte compatible with standard Nostr
clients. A DM address is the recipient mesh pubkey hex; keys are
converted from the Ed25519 device key.

A message envelope carries a per-send 32-hex delivery ID. Envelopes from
old senders carry no delivery ID and cannot be acked. The rumor sender
pubkey is a claim, not a proof: anyone can seal a rumor to a recipient.
That sender authentication gap is open work, listed in the README
limitations, and abuse is handled by the Requests folder and block, not
by authentication here.

DM text is capped at 4096 UTF-8 bytes. There are no read receipts, and
none are requested.

## Fragment channels

Posts and DMs share the BLE fragment layer but not the channel. The
11-byte fragment header carries a channel flag: 0 is feed, 1 is DM.
Each reassembler accepts only its own channel, so DM frames never reach
the feed path and feed frames never reach the DM path. Old installs
reject flags 1 at parse, so they silently drop BLE DM frames instead of
misreading them.

## Relay transport

Relay publish uses pooled sockets with parallel publish to all relays
and a 5 second first-OK deadline: the first relay OK settles the
publish, and an explicit relay rejection settles it at once instead of
waiting out the deadline. A relay OK means the relay accepted the
envelope. It does not mean the peer has it.

Subscriptions resubscribe live with backfill. A resubscribe replays
from the last envelope or ack seen, minus a 300 second overlap, so a
drop gap replays instead of being lost. The first subscribe replays at
most the last 24 hours. Anything older than relay retention is still
missed.

NIP-42 AUTH is not answered: a relay that challenges with AUTH gets no
answer, and AUTH never gates delivery and never crashes the app.
Half-open socket detection is absent in v1: there is no ping, so a
socket that goes silent without an error or a close is not detected
here. Recovery is at the app layer.

## BLE transport

BLE DMs go only to directly connected peers. A BLE notify resolving
means the radio accepted the frame, not that the peer app received it:
the peer central may not have been subscribed yet, so the frame may
never have reached the peer app. That is why a BLE notify lands in
MeshSent, never Delivered.

## Delivery states

Sending is optimistic: the row is stored, the send returns at once, and
a background flush does the work. A flush is forced when the app returns
to the foreground, when connectivity returns, and on 0-to-N BLE peer
transitions, plus the normal backoff timer. The outbox retries with
backoff and a 5 attempt cap for hard failures, then Failed, except for
the two states that never end in failure on their own: Queued and
Relayed, below.

| State | Thread label | Rule |
|---|---|---|
| Sending | Sending | An attempt is in flight, or a hard failure is being retried inside the attempt cap. Never a final state. |
| Queued | Queued, waiting for a transport | The last attempt found no transport at all (relays unreachable and no BLE peers). Retried without an attempt cap: offline for hours still drains when a transport returns, it does not Failed. |
| Relayed | Sent to relay, not delivered yet | A relay accepted the envelope. Never re-published (re-publishing the same event ID is a no-op at the relay) and never Failed. No ack timeout: it stays Relayed until an ack arrives. |
| MeshSent | Sent over BLE, not delivered yet | A BLE notify went out to at least one connected peer. Re-attempted when due (30 seconds) or on force flush; a relay success upgrades it to Relayed; 5 mesh sends without an ack end in Failed. |
| Delivered | Delivered | Only on a verified peer ack. See Acks below. |
| Failed | Failed, tap to retry | Hard failures exhausted, or mesh sends exhausted without an ack. Tap to retry re-queues the message, resets attempts, and sends again. |

A late ack still upgrades any state to Delivered, including Failed.
A row in Relayed or MeshSent is a handoff, not a trap: it stays visible
with its "not delivered yet" label until an ack arrives.

The polish track's old "Sent to relay" wording is subsumed by this
table. Do not reintroduce it as a state: Relayed already carries that
label, and MeshSent, Queued, and Delivered are distinct states with
distinct rules.

## Acks: delivery proof, not read receipts

A peer app sends an ack when it stores the message, not when the user
opens the thread. The ack is a sealed rumor to the original sender
carrying the delivery ID and a proof: HMAC-SHA256 over the delivery ID,
keyed by the message conversation key. The sender checks the proof
against the proof it stored at send time. A mesh bystander that overheard
the delivery ID cannot forge the proof, because it holds neither the
sender ephemeral secret nor the recipient secret.

Acks travel as Airplane-private kind 1060 events. Message envelopes stay
kind 1059, and old installs subscribe to 1059 only, so they never see
acks. An ack is never inferred from message text: a 1059 message whose
text happens to look like ack JSON is still just a message.

## SQLite DM store

DMs live in the SQLite database `airplane.db`, separate from the public
post store. Tables:

- `dm_conversations`: one row per peer, with state (inbox, request,
  blocked), mute, unread count, last message time, last sealed payload,
  and last direction.
- `dm_messages`: one row per message, with the sealed payload, the full
  sendable envelope, delivery ID, ack proof, status, and attempt counts.
  Retention is the newest 1000 messages per conversation.
- `dm_seen`: delivery IDs already seen, with peer and time.

Storage rule, stated exactly because it matters: incoming rows are
stored sealed only, and their plaintext is produced by decrypt-on-read
and never written to disk. Outgoing rows additionally persist the
sendable envelope (the ephemeral pubkey header, which the sealed payload
alone does not carry) so a retry after a restart re-sends the identical
bytes, and they persist the sender's own plaintext so the sender thread
still renders after a restart. That plaintext is the sender's own words,
in the same database file that already holds feed posts in plaintext.

Deleting a conversation deletes its `dm_conversations` and `dm_messages`
rows locally only. Relay envelopes and the recipient's copy are
untouched. The `dm_seen` rows are deliberately kept, so a relay replay
of an already seen envelope cannot resurrect a deleted conversation.

## Interop: old installs, new installs, mixed pairs

- Old install receiving a BLE DM frame: drops it at parse (flags 1
  rejected). No error, no partial message.
- Old install receiving a kind 1060 ack: never sees it, because it
  subscribes to kind 1059 only.
- New sender to old recipient: the message can still travel by relay
  and honestly stays Relayed, because no ack will ever come back.
- Old sender to new recipient: the envelope has no delivery ID, so the
  new recipient cannot ack it, and the old sender's state never becomes
  Delivered. The message itself still arrives and reads normally.
- New sender to new recipient, offline, connected by BLE: the message
  goes MeshSent, then Delivered on the verified ack. This is the
  two-phone offline DM check in the README.

## UI surfaces

- Messages tab: inbox, Requests (unknown senders land here, never
  straight in the inbox), blocked list, and the pinned Saved row (see
  [self-messages.md](self-messages.md)).
- DM thread: empty state reads "No messages yet." Outgoing bubbles show
  the thread label from the states table above. Only Failed bubbles are
  tappable for retry.
- Message by username: see [identity.md](identity.md). The Messages
  input searches known peers only; a never-seen peer cannot resolve by
  name.

## What is still open

- DM sender authentication: the rumor sender pubkey is an unsigned
  claim. A signed-DM fix would break interop and needs a user decision.
- Multi-hop DM: direct connected peers only in v1.
- NIP-42 AUTH unanswered, and no ping for half-open sockets in v1.
- Relayed rows have no ack timeout and are never re-published.
- Backfill is bounded: 24 hours on first subscribe, last envelope or
  ack minus 300 seconds on resubscribe.
