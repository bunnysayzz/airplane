import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import Ionicons from '@expo/vector-icons/Ionicons';
import { listFeedPosts, subscribeFeed } from '../../services/airplane/feed';
import { trackViewability } from '../../services/airplane/viewTracker';
import type { PostCardModel } from '../../services/airplane/types';
// TODO(worker2): PostCard is built by another worker - this import resolves when it lands.
import { PostCard } from '../../components/PostCard';
import { hitSlopFor } from '../../src/theme/shape';
import { useTheme } from '../../src/theme/themeContext';
import { FEED_PILL_HEIGHT, makeStyles } from './styles';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { useI18n } from '../../src/i18n/i18nContext';
import { NewPostsPill } from './newPostsPill';

export type FeedKey = 'around' | 'world';

export interface FeedTab {
    key: FeedKey;
    label: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    activeIcon: React.ComponentProps<typeof Ionicons>['name'];
}

// FlashList keeps the first visible post in place while posts above it get measured, which cut an
// animated scrollToOffset(0) short after scrolling far. scrollToIndex pauses that correction, jumps
// near the top and animates the rest; then settle on offset 0 (the list's top padding).
export const scrollListToTop = async (list: Pick<FlashListRef<PostCardModel>, 'scrollToIndex' | 'scrollToOffset'> | null) => {
    if (!list) return;
    await list.scrollToIndex({ index: 0, animated: true });
    list.scrollToOffset({ offset: 0, animated: true });
};

interface TimelineProps {
    feeds: FeedTab[];
    activeFeed: FeedKey;
    onFeedChange: (feed: FeedKey) => void;
    // TODO(worker4): wire to services/airplane - `cells` is a stub data prop for now.
    // 'around' needs the viewer's geohash-5 cell (no location provider in the app yet);
    // 'world' is the opportunistic Nostr-relay feed, which has no local query yet.
    cells: string[];
    onPostPress?: (eventId: string) => void;
}

const PAGE_LIMIT = 50;

