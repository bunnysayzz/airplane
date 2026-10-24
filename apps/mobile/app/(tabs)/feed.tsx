import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { TopBar } from '../../components/TopBar/topBar';
import Timeline from '../../screens/Timeline/timeline';
import { ComposeOpenContext } from '../../components/ComposeModal/composeContext';
import { BlePrime } from '../../components/BlePrime/blePrime';
import { useTheme } from '../../src/theme/themeContext';
import { resolveFeedCells } from '../../services/airplane/feedCells';
import { subscribeFeed } from '../../services/airplane/feed';

export default function FeedTab() {
    const router = useRouter();
    const { colors } = useTheme();
    const openCompose = useContext(ComposeOpenContext);

    // The viewer's in-scope cells (own geohash-5 cell + 8 neighbours),
    // resolved from the device location WITHOUT prompting: permission is
    // checked first, and a non-granted state keeps cells empty. While a
    // resolution is in flight (or it fails), the previous cells stay — the
    // feed never flashes empty mid-resolve.
    const [cells, setCells] = useState<string[]>([]);
    const cellsKeyRef = useRef('');

    const resolveCells = useCallback(async () => {
        const next = await resolveFeedCells();
        if (next === null) return; // keep previous cells on failure
        const key = [...next].sort().join(',');
        if (key !== cellsKeyRef.current) {
            cellsKeyRef.current = key;
            setCells(next);
        }
    }, []);

    // Re-resolve when returning to the tab: a user typically grants location
    // DURING posting (composer pre-prompt), so cells resolved before posting
    // are stale [] — without this the post would never appear in the feed.
    useFocusEffect(
        useCallback(() => {
            void resolveCells();
        }, [resolveCells]),
    );

    // Same refresh on feed-change notifications: the composer closes back
    // onto this tab (no focus change), so the notification path is what
    // picks up a freshly granted permission right after a post lands.
    useEffect(() => subscribeFeed(() => void resolveCells()), [resolveCells]);

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            {/* One-time BLE permission priming (renders nothing itself) */}
            <BlePrime />
            <TopBar onSettingsPress={() => router.navigate('/(tabs)/settings')} />
            <Timeline
                cells={cells}
                onPostPress={eventId => router.push(`/post/${eventId}`)}
                onComposePress={openCompose}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
});
