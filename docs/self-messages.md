# Saved messages: a private conversation with yourself

Saved is a private notes thread, not a DM. It looks like a DM thread
and deliberately is not one: there is no peer, no envelope, no outbox,
and no delivery state.

## Surface

The Messages tab has a pinned Saved row above the Inbox. It shows a
count only, never a snippet, with the line "This device only. Never sent
to anyone." Tapping it opens the thread at `/dm/self`, which reuses the
DM thread layout (chronological list, input row, auto scroll to the
latest note) with a Save button and no Sending, Sent, or Failed labels,
because there is nothing to send.

Deleting a note is a local delete. Saved notes exist nowhere else, so
deleting here deletes them entirely. There is no export, share, or
reshare path for notes, and adding one would need a fresh privacy
review, because the whole point of the store is that notes cannot leave.

## Store

Saved notes live in a dedicated store over the app private key-value
port (MMKV on device), under key `self-messages-v1`. One JSON array
holds the notes. Limits:

- 4096 UTF-8 bytes per note, the same cap as a DM. A note is not a
  document.
- 1000 notes total. Past the cap, the oldest notes drop first.
- Empty notes are rejected. A corrupt stored row reads as empty, never
  as a crash.

The store is deliberately separate from the DM store. The DM store holds
sealed envelopes addressed to peers; a saved note has no peer, no sealed
envelope, and no delivery state, so it does not belong in `dm_*` tables.
The separation is also what makes the privacy claim checkable: the saved
notes module imports no DM service, no relay port, no BLE port, and no
outbox, so there is no code path from a saved note to a publish or send
call. That absence was tested with a counting relay: zero relay
publishes while saving notes.

## Durability

Notes survive an app restart, because MMKV persists across restarts.
Notes also survive identity burn and rotate, because they are device
bound, not identity bound: rotating the keypair wipes only the keypair
and resets identity derived caches, it does not wipe KV, and it does
not wipe old posts, stars, or receipts either. The new identity keeps
the same notes on the same device.

Uninstalling the app, or clearing app data, deletes saved notes along
with everything else in app private storage. There is no cloud backup
and no restore path.

## Privacy at rest: stated exactly

Notes are plaintext in the app private KV file. That file lives in app
private storage, is never uploaded, and is not read by any sync, backup,
or share path in this codebase. It is not sealed like a DM, because
there is no peer to seal to and no local encryption layer for notes
exists. The protection is location (this device only) plus never
transmitting, not encryption. Anyone with unlocked access to the device
or its app private storage can read saved notes. Do not treat Saved as
an encrypted vault. It is a private notebook on one phone, and the
guarantee is that the app itself never sends it anywhere.
