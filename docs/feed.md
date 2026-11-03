# Feed: new posts at top, the persistent cache, and delivery states

Feed behaviour on the merged tree covers new posts at top (how fresh
cards join the list), the persistent cache (what the list shows when
the live query comes back empty), and the delivery states that ride on
the cards themselves: the durable post outbox and Unsent, World
confirmed on query hit only, the last-known area marker, and honest
BLE wording. The merged interaction to verify on real phones is the
Saved row pinning behaviour over the cached list, plus the new card
states below.

## New posts at top

### The problem that was fixed

Fresh posts score zero, because they have zero views. Ranked by views,
a fresh post sorts below every viewed post and falls past page 1, so a
user scrolled down never saw it arrive, and a refresh did not surface
it at the top either. The pill said new posts existed; the list did not
show them.

### What the pill tap does now

While scrolled down, arrivals pile up behind an "N new posts" pill
instead of yanking the list. Tapping the pill:

1. Snapshots the post IDs currently on screen.
2. Refreshes from the store.
3. Pages ranked pages without touching the pagination cursor until a
   fresh card is found, that is, a card whose ID was not in the snapshot.
4. Prepends the fresh cards newest first and scrolls to the top.

Ranking, cell scoping, and pill design are unchanged. Only the join
behaviour changed: fresh cards now arrive at the top on pill tap instead
of sorting below viewed posts past page 1.

### Known gap: pill count

The pill count is notification based, not post based, so counts can be
noisy. A count that says 3 while 2 fresh cards prepend is a counting
artefact, not a missing post. The prepend itself, and the scroll to top,
are the behaviour to test; the count is not a reliable post count.

## Persistent feed cache

### The problem that was fixed

The feed query is cell scoped, and the Timeline used to replace its
whole list with every refresh result. Any refresh that resolved to no
matching rows, an empty scope, or a new cell window wiped the visible
list, even though the posts were still in the on-device store. Losing
peers does not delete anything; it only stops new arrivals, and the next
refresh then showed the empty result instead of the last loaded feed.

### What happens now

The last loaded cards are persisted in the app KV store (MMKV on
device, never a server) under key `feedCache.v1`. A refresh resolves
like this:

- Non-empty live result: fresh cards merge at the top, deduped by event
  ID, and the merged list is saved to the cache. State: live.
- Empty live result, with cards already on screen: keep the on-screen
  cards. State: cached.
- Empty live result, no on-screen cards, but saved cards exist: show the
  saved cards. State: cached.
- Empty live result, nothing on screen and nothing saved: genuinely
  empty. State: empty.

A failed query also falls back to saved cards, so a transient store
error does not blank a feed the user was reading.

### Retention: count and size, never time

- 100 posts per geohash-5 cell, in display order.
- 500 posts total, in display order.
- 512 KiB serialized cache size. Past the byte cap, cards drop from the
  end of the list, so the cards at the top survive longest.

There is no time expiry in the cache. A card stays until it is pushed
out by count or size, even past the store 24 hour window. That is
deliberate: this is a social media style cache, not a time based cache.
Cached cards are the same public by design post bodies the store already
holds locally, so nothing new is stored, only kept visible longer.

A corrupt, wrong shape, or missing cache payload reads as an empty
cache, never as a crash. A cache write failure never breaks a feed load
that already succeeded: persistence is best effort.

### Honest UI states

The Timeline keeps three states distinct, and never presents cached
content as live local posts:

| Situation | Banner or empty text |
|---|---|
| Saved cards showing while the live result is empty | "Showing saved posts." |
| Genuinely empty, no scope yet (location not granted, no saved cards) | "Nothing here yet - be the first to post." |
| Scope resolved, new cell, no posts, nothing saved | "No posts in this area yet." |
| Saved cards showing, but none belong to the current cells | "No posts in this area yet. Showing saved posts from other areas." |

The last row is the combined banner: it says both things at once, so a
user in a new area is not misled into thinking the saved cards are
local posts.

### Known gap: cached card detail expiry

The detail route reads the store directly, not the cache. A cached card
whose store row passed the 24 hour expiry may therefore show "post could
not be found" on the detail route, even though the card still shows in
the feed list. The feed list is what the cache preserves; the detail
route is not cached. This gap is listed in the README limitations.

