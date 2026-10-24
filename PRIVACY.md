# Privacy Policy — Airplane

Plain-language version, no legalese theater. If anything here is unclear, the short version is: **your posts are public; your identity is not.**

## The short version

Airplane is an anonymous, location-based public broadcast feed that works over Bluetooth, with no accounts and no servers. What you write is **public** — like shouting in a town square. What is **not** collected is you: no accounts, no phone numbers, no names, no email, no analytics, no tracking.

## What data exists

- **Posts you write.** Stored in a local database on your phone (SQLite). That is the only copy Airplane keeps.
- **Posts you receive.** Stored in the same local database, so you can read the "Around you" feed offline.
- **View receipts.** Small counters the app uses to rank posts ("more views rise higher"). They live on your phone.
- **Your keypair.** A random signing key generated on first launch, stored in the device's secure storage (iOS Keychain / Android Keystore). It signs your posts so others know they came from one consistent anonymous author. It is never uploaded anywhere.

Nothing leaves your phone except when you post or relay — see below.

## What is public

- **"Around you" feed:** anything you post is broadcast over Bluetooth to every phone in range. Anyone nearby can read it. There is no friend list, no private posts, no direct messages.
- **"World" feed (opt-in only):** if you flip the "Share with the World feed" switch when posting, that post is additionally sent through public relays, and **anyone on earth can read it**.

Treat every post like a flyer pinned to a public noticeboard: assume the contents can be seen, copied, and kept by strangers.

## What is protected

- **Your identity.** There are no accounts. Your posts carry only a random pseudonym (like `anon·a3f9`) — no name, no phone number, no device identifier you can recognize.
- **No surveillance surface.** No analytics, no crash-reporting with identifiers, no ads, no trackers, no server logs about you — because there is no Airplane server to log on.
- **No silent uplink.** The World feed is per-post and opt-in. A post never goes global unless you flip the switch on that post. The default is local mesh only.

## World uplink: what changes when you flip it

- The post is sent to one or more public relay servers over the internet. **Relay operators can see your IP address** while you upload, just like any website you visit can. Your posts remain anonymous, but your network connection to the relay is not.
- Once on relays, the post can be copied, archived, and re-shared by anyone. Deleting it from your phone does not delete copies others made.
- Because the contents are not encrypted (see below), treat World-uplinked posts as permanently public.

## What we do NOT promise

To stay honest, here is what Airplane does not and cannot give you:

- **No encryption of post contents.** Posts are readable by anyone in Bluetooth range (mesh) and by any relay operator (World feed). Do not post anything whose contents must stay secret.
- **No metadata protection against local observers.** Someone in Bluetooth range can observe that _some_ device is transmitting, roughly when, and roughly how far away. Radio is radio.
- **No protection from the relay knowing your IP.** See "World uplink" above.
- **No moderation or takedown power over copies.** We can never reach into someone else's phone or a third-party relay and delete your post.

## What we don't collect

We collect nothing, because there is nothing to collect it with: no accounts, no sign-up, no email or phone number, no analytics events, no advertising identifiers, no location history. The app does request Bluetooth and location permission from your OS — that is only so nearby phones can find each other over Bluetooth Low Energy and so your posts can be scoped to your area; your precise location never leaves the phone — only an approximate ~5 km area cell is attached to posts you publish.

## If you sideload the APK

Airplane is distributed as a sideloadable APK. Android will warn you about installing from unknown sources — that warning is correct and worth reading. Only install builds from this repository's Releases page, and check the published SHA-256 checksums.

## Contact

Open an issue at [github.com/enginoor/airplane](https://github.com/enginoor/airplane) if you have questions about this policy. There is no data to request, correct, or delete on our side — it all lives on your phone.

## Changes

If this policy changes, the new version ships with the app and is dated here. We cannot notify you any other way, because we don't know who you are.

_Last updated: 2026-10-10._
