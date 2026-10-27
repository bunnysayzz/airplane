import Constants from 'expo-constants';

// Simplified from pugdon's appVersion: no OTA channel here, just the app version.
export const appVersionLabel = () => Constants.expoConfig?.version ?? 'unknown';
