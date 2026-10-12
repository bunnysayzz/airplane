import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import Thread from '../../screens/Thread/thread';
import { listFeedPosts } from '../../services/airplane/feed';
import type { PostCardModel } from '../../services/airplane/types';

export default function PostScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [posts, setPosts] = useState<PostCardModel[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        // v1 has no thread query (no replies in the protocol): load recent posts and
        // hand Thread the one that matches. Thread highlights postId; until replies
        // exist it shows the single post.
        listFeedPosts({ cells: [], limit: 200 })
            .then(all => {
                if (alive) {
                    setPosts(all.filter(post => post.eventId === id));
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

    return (
        <Thread
            postId={id ?? ''}
            posts={posts}
            loading={loading}
            onBack={goBack}
            onPostPress={eventId => router.push(`/post/${eventId}`)}
        />
    );
}
