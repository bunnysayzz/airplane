# Privacy Policy - Airplane

Plain-language version, no legalese theater. If anything here is unclear, the short version is: **your posts are public; your identity is not, except for the display name you choose to attach to your posts.**

## The short version

Airplane is an anonymous, location-based public broadcast feed that works over Bluetooth, with no accounts and no servers. What you write as a post is **public** - like shouting in a town square. What is **not** collected is you: no accounts, no phone numbers, no email, no analytics, no tracking.

Two things are private by design, with limits stated below: direct messages (sealed to the recipient) and Saved notes (never sent anywhere). A display name, if you set one, is public by choice: it travels on your signed posts.

## What data exists

- **Posts you write.** Stored in a local database on your phone (SQLite). That is the only copy Airplane keeps.
- **Posts you receive.** Stored in the same local database, so you can read the feed offline. Previously loaded posts are also kept in a persistent feed cache in app private storage, so the feed stays visible offline even with no peers around. The cache keeps at most 100 posts per area cell, 500 total, and has no time expiry of its own, so a cached card can outlive its store row.
- **View receipts.** Small counters the app uses to rank posts ("more views rise higher"). They live on your phone.
- **Your keypair.** A random signing key generated on first launch, stored in the device's secure storage (iOS Keychain / Android Keystore). It signs your posts so others know they came from one consistent anonymous author. It is never uploaded anywhere.
- **Your display name, if you set one.** Kept in device storage, 1 to 32 characters, and attached as a signed tag to posts you publish. It survives a key burn, because it is device storage, not key material. Clearing it does not retract claims peers already recorded from your earlier posts.
- **Direct messages.** Stored in a separate SQLite DM store on your phone. Incoming messages are stored sealed only and decrypted on read; outgoing messages keep your own plaintext on disk so your thread renders after a restart. See "Direct messages" below.
- **Saved notes.** Stored in app private key-value storage on this device only, plaintext, never sent anywhere. See "Saved notes" below.

Nothing leaves your phone except when you post, relay, or send a DM - see below.

## What is public

There is **one feed**. Anything you post is broadcast over Bluetooth to every phone in range. Anyone nearby can read it. There is no friend list and no private post.

- **Mesh-only posts** show no icon. **World-confirmed posts** - posts a copy of which has reached the public relay network - show a tiny 🌐. "World" is a *status* a post earns, not a separate feed and not a switch you flip.
- **Silent relay uplink:** when your phone is online, it silently uploads posts it receives that are not yet World-confirmed to public relays, with no approval and no prompts - and other online phones do the same with your posts. There is no local-only post: assume anything you post can reach the world, and **anyone on earth can read it** once it does.
- **Display names are public when you set one.** A post carrying your display name tag shows that name to anyone who sees the post, on the feed card and in any relay copy. If you want no name attached, leave the display name unset and the app shows only the memorable name derived from your key.

Treat every post like a flyer pinned to a public noticeboard: assume the contents can be seen, copied, and kept by strangers.

## Direct messages

DMs are not public posts. A DM is sealed so only the recipient can decrypt it, with the MAC checked, and it travels over relays, over BLE to a directly connected peer, or both. Relays and BLE peers carry only the sealed envelope, never the plaintext. Ack events carry a delivery ID and an HMAC proof, not message text, and acks are not read receipts: an ack means the peer app stored the message, not that the peer read it.

Limits, stated plainly:

- The sender identity on a DM is an unsigned claim. Anyone can seal a rumor to a recipient, so a DM does not prove who sent it. Unknown senders land in Requests, and block is local.
- Outgoing DM plaintext persists on the sender's phone by design, in the same database file that already holds feed posts in plaintext. Anyone with unlocked access to that phone can read sent DMs there.
- Deleting a conversation deletes it from your phone only. Relay envelopes and the recipient's copy are untouched.
- DM payloads carry no display name yet, so a peer you have only messaged shows their memorable name until they post.

## Saved notes

Saved notes never leave the phone. They have no publish path, no send path, and no relay or BLE transport, and the store module imports none of those. Notes are plaintext in app private storage: the OS sandbox is the only protection, there is no encryption at rest, and uninstalling the app or clearing app data deletes them. Do not treat Saved as an encrypted vault. It is a private notebook on one phone, and the guarantee is that the app itself never sends it anywhere.

## What is protected

- **Your identity, apart from a display name you choose.** With no display name set, your posts carry only a random pseudonym (like `quiet fox·a3f9`) - no name, no phone number, no device identifier you can recognize.
- **No surveillance surface.** No analytics, no crash-reporting with identifiers, no ads, no trackers, no server logs about you - because there is no Airplane server to log on.
- **No silent uplink - we do NOT promise this.** See "What is public" above: online phones silently relay unconfirmed posts to relays. Onboarding says this once, then never again. If you post, assume it can reach the world.

## World uplink: what changes when a post reaches relays

- The post is sent to one or more public relay servers over the internet. **Relay operators can see your IP address** while you upload, just like any website you visit can. Your posts remain anonymous, but your network connection to the relay is not. This can happen through your own phone or through another phone relaying your post, with no action from you at that moment.
- Once on relays, the post can be copied, archived, and re-shared by anyone. Deleting it from your phone does not delete copies others made.
- Because the contents are not encrypted (see below), treat World-uplinked posts as permanently public.

## What we do NOT promise

To stay honest, here is what Airplane does not and cannot give you:

- **No encryption of post contents.** Posts are readable by anyone in Bluetooth range (mesh) and by any relay operator. Do not post anything whose contents must stay secret.
- **No metadata protection against local observers.** Someone in Bluetooth range can observe that _some_ device is transmitting, roughly when, and roughly how far away. Radio is radio.
- **No protection from the relay knowing your IP.** See "World uplink" above.
- **No moderation or takedown power over copies.** We can never reach into someone else's phone or a third-party relay and delete your post.
- **No DM sender authentication.** See "Direct messages" above.
- **No encryption at rest for Saved notes.** See "Saved notes" above.

## What we don't collect

We collect nothing, because there is nothing to collect it with: no accounts, no sign-up, no email or phone number, no analytics events, no advertising identifiers, no location history. The app does request Bluetooth and location permission from your OS - that is only so nearby phones can find each other over Bluetooth Low Energy and so your posts can be scoped to your area; your precise location never leaves the phone - only an approximate ~5 km area cell is attached to posts you publish.

## If you sideload the APK

Airplane is distributed as a sideloadable APK. Android will warn you about installing from unknown sources - that warning is correct and worth reading. Only install builds from this repository's Releases page, and check the published SHA-256 checksums.

## Contact

Open an issue at [github.com/bunnysayzz/airplane](https://github.com/bunnysayzz/airplane) if you have questions about this policy. There is no data to request, correct, or delete on our side - it all lives on your phone.

## Changes

If this policy changes, the new version ships with the app and is dated here. We cannot notify you any other way, because we don't know who you are.

_Last updated: 2026-11-03. This version describes the app after the six track batch: DM relay plus BLE transport, Saved notes, display names, and the persistent feed cache._
