import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { TopBar } from '../../components/TopBar/topBar';
import Timeline, { type FeedKey } from '../../screens/Timeline/timeline';
import { useFeedTabs } from './_feeds';
import { useTheme } from '../../src/theme/themeContext';

export default function WorldTab() {
    const router = useRouter();
    const { colors } = useTheme();
    const feeds = useFeedTabs();

    // The feed pills live at the route level: tapping "Around you" jumps back to the mesh tab.
    // 'world' shows the honest empty state until the Nostr-relay update lands - no fake data.
    const [activeFeed, setActiveFeed] = useState<FeedKey>('world');
    const handleFeedChange = (key: FeedKey) => {
        setActiveFeed(key);
        if (key !== 'world') router.navigate('/(tabs)/around');
    };

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            <TopBar onSettingsPress={() => router.navigate('/(tabs)/settings')} />
            <Timeline
                feeds={feeds}
                activeFeed={activeFeed}
                onFeedChange={handleFeedChange}
                // The world feed has no local query yet: relays arrive in the relay update.
                cells={[]}
                onPostPress={eventId => router.push(`/post/${eventId}`)}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
});
