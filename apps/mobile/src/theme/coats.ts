export interface ThemeColors {
    background: string;
    cardBackground: string;
    borderColor: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    accentColor: string;
    // Accent as text: links, active labels, "near the limit"
    accentText: string;
    // Accent as a soft fill: chips, content warnings, selected rows
    accentSoft: string;
    tabBarBackground: string;
    tabBarActiveColor: string;
    tabBarInactiveColor: string;
    inputBackground: string;
    // Ink on an accent fill (dark for every coat but black pug in light mode)
    buttonTextColor: string;
    dangerColor: string;
    // Ink in light mode; black in dark mode, where a light shadow would glow
    shadowColor: string;
    // Dims the screen behind modals and menus
    scrim: string;
    // Sunken at 78%, over sensitive media until it's shown
    veil: string;
    // Surface at 85%, for chips drawn over shown media
    veilStrong: string;
}

export type CoatKey = 'apricot' | 'fawn' | 'brindle' | 'black' | 'silver' | 'sage' | 'blueberry' | 'plum' | 'rose';

export interface Coat {
    key: CoatKey;
    name: string;
    // Hue the neutrals are generated from
    hue: number;
    // How strongly the hue tints the neutrals (0..1)
    neutralTint: number;
    light: { accent: string; accentText: string; onAccent: string };
    dark: { accent: string; accentText: string; onAccent: string };
}

export const COATS: readonly Coat[] = [
    { key: 'apricot', name: 'Apricot', hue: 28, neutralTint: 1,
        light: { accent: '#E8995A', accentText: '#A4521A', onAccent: '#2A1D15' },
        dark: { accent: '#F0A868', accentText: '#F4B27A', onAccent: '#1E140D' } },
    { key: 'fawn', name: 'Fawn', hue: 40, neutralTint: 0.9,
        light: { accent: '#E2B45C', accentText: '#86610F', onAccent: '#2A1F0E' },
        dark: { accent: '#E8BE6A', accentText: '#EDC77A', onAccent: '#1F170A' } },
    { key: 'brindle', name: 'Brindle', hue: 20, neutralTint: 0.6,
        light: { accent: '#B7825F', accentText: '#7E4A2E', onAccent: '#22160F' },
        dark: { accent: '#C9936F', accentText: '#DDA886', onAccent: '#1A110B' } },
    { key: 'black', name: 'Black pug', hue: 25, neutralTint: 0.15,
        light: { accent: '#2E2622', accentText: '#2E2622', onAccent: '#FFF8F1' },
        dark: { accent: '#E9DFD6', accentText: '#EFE6DD', onAccent: '#1A1512' } },
    { key: 'silver', name: 'Silver', hue: 210, neutralTint: 0.25,
        light: { accent: '#A9B4BC', accentText: '#4A5863', onAccent: '#1A2025' },
        dark: { accent: '#B5C0C8', accentText: '#C3CED6', onAccent: '#12171B' } },
    { key: 'sage', name: 'Sage', hue: 100, neutralTint: 0.5,
        light: { accent: '#9DBE8C', accentText: '#4A6B3C', onAccent: '#18230F' },
        dark: { accent: '#A9C99A', accentText: '#B6D4A7', onAccent: '#131B0C' } },
    { key: 'blueberry', name: 'Blueberry', hue: 225, neutralTint: 0.5,
        light: { accent: '#8FA8E0', accentText: '#3F5BA0', onAccent: '#101830' },
        dark: { accent: '#9DB3E8', accentText: '#AFC2EE', onAccent: '#0E1428' } },
    { key: 'plum', name: 'Plum', hue: 300, neutralTint: 0.45,
        light: { accent: '#C799C9', accentText: '#7D4A80', onAccent: '#24122A' },
        dark: { accent: '#D0A6D2', accentText: '#DDB6DF', onAccent: '#1D0F20' } },
    { key: 'rose', name: 'Rose', hue: 2, neutralTint: 0.55,
        light: { accent: '#EE9A98', accentText: '#A6423F', onAccent: '#2A1212' },
        dark: { accent: '#F2A6A4', accentText: '#F5B1AF', onAccent: '#220E0E' } },
];

export const DEFAULT_COAT: CoatKey = 'apricot';

// PugMark colours. The face is a gradient from a creamy top to the coat accent; ears, eye patches and muzzle are a
// warm brown that stays lighter than the dark ground so the ears don't vanish in dark mode
const FACE_HIGHLIGHT = '#FFEBB0';
const PUG_MASK = { light: ['#6E5650', '#4B3531'], dark: ['#8E6F65', '#6A4D45'] } as const;
const PUG_INK = '#2B1B18';
// A black pug's face is darker than the usual mask, so its mask is a lighter grey-brown
const BLACK_PUG = { faceHighlight: '#8C7F75', mask: ['#A39790', '#7E7169'], ink: '#1A1512' } as const;

