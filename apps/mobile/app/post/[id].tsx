import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import Thread from '../../screens/Thread/thread';
import { getPostCardById } from '../../services/airplane/feed';
import { toggleStar } from '../../services/airplane/stars';
import type { PostCardModel } from '../../services/airplane/types';

export default function PostScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [posts, setPosts] = useState<PostCardModel[]>([]);
    const [loading, setLoading] = useState(true);

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

    return (
        <Thread
            postId={id ?? ''}
            posts={posts}
            loading={loading}
            onBack={goBack}
            onPostPress={eventId => router.push(`/post/${eventId}`)}
            onStar={handleStar}
            onMessage={authorPubkeyHex => router.push(`/dm/${authorPubkeyHex}`)}
        />
    );
}
