import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import Thread from '../../screens/Thread/thread';
import { getPostCardById } from '../../services/airplane/feed';
import { resolveOwnPubkeyHex, toggleStar } from '../../services/airplane/stars';
import { dmRouteForPeer } from '../../src/lib/selfDm';
import type { PostCardModel } from '../../services/airplane/types';
import { RouteTracker } from '../../components/RouteTracker/routeTracker';

export default function PostScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [posts, setPosts] = useState<PostCardModel[]>([]);
    const [loading, setLoading] = useState(true);

    // This device's own key: your own post carries a Saved action, and
    // its Message tap routes to Saved, never to a DM thread with yourself.
    const [ownHex, setOwnHex] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        void resolveOwnPubkeyHex().then(hex => {
            if (alive) setOwnHex(hex);
        });
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        let alive = true;
        // v1 has no thread query (no replies in the protocol): load the tapped
        // post directly by id. A cell-scoped feed query must NOT be used here:
        // both stores match `cells` as a set, so the old `cells: []` query
        // matched nothing and every tap rendered "This post could not be
        // found" even though the post was in the store.
        getPostCardById(id ?? '')
            .then(card => {
                if (alive) {
                    setPosts(card ? [card] : []);
                    setLoading(false);
                }
            })
            .catch(() => {
                if (alive) setLoading(false);
            });
        return () => {
            alive = false;
        };
    }, [id]);

    const goBack = () => {
        if (router.canGoBack()) router.back();
        else router.replace('/(tabs)/feed');
    };

    // STAR MVP (delimited): post-detail star button uses the same toggle.
    const handleStar = (eventId: string) => {
        const post = posts.find(p => p.eventId === eventId);
        if (!post) return;
        void toggleStar(eventId, post.geohash).catch(() => {});
    };

    // No onPostPress here, deliberately: the in-thread card IS this post,
    // and passing a navigating onPress pushed the same /post/[id] route
    // again on every tap, stacking duplicate thread screens (Back then
    // walked through duplicates). With no onPress the card renders as a
    // plain view, so a post opens once; star, message and reshare below
    // still work through their own handlers.
    return (
        <>
            <RouteTracker />
            <Thread
                postId={id ?? ''}
                posts={posts}
                loading={loading}
                onBack={goBack}
                onStar={handleStar}
                ownPubkeyHex={ownHex}
                onMessage={authorPubkeyHex => router.push(dmRouteForPeer(authorPubkeyHex, ownHex))}
            />
        </>
    );
}
