import React, { useCallback } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton } from '../../components/ui';
import { space } from '../../src/theme/shape';
import type { PostCardModel } from '../../services/airplane/types';
import { PostCard } from '../../components/PostCard';
import { useTheme } from '../../src/theme/themeContext';
import { useI18n } from '../../src/i18n/i18nContext';

interface ThreadProps {
    postId: string;
    // v1 has no replies in the protocol and the store has no thread query,
    // so there is no thread data source beyond the tapped post itself. The
    // screen renders whatever posts it is given and highlights `postId`;
    // the post-detail route hands it the single post resolved by id.
    posts: PostCardModel[];
    loading?: boolean;
    refreshing?: boolean;
    onRefresh?: () => void;
    onBack: () => void;
    onPostPress?: (eventId: string) => void;
}

export default function Thread({ postId, posts, loading = false, refreshing = false, onRefresh, onBack, onPostPress }: ThreadProps) {
    const { colors, type } = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useI18n();

    const mainPost = posts.find(post => post.eventId === postId);

    const handleRefresh = useCallback(() => {
        onRefresh?.();
    }, [onRefresh]);

    const renderEmpty = () => {
        if (loading) return null;
        return (
            <View style={styles.notFoundContainer}>
                <Text style={[type.meta, styles.notFoundText]}>{t('thread.notFound')}</Text>
            </View>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: colors.background }]}>
            <View
                testID="thread-header"
                style={[
                    styles.header,
                    {
                        paddingTop: insets.top + 10,
                        borderBottomColor: colors.borderColor,
                        backgroundColor: colors.cardBackground,
                    },
                ]}
            >
                <IconButton icon="arrow-back" accessibilityLabel={t('common.goBack')} onPress={onBack} />

                <View style={styles.headerTitle} accessible accessibilityRole="header">
                    <Text style={[type.name, { color: colors.textPrimary }]} numberOfLines={1}>
                        {mainPost ? t('thread.titleBy', { name: mainPost.authorLabel }) : t('thread.title')}
                    </Text>
                </View>

                <View style={styles.headerSpacer} />
            </View>

            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.accentColor} />
                </View>
            ) : (
                <FlashList
                    data={posts}
                    keyExtractor={item => item.eventId}
                    // The post-detail route shows no tab dock, so the bottom
                    // clearance is just the safe-area inset plus a gap.
                    contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + space.lg }]}
                    ListEmptyComponent={renderEmpty}
                    renderItem={({ item }) => {
                        const isMain = item.eventId === postId;
                        return (
                            <View
                                style={[
                                    styles.postContainer,
                                    { borderBottomColor: colors.borderColor },
                                    isMain && {
                                        backgroundColor: colors.cardBackground,
                                        borderLeftColor: colors.accentSoft,
                                        borderLeftWidth: StyleSheet.hairlineWidth,
                                    },
                                ]}
                            >
                                <PostCard post={item} onPress={onPostPress} />
                            </View>
                        );
                    }}
                    refreshControl={
                        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accentColor} />
                    }
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: space.sm,
        paddingHorizontal: space.lg,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    headerTitle: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: space.sm,
    },
    headerSpacer: {
        width: 44,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    listContent: {
        // Bottom padding is applied by the component (it depends on the
        // live safe-area inset) - see contentContainerStyle above.
    },
    notFoundContainer: {
        paddingVertical: 80,
        paddingHorizontal: space.xl,
        alignItems: 'center',
    },
    notFoundText: {
        textAlign: 'center',
    },
    postContainer: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});
