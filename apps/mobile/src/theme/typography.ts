import { TextStyle } from 'react-native';
// Per-weight entry points, so only the weights below end up in the bundle
import { Fraunces_700Bold } from '@expo-google-fonts/fraunces/700Bold';
import { Nunito_400Regular } from '@expo-google-fonts/nunito/400Regular';
import { Nunito_600SemiBold } from '@expo-google-fonts/nunito/600SemiBold';
import { Nunito_700Bold } from '@expo-google-fonts/nunito/700Bold';
import { Nunito_800ExtraBold } from '@expo-google-fonts/nunito/800ExtraBold';

// One family per weight: Android ignores fontWeight for custom fonts
export const fontFamilies = {
    display: 'Fraunces_700Bold',
    regular: 'Nunito_400Regular',
    semiBold: 'Nunito_600SemiBold',
    bold: 'Nunito_700Bold',
    extraBold: 'Nunito_800ExtraBold',
} as const;

export const fontAssets = {
    [fontFamilies.display]: Fraunces_700Bold,
    [fontFamilies.regular]: Nunito_400Regular,
    [fontFamilies.semiBold]: Nunito_600SemiBold,
    [fontFamilies.bold]: Nunito_700Bold,
    [fontFamilies.extraBold]: Nunito_800ExtraBold,
};

type Weight = NonNullable<TextStyle['fontWeight']>;

// Brand family when the fonts loaded, otherwise the system font at the same weight
const face = (family: string, weight: Weight, loaded: boolean): TextStyle =>
    loaded ? { fontFamily: family } : { fontWeight: weight };

export function buildType(loaded: boolean) {
    return {
        // Wordmark and screen titles
        title: { ...face(fontFamilies.display, '700', loaded), fontSize: 30, lineHeight: 36 },
        sheetTitle: { ...face(fontFamilies.display, '700', loaded), fontSize: 19, lineHeight: 24 },
        name: { ...face(fontFamilies.extraBold, '800', loaded), fontSize: 15, lineHeight: 20 },
        body: { ...face(fontFamilies.regular, '400', loaded), fontSize: 15.5, lineHeight: 22.5 },
        // 0.08em tracking
        label: { ...face(fontFamilies.extraBold, '800', loaded), fontSize: 12, letterSpacing: 0.96, textTransform: 'uppercase' },
        meta: { ...face(fontFamilies.semiBold, '600', loaded), fontSize: 12.5, lineHeight: 17 },
    } satisfies Record<string, TextStyle>;
}

export type TypeScale = ReturnType<typeof buildType>;
