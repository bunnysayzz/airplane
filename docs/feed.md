# Feed: new posts at top, and the persistent cache

Two feed behaviours changed in this batch, and they interact: new posts
at top (how fresh cards join the list) and the persistent cache (what
the list shows when the live query comes back empty). This doc describes
both, and the merged interaction to verify: the Saved row pinning
behaviour over the cached list on the merged tree.

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

### Merged interaction to verify

The new-posts track and the cache track both touch Timeline, and the
Saved row pinning in the Messages screen sits above the same feed
surfaces. On the merged tree, verify: a pill tap prepends fresh cards
over a cached list (not over a blanked list), a refresh that returns
nothing keeps the merged list, and the cached banner appears only when
the shown cards actually came from the cache. If a pill tap ever blanks
a cached list on the merged tree, that is a merge regression in
Timeline, not a behaviour of either track alone.
