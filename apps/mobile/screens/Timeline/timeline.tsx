import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, Text, View } from 'react-native';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listFeedPosts, subscribeFeed } from '../../services/airplane/feed';
import { toggleReshare } from '../../services/airplane/reshares';
import { toggleStar } from '../../services/airplane/stars';
import { trackViewability } from '../../services/airplane/viewTracker';
import type { PostCardModel } from '../../services/airplane/types';
import { PostCard } from '../../components/PostCard';
import { PillButton } from '../../components/ui';
import { tabBarClearance } from '../../components/TabBar/styles';
import { useTheme } from '../../src/theme/themeContext';
import { makeStyles } from './styles';
import { useThemedStyles } from '../../src/theme/useThemedStyles';
import { useI18n } from '../../src/i18n/i18nContext';
import { NewPostsPill } from './newPostsPill';

// FlashList keeps the first visible post in place while posts above it get measured, which cut an
// animated scrollToOffset(0) short after scrolling far. scrollToIndex pauses that correction, jumps
// near the top and animates the rest; then settle on offset 0 (the list's top padding).
export const scrollListToTop = async (list: Pick<FlashListRef<PostCardModel>, 'scrollToIndex' | 'scrollToOffset'> | null) => {
    if (!list) return;
    await list.scrollToIndex({ index: 0, animated: true });
    list.scrollToOffset({ offset: 0, animated: true });
};

interface TimelineProps {
    // The viewer's in-scope cells (own geohash-5 cell + 8 neighbours),
    // resolved by the hosting tab without prompting. Empty = no scope yet
    // (location not granted), so the feed is empty until permission exists.
    cells: string[];
    onPostPress?: (eventId: string) => void;
    // Opens the compose sheet (wired by the tab that hosts the timeline).
    onComposePress?: () => void;
    // DM P1: open a DM with a post author.
    onMessage?: (authorPubkeyHex: string) => void;
}

const PAGE_LIMIT = 50;

// Single-feed timeline: no feed pills, just the unified hybrid feed
// (BLE mesh + Nostr relays, deduplicated).
const Timeline: React.FC<TimelineProps> = ({ cells, onPostPress, onComposePress, onMessage }) => {
    const { colors, type } = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { t, tn } = useI18n();
    const insets = useSafeAreaInsets();
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

    // Fresh query when the feed or its cells change. The first load shows the
    // full spinner (posts are empty); later scope changes keep the previous
    // posts on screen and reload in place with the pull-to-refresh indicator,
    // instead of blanking to a spinner on every cell boundary crossing.
    const firstLoadRef = useRef(true);
    useEffect(() => {
        setHasMore(true);
        if (firstLoadRef.current) {
            firstLoadRef.current = false;
            load('initial');
        } else {
            load('refresh');
        }
    }, [cellsKey, load]);

    // The store has no change events of its own: composer and viewTracker notify,
    // and the timeline re-queries. Arrivals while scrolled down pile up behind the pill.
    // Burst guard: transport ingress, view receipts, and reshares can fire several
    // notifications in one burst, and each one used to trigger a full re-query
    // (50 rows rebuilt as new objects, defeating the PostCard memo). Coalesce
    // to one trailing refresh: the timer re-checks atTop at fire time, so a
    // refresh scheduled at the top that outlives a scroll-down becomes a pill
    // count instead of a mid-scroll list replacement.
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        const unsub = subscribeFeed(() => {
            if (atTop.current) {
                if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = setTimeout(() => {
                    refreshTimerRef.current = null;
                    if (atTop.current) {
                        load('refresh');
                    } else {
                        setPendingCount(count => count + 1);
                    }
                }, 250);
            } else {
                setPendingCount(count => count + 1);
            }
        });
        return () => {
            unsub();
            if (refreshTimerRef.current !== null) {
                clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
        };
    }, [load]);

    const showNewPosts = useCallback(async () => {
        await load('refresh');
        scrollListToTop(listRef.current);
    }, [load]);

    // Pagination guard: the state flag only lands after re-render, so two
    // rapid onEndReached firings can both pass it and append the same page
    // twice (duplicate keys and rows). The ref is set synchronously, so the
    // second firing sees it immediately.
    const loadingMoreRef = useRef(false);
    const handleLoadMore = () => {
        if (loadingMoreRef.current || loadingMore || !hasMore || loading) return;
        loadingMoreRef.current = true;
        const current = postsRef.current;
        const before = current.length > 0 ? Math.floor(current[current.length - 1].createdAtMs / 1000) : undefined;
        void load('more', before).finally(() => {
            loadingMoreRef.current = false;
        });
    };

    // View receipts: FlashList's viewability -> signed kind-2 receipts (see viewTracker.ts)
    const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: Array<{ key: string }> }) => {
        trackViewability({ viewableItems });
    }, []);
    const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 });

    const emptyMessage = t('timeline.empty');

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
                <Ionicons name="chatbubble-ellipses-outline" size={40} color={colors.textMuted} />
                <Text style={styles.emptyText}>{emptyMessage}</Text>
                {onComposePress ? (
                    <PillButton label={t('tabs.newPost')} onPress={onComposePress} style={styles.emptyCta} />
                ) : null}
            </View>
        );
    };

    // STAR MVP (delimited): tapping a card's star toggles it; the toggle
    // notifies feed listeners, so the list reloads with the new count.
    const handleStar = useCallback((eventId: string) => {
        const post = postsRef.current.find(p => p.eventId === eventId);
        if (!post) return;
        void toggleStar(eventId, post.geohash).catch(() => {});
    }, []);

    // Memoized row renderer: without this, every Timeline state change
    // (pendingCount, refreshing) re-renders every card.
    const renderItem = useCallback(
        ({ item }: { item: PostCardModel }) => (
            <PostCard post={item} onPress={onPostPress} onStar={handleStar} onMessage={onMessage} onReshare={() => {
                // The service notifies feed listeners itself; the caller used
                // to notify a second time, doubling the refresh per tap.
                void toggleReshare(item);
            }} />
        ),
        [onPostPress, handleStar, onMessage]
    );

    return (
        <View style={styles.container}>
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
                        renderItem={renderItem}
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
                        contentContainerStyle={[
                            styles.listContent,
                            // Bottom clearance tracks the floating dock, which
                            // itself tracks the live safe-area inset.
                            { paddingBottom: tabBarClearance(insets.bottom) },
                        ]}
                        showsVerticalScrollIndicator={false}
                    />
                </View>
            )}
        </View>
    );
};

export default Timeline;
