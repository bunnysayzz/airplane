import React, { useCallback } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton } from '../../components/ui';
import { space } from '../../src/theme/shape';
import { TAB_BAR_CLEARANCE } from '../../components/TabBar/styles';
import type { PostCardModel } from '../../services/airplane/types';
// TODO(worker2): PostCard is built by another worker — this import resolves when it lands.
import { PostCard } from '../../components/PostCard';
import { useTheme } from '../../src/theme/themeContext';
import { useI18n } from '../../src/i18n/i18nContext';

interface ThreadProps {
    postId: string;
    // TODO(worker4): wire to services/airplane — the v1 protocol has no replies and the
    // store has no thread query, so there is no thread data source yet. The screen renders
    // whatever posts it is given and highlights `postId`; until then it shows the single post.
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
                    contentContainerStyle={styles.listContent}
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
        paddingBottom: TAB_BAR_CLEARANCE,
    },
    postContainer: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});
