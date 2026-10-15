import React from 'react';
import { Text, View } from 'react-native';
import { Stack } from 'expo-router';

export default function RootLayout() {
    return (
        <Stack>
            <Stack.Screen name="index" />
        </Stack>
    );
}
