import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { TopBar } from '../../components/TopBar/topBar';
import Timeline, { type FeedKey } from '../../screens/Timeline/timeline';
import { useFeedTabs } from './_feeds';
import { useTheme } from '../../src/theme/themeContext';

export default function AroundTab() {
    const router = useRouter();
    const { colors } = useTheme();
    const feeds = useFeedTabs();

    // The feed pills live at the route level: tapping "World" jumps to the world tab.
    const [activeFeed, setActiveFeed] = useState<FeedKey>('around');
    const handleFeedChange = (key: FeedKey) => {
        setActiveFeed(key);
        if (key !== 'around') router.navigate('/(tabs)/world');
    };

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            <TopBar onSettingsPress={() => router.navigate('/(tabs)/settings')} />
            <Timeline
                feeds={feeds}
                activeFeed={activeFeed}
                onFeedChange={handleFeedChange}
                // TODO(P2): the viewer's geohash-5 cell (LOC-1) — no location provider in the app yet.
                cells={[]}
                onPostPress={eventId => router.push(`/post/${eventId}`)}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
});
