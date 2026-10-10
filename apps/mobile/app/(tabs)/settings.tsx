import React from 'react';
import { useRouter } from 'expo-router';
import Settings from '../../screens/Settings/settings';

export default function SettingsTab() {
    const router = useRouter();
    // Settings draws its own header with a back button; in the tab bar it returns to Around.
    return <Settings onBack={() => router.navigate('/(tabs)/around')} />;
}