export interface PugMarkColors {
    faceTop: string;
    faceBottom: string;
    maskTop: string;
    maskBottom: string;
    // Eyes and nose
    ink: string;
    // Forehead wrinkle, drawn on the face
    wrinkle: string;
}

export const pugMarkColors = (coatKey: string, dark: boolean): PugMarkColors => {
    const coat = getCoat(coatKey);
    const face = (dark ? coat.dark : coat.light).accent;
    // In dark mode the black pug's accent is a light cream, so it draws like any other coat
    if (coat.key === 'black' && !dark) {
        return {
            faceTop: mixHex(face, BLACK_PUG.faceHighlight, 0.25),
            faceBottom: face,
            maskTop: BLACK_PUG.mask[0],
            maskBottom: BLACK_PUG.mask[1],
            ink: BLACK_PUG.ink,
            wrinkle: BLACK_PUG.mask[0],
        };
    }
    const [maskTop, maskBottom] = PUG_MASK[dark ? 'dark' : 'light'];
    return { faceTop: mixHex(face, FACE_HIGHLIGHT, 0.62), faceBottom: face, maskTop, maskBottom, ink: PUG_INK, wrinkle: PUG_INK };
};

// Blend two #RRGGBB colours; t = 0 gives `from`, 1 gives `to`
export function mixHex(from: string, to: string, t: number): string {
    const channels = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const [a, b] = [channels(from), channels(to)];
    return '#' + a.map((value, i) => Math.round(value + (b[i] - value) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// With the tint switched off, neutrals keep a trace of the hue so they don't look cold
const UNTINTED_NEUTRAL_TINT = 0.12;

export const isCoatKey = (value: string): value is CoatKey => COATS.some(coat => coat.key === value);

export const getCoat = (key: string): Coat => COATS.find(coat => coat.key === key) ?? COATS[0];

// HSL (degrees, percent, percent) to #RRGGBB
export function hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const channel = (n: number) => {
        const k = (n + h / 30) % 12;
        const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(value * 255).toString(16).padStart(2, '0');
    };
    return ('#' + channel(0) + channel(8) + channel(4)).toUpperCase();
}

export function buildColors(coatKey: string, dark: boolean, tint: boolean): ThemeColors {
    const coat = getCoat(coatKey);
    const { hue } = coat;
    const neutralTint = tint ? coat.neutralTint : UNTINTED_NEUTRAL_TINT;
    const sat = (value: number) => value * neutralTint;
    const accent = dark ? coat.dark : coat.light;

    const neutrals = dark
        ? {
            ground: hslToHex(hue, sat(22), 7),
            surface: hslToHex(hue, sat(18), 10.5),
            sunken: hslToHex(hue, sat(16), 14.5),
            line: hslToHex(hue, sat(14), 20),
            ink: hslToHex(hue, sat(45), 94),
            ink2: hslToHex(hue, sat(18), 76),
            ink3: hslToHex(hue, sat(10), 62),
            accentSoft: hslToHex(hue, Math.max(8, 34 * coat.neutralTint), 19),
            danger: '#F08A74',
        }
        : {
            ground: hslToHex(hue, sat(60), 96),
            surface: hslToHex(hue, sat(70), 98.5),
            sunken: hslToHex(hue, sat(45), 92.5),
            line: hslToHex(hue, sat(38), 86),
            ink: hslToHex(hue, sat(30), 11),
            ink2: hslToHex(hue, sat(16), 32),
            ink3: hslToHex(hue, sat(12), 41),
            accentSoft: hslToHex(hue, Math.max(14, 72 * coat.neutralTint), 90),
            danger: '#B83A26',
        };

    return {
        background: neutrals.ground,
        cardBackground: neutrals.surface,
        inputBackground: neutrals.sunken,
        borderColor: neutrals.line,
        textPrimary: neutrals.ink,
        textSecondary: neutrals.ink2,
        textMuted: neutrals.ink3,
        accentColor: accent.accent,
        accentText: accent.accentText,
        accentSoft: neutrals.accentSoft,
        buttonTextColor: accent.onAccent,
        // Surface at 95% opacity
        // Faint coat tint over the dock's blur; any more and it hides the glass
        tabBarBackground: neutrals.surface + '59',
        tabBarActiveColor: accent.accentText,
        tabBarInactiveColor: neutrals.ink3,
        dangerColor: neutrals.danger,
        shadowColor: dark ? '#000000' : neutrals.ink,
        scrim: dark ? '#000000A6' : neutrals.ink + '66',
        veil: neutrals.sunken + 'C7',
        veilStrong: neutrals.surface + 'D9',
    };
}
