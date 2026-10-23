import React from 'react';
import { useRouter } from 'expo-router';
import Settings from '../../screens/Settings/settings';

export default function SettingsTab() {
    const router = useRouter();
    // Settings draws its own header with a back button; back goes wherever the
    // user came from, falling back to the feed tab for deep links.
    const goBack = () => {
        if (router.canGoBack()) router.back();
        else router.navigate('/(tabs)/feed');
    };
    return <Settings onBack={goBack} />;
}
