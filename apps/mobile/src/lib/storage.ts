// Stripped settings storage (lifted from pugdon, auth/account halves removed).
// Preferences aren't secret, so they live in AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function saveSetting(key: string, value: boolean) {
    await AsyncStorage.setItem(key, value ? 'true' : 'false');
}

export async function getSetting(key: string, defaultValue: boolean): Promise<boolean> {
    const val = await AsyncStorage.getItem(key);
    return val !== null ? val === 'true' : defaultValue;
}

export async function saveStringSetting(key: string, value: string) {
    await AsyncStorage.setItem(key, value);
}

export async function getStringSetting(key: string, defaultValue: string): Promise<string> {
    const val = await AsyncStorage.getItem(key);
    return val !== null ? val : defaultValue;
}

export async function removeSetting(key: string) {
    await AsyncStorage.removeItem(key);
}
