import React, { useContext } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { TopBar } from '../../components/TopBar/topBar';
import Timeline from '../../screens/Timeline/timeline';
import { ComposeOpenContext } from '../../components/ComposeModal/composeContext';
import { BlePrime } from '../../components/BlePrime/blePrime';
import { useTheme } from '../../src/theme/themeContext';

export default function FeedTab() {
    const router = useRouter();
    const { colors } = useTheme();
    const openCompose = useContext(ComposeOpenContext);

    return (
        <View style={[styles.root, { backgroundColor: colors.background }]}>
            {/* One-time BLE permission priming (renders nothing itself) */}
            <BlePrime />
            <TopBar onSettingsPress={() => router.navigate('/(tabs)/settings')} />
            <Timeline
                // TODO: the viewer's geohash-5 cell (LOC-1) - no location provider in the app yet.
                cells={[]}
                onPostPress={eventId => router.push(`/post/${eventId}`)}
                onComposePress={openCompose}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
});
