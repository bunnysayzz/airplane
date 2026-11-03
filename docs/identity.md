# Identity: keys, memorable names, display names, avatars

Airplane has no accounts. Identity is a keypair, a derived memorable
name, and an optional user-chosen display name. This doc describes the
merged result after the identity track.

## Keys

On first launch the app generates an Ed25519 keypair on device. The
private key never leaves the device. Posts are signed with it, so a
stream of posts from one key is recognizably one author, and a relay or
peer cannot rewrite a signed post without breaking the signature.

Settings, Identity offers burn and rotation: replace the keypair with a
new one. The consequences are stated in the UI. Authorship of old posts
is abandoned (the new key cannot sign as the old author), and the DM
address changes, because a DM address is the mesh pubkey hex. The
real-device rotation check is still open work. A display name and Saved
notes survive a burn, because both are kept in device storage, not
derived from the key. See [self-messages.md](self-messages.md).

## Memorable names

With no display name set, a peer is shown by a memorable name: an
adjective plus a noun derived deterministically from the pubkey, plus a
hex suffix in the full label form, for example `quiet fox·a3f9`. The
wordlists are unchanged by the identity track. The memorable name is a
label for a pubkey, not a username that can be claimed or registered.
Two devices deriving a name from the same pubkey get the same name.

## Display names

A user-chosen display name is set in Settings, Identity. Rules:

- 1 to 32 characters, no control characters, trimmed. An empty value
  clears the name.
- It travels as a signed claim: posts carry a `["display_name", name]`
  tag, covered by the author's Ed25519 signature. A peer that records
  the name from a post is recording a claim the author signed, not a
  name the relay asserted.
- Older installs ignore the tag safely. They keep showing the memorable
  name.
- Clearing a name does not retract claims peers already recorded from
  earlier posts. Peers that recorded the old claim keep showing it until
  they see a newer signed post from that author without the tag, and
  even then the recorded claim is local state, not something the author
  can remotely delete.
- A display name survives a key burn, because it is kept in device
  key-value storage. Note the tension this creates: after a burn, the
  name is still set locally, but new posts are signed by the new key, so
  peers see the name attached to the new key, not the old one.

### Where names show

Feed cards, DM rows, and thread headers show the clean name with no hex
suffix. The suffix appears only on a name collision: when the local
peer registry knows two peers with the same base name, the colliding
peers get a hex suffix so they can be told apart. Avatar colors differ
per pubkey regardless, so same-name peers still look different even
before the suffix rule fires.

The full key and the full label stay visible in two places: the Identity
screen (which shows the full pubkey hex, selectable for copy) and a
DM thread Details toggle (which shows the full memorable label plus
the full key behind the clean header name).

### What display names are not

A display name is not an account, not a registered handle, and not
unique. Two peers can choose the same display name, and the collision
rule above is the only disambiguation. A display name is also not a
proof of who someone is offline: it is a signed claim from a key, and
the key itself is the identity. If a key is burned, the name attached to
the old key does not transfer to a new person; it simply stops being
asserted by new posts from that key. Likewise, a relay accepting an
envelope (a relay OK) or a World globe on a post is not identity proof
and not delivery proof: acceptance and a query hit say a relay held a
copy, nothing about who holds the key offline or whether a peer
received anything.

## Message by username

The Messages input searches known peers only. Known means: inbox
contacts, requests, blocked peers, and authors of posts this device has
seen (the peer registry of signed display name claims plus post
authors). Matches rank exact first, then prefix, then substring. Paste
a 64-hex pubkey as the fallback for anyone else.

The hard limit is real and by design: a never-seen peer cannot resolve
by name. There is no central directory, no relay lookup, and no search
across the network. If the input shows "No known peer matches that name",
the only route is the full key. This is a consequence of having no
server, not a missing feature to patch with a lookup service.

## DM display name gap

DM payloads carry no display name yet. A peer you have only messaged,
and never seen post, shows their memorable name in the DM thread until
they post. Once they post with a display name tag, the registry records
it and the clean name appears. This gap is listed in the README
limitations.

## Generated avatars

Every peer gets a generated avatar: initials plus a deterministic
two-stop gradient derived from their pubkey bytes, rendered with
expo-linear-gradient, which was already an app dependency. Properties:

- Stable across devices: the same pubkey always yields the same
  gradient, with no image download and no server.
- Distinct per peer: distinct keys almost always land on distinct
  gradients, and the initials come from the display string, so the
  avatar tracks the name the peer is shown by.
- Used everywhere avatars appear: feed cards, DM rows, thread headers,
  the Identity screen, and username search matches.

An avatar is a visual label for a pubkey, not a photo and not an
identity proof. If two peers share a name, their gradients still differ,
which is why the avatar is part of the collision story, not decoration.

## Peer registry

The peer registry is local, in-memory plus device storage state, built
from signed post tags this device has actually seen. It records, per
pubkey hex, the latest valid display name claim from that author's
signed posts. A post without the tag never overwrites a known name with
blank. The registry is what powers username search, collision suffixes,
and clean names on DM rows. It is not synced, not exported, and not
queried from anywhere else.