## Durable post outbox and Unsent

Own posts are queued in the `post_outbox` table at save time, before
fanout runs, so a kill during fanout still leaves a retryable row.
The table holds delivery state only, never unsaved text: one row per
own kind-1 post, with status `pending`, `ble-sent`, or `unsent`, and
World confirmation deletes the row. The outbox drains over BLE on
peer arrival, at transport start, and on foreground radio re-validation,
oldest first, re-checking each row against the store first (a missing
or World-confirmed event removes its row instead of stalling the
drain). Relay retry is not done by the drain: WorldSync owns relay
retry on its 60 second tick plus connectivity return, foreground
return, and immediately after a relay win, oldest first, at most 50
unconfirmed posts per pass. A BLE drain while online would break
relay-first order, so the drain is the offline path.

The feed card reports the outbox state, and only for the author's own
posts (another phone's post in the feed is already delivered to this
phone by definition):

- `unsent`: the card shows "Unsent". That is the state when the router
  reached no transport, or when a pending row is older than 10
  seconds (a fanout still in flight inside the 5 second router
  deadline does not flash Unsent).
- `ble-sent`: the card shows neither globe nor Unsent. The post was
  handed to the radio and still awaits World.
- World-confirmed: the globe wins over Unsent. A row that was never
  enqueued (inbound posts, old installs) shows neither state.

After publish, the toast says "Post saved". That confirms the local
save only. Delivery lives on the card, as above, so the two never
disagree: they report different stages.

## World confirmed on query hit only

The globe appears only when a relay query hit returns the post, never
instantly on a relay OK. A relay OK means acceptance; a relay can OK
then drop the event before any peer fetches it. After a relay win, the
app runs a WorldSync pass at once instead of waiting up to 60 seconds
for the next tick: the pass re-pushes the still-unconfirmed post and
queries for it, and only a hit confirms it. A dropped event leaves no
globe and stays unconfirmed for later passes to re-push. Relay
observation is not deduplicated for confirmation: the hook runs for
every relay-sourced event, including duplicates, so a query hit
confirming a post this phone already published is not swallowed by the
seen cache that publish time populated. BLE observation never
confirms World.

## Last-known area marker

When the fresh fix fails with a timeout or an unavailable provider,
and only then, the post falls back to a real previously seen area:
the OS last-known position at any age, else the app's own expired
cache cell. The fallback cell is never written back into the fresh
cache, never invented, and permission or services failures never reach
it. A fallback post carries the signed `["location_source",
"last-known"]` tag, and its feed card shows "Last known area". Older
installs ignore the tag and show no marker. Fresh and cached cells
carry no marker and need none.

## Cell scoping and far posts

The feed list shows the device geohash-5 cell plus its 8 neighbours.
Delivery is not scoped the same way: a bridge forwards posts
regardless of cell (see [spec/flood.md](spec/flood.md)), and relays
do not know the feed scope, so a far post can be relay-delivered and
stored yet stay invisible in the feed list by design. That is not a
lost post. The detail route lookup itself is unscoped, which is why a
cached card whose store row expired can still be listed while its
detail route reports it missing (see the known gap below).

## Honest BLE wording

A completed BLE broadcast is reported as handed to radio, never as
delivered. A GATT notify can resolve even with no peer app subscribed,
and there is no BLE ack frame for posts in this batch, so no BLE post
status may claim peer delivery. The post BLE ack frame is a follow-up,
not shipped work. DM delivery is different: Delivered there means a
verified peer ack, never a notify. See
[dm-transport.md](dm-transport.md).

### Merged interaction to verify

The new-posts track and the cache track both touch Timeline, and the
Saved row pinning in the Messages screen sits above the same feed
surfaces. On the merged tree, verify: a pill tap prepends fresh cards
over a cached list (not over a blanked list), a refresh that returns
nothing keeps the merged list, and the cached banner appears only when
the shown cards actually came from the cache. If a pill tap ever blanks
a cached list on the merged tree, that is a merge regression in
Timeline, not a behaviour of either track alone. Verify the card
states alongside it: Unsent on a no-transport own post, neither mark
on a BLE-handed post, globe only after a query hit, and "Last known
area" only on a fallback post.