// Pugdon's timeline chrome (feed pills, new-posts pill, pull-to-refresh, infinite
// scroll) re-driven by services/airplane: listFeedPosts + subscribeFeed replace
// react-query, and PostCardModel replaces Mastodon Status.
const Timeline: React.FC<TimelineProps> = ({ feeds, activeFeed, onFeedChange, cells, onPostPress }) => {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { t, tn } = useI18n();
    const listRef = useRef<FlashListRef<PostCardModel>>(null);

    const [posts, setPosts] = useState<PostCardModel[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    // A failed initial/refresh query with nothing on screen gets an error view + retry,
    // not a silent console.error (the old stub swallowed it).
    const [loadError, setLoadError] = useState(false);
    // Posts that arrived (via subscribeFeed) while the user was scrolled down
    const [pendingCount, setPendingCount] = useState(0);
    const atTop = useRef(true);
    const cellsKey = useMemo(() => [...cells].sort().join(','), [cells]);
    // The pagination cursor reads the latest posts; a ref avoids a stale closure in `load`
    const postsRef = useRef<PostCardModel[]>([]);
    postsRef.current = posts;

    const load = useCallback(
        async (mode: 'initial' | 'refresh' | 'more', before?: number) => {
            if (mode === 'initial') setLoading(true);
            if (mode === 'refresh') setRefreshing(true);
            if (mode === 'more') setLoadingMore(true);
            if (mode !== 'more') setLoadError(false);
            try {
                const fresh = await listFeedPosts({ cells, limit: PAGE_LIMIT, before });
                setHasMore(fresh.length >= PAGE_LIMIT);
                setPosts(current => (mode === 'more' ? [...current, ...fresh] : fresh));
                if (mode !== 'more') setPendingCount(0);
            } catch (error) {
                console.error('Failed to load feed:', error);
                if (mode !== 'more') setLoadError(true);
            } finally {
                setLoading(false);
                setRefreshing(false);
                setLoadingMore(false);
            }
        },
        [cellsKey]
    );

    // Fresh query when the feed or its cells change
    useEffect(() => {
        setPosts([]);
        setHasMore(true);
        load('initial');
    }, [activeFeed, cellsKey, load]);

    // The store has no change events of its own: composer and viewTracker notify,
    // and the timeline re-queries. Arrivals while scrolled down pile up behind the pill.
    useEffect(
        () =>
            subscribeFeed(() => {
                if (atTop.current) {
                    load('refresh');
                } else {
                    setPendingCount(count => count + 1);
                }
            }),
        [load]
    );

    const showNewPosts = useCallback(async () => {
        await load('refresh');
        scrollListToTop(listRef.current);
    }, [load]);

    const handleLoadMore = () => {
        if (!loadingMore && hasMore && !loading) {
            const current = postsRef.current;
            const before = current.length > 0 ? Math.floor(current[current.length - 1].createdAtMs / 1000) : undefined;
            load('more', before);
        }
    };

    // View receipts: FlashList's viewability -> signed kind-2 receipts (see viewTracker.ts)
    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<{ key: string }> }) => {
        trackViewability({ viewableItems });
    }, []);
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 });

    const emptyMessage = activeFeed === 'world' ? t('timeline.emptyWorld') : t('timeline.emptyAround');

    const renderFooter = () => {
        if (!loadingMore) return null;
        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={colors.accentColor} />
            </View>
        );
    };

    const renderEmpty = () => {
        if (loading) return null;
        return (
            <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>{emptyMessage}</Text>
            </View>
        );
    };

    return (
        <View style={styles.container}>
            <View style={styles.feedPicker}>
                {feeds.map(feed => {
                    const isActive = activeFeed === feed.key;
                    return (
                        <Pressable
                            key={feed.key}
                            style={[styles.feedPill, isActive && styles.feedPillActive]}
                            onPress={() => onFeedChange(feed.key)}
                            accessibilityRole="tab"
                            accessibilityLabel={feed.label}
                            accessibilityState={{ selected: isActive }}
                            hitSlop={hitSlopFor(0, FEED_PILL_HEIGHT)}
                        >
                            <Ionicons
                                name={isActive ? feed.activeIcon : feed.icon}
                                size={14}
                                color={isActive ? colors.buttonTextColor : colors.textSecondary}
                            />
                            <Text style={[type.name, styles.feedPillText, isActive && styles.feedPillTextActive]} numberOfLines={1}>
                                {feed.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>

            {loading && posts.length === 0 ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.accentColor} />
                </View>
            ) : loadError && posts.length === 0 ? (
                <View style={styles.errorContainer}>
                    <Ionicons name="cloud-offline-outline" size={32} color={colors.textMuted} />
                    <Text style={[type.meta, styles.errorText]}>{t('timeline.loadFailed')}</Text>
                    <Pressable
                        style={styles.retryButton}
                        onPress={() => load('initial')}
                        accessibilityRole="button"
                        accessibilityLabel={t('timeline.retry')}
                    >
                        <Text style={[type.name, styles.retryText]}>{t('timeline.retry')}</Text>
                    </Pressable>
                </View>
            ) : (
                <View style={styles.list}>
                    {pendingCount > 0 && (
                        <NewPostsPill
                            label={tn('timeline.newPosts', pendingCount)}
                            hint={t('timeline.newPostsHint')}
                            loading={refreshing}
                            onPress={showNewPosts}
                        />
                    )}
                    <FlashList
                        ref={listRef}
                        data={posts}
                        keyExtractor={item => item.eventId}
                        renderItem={({ item }) => <PostCard post={item} onPress={onPostPress} />}
                        onEndReached={handleLoadMore}
                        onEndReachedThreshold={0.5}
                        onScroll={event => {
                            atTop.current = event.nativeEvent.contentOffset.y < 10;
                        }}
                        scrollEventThrottle={200}
                        onViewableItemsChanged={onViewableItemsChanged}
                        viewabilityConfig={viewabilityConfig.current}
                        refreshControl={
                            <RefreshControl
                                refreshing={refreshing}
                                onRefresh={() => load('refresh')}
                                tintColor={colors.accentColor}
                                colors={[colors.accentColor]}
                                progressBackgroundColor={colors.cardBackground}
                            />
                        }
                        ListFooterComponent={renderFooter}
                        ListEmptyComponent={renderEmpty}
                        contentContainerStyle={styles.listContent}
                        showsVerticalScrollIndicator={false}
                    />
                </View>
            )}
        </View>
    );
};

export default Timeline;
