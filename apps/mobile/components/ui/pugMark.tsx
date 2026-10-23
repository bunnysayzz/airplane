import React, { useId } from 'react';
import Svg, { ClipPath, Defs, Ellipse, G, Line, LinearGradient, Path, Polygon, Rect, Stop } from 'react-native-svg';
import { useTheme } from '../../src/theme/themeContext';
import { CoatKey, pugMarkColors } from '../../src/theme/coats';

interface PugMarkProps {
    coat: CoatKey;
    size?: number;
}

// Logo sizing tokens: every PugMark in the app uses one of these, never a magic
// number, so the mark's rendered size is consistent per context.
export const logoSizes = {
    row: 22, // trailing mark in settings rows
    wordmark: 28, // top-bar wordmark next to the "airplane" text
    coat: 36, // appearance coat-picker cell (also the component default)
    hero: 88, // setup boot screen
} as const;

// Below this size the forehead wrinkle turns into noise, so it's left out
const WRINKLE_MIN_SIZE = 28;

// Shapes in 64-unit coordinates; the viewBox crops to the pug (x 7-57, y 17-48). Ears, nose and muzzle are
// polygons with a thick round-joined stroke of the same fill, which rounds their corners.
const LEFT_EAR = '10.2,25 15.2,21.2 16.2,23 13.8,30 10.8,29.6';
const RIGHT_EAR = '53.8,25 48.8,21.2 47.8,23 50.2,30 53.2,29.6';
const MUZZLE = '32,38 28.6,38.3 26,40.8 25.9,43 32,44.6 38.1,43 38,40.8 35.4,38.3';
const NOSE = '29.6,33.4 34.4,33.4 32,36.2';
const FACE = 'M 21 16.5 H 43 Q 51.5 16.5 51.5 25 V 40.5 Q 51.5 44 46 45.3 Q 32 48 18 45.3 Q 12.5 44 12.5 40.5 V 25 Q 12.5 16.5 21 16.5 Z';
const WRINKLE = 'M 26.2 24.6 q 1.45 -2 2.9 0 t 2.9 0 t 2.9 0 t 2.9 0';

// Pugdom's pug, in a coat's colours. Drawn after the author's pug, who is missing their left eye (on our right).
//
// Bounded-render contract: the mark always renders as an exact `size` x `size`
// square (explicit width/height on the Svg plus a fixed viewBox), so it can never
// overflow its parent - no unbounded dimensions, no missing resize behaviour.
// Every shape, including stroke widths, fits inside the viewBox.
export const PugMark: React.FC<PugMarkProps> = ({ coat, size = logoSizes.coat }) => {
    const { isDark } = useTheme();
    const colors = pugMarkColors(coat, isDark);
    // Gradient ids are document-wide, so each mark needs its own
    const id = `pug${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
    const face = `url(#${id}face)`;
    const mask = `url(#${id}mask)`;

    return (
        <Svg width={size} height={size} viewBox="6 6 52 52" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Defs>
                <LinearGradient id={`${id}face`} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0" stopColor={colors.faceTop} />
                    <Stop offset="1" stopColor={colors.faceBottom} />
                </LinearGradient>
                <LinearGradient id={`${id}mask`} x1="0" y1="0" x2="1" y2="1">
                    <Stop offset="0" stopColor={colors.maskTop} />
                    <Stop offset="1" stopColor={colors.maskBottom} />
                </LinearGradient>
                <ClipPath id={`${id}right`}>
                    <Rect x="32" y="30" width="14" height="20" />
                </ClipPath>
            </Defs>
            <Path d={FACE} fill={face} />
            <Polygon points={LEFT_EAR} fill={mask} stroke={mask} strokeWidth={6.5} strokeLinejoin="round" />
            <Polygon points={RIGHT_EAR} fill={mask} stroke={mask} strokeWidth={6.5} strokeLinejoin="round" />
            {size >= WRINKLE_MIN_SIZE && (
                <Path d={WRINKLE} fill="none" stroke={colors.wrinkle} strokeWidth={1.35} strokeLinecap="round" strokeLinejoin="round" />
            )}
            <Rect x="15.7" y="27.3" width="11.2" height="10.6" rx="5.3" fill={mask} />
            <Rect x="37.1" y="27.3" width="11.2" height="10.6" rx="5.3" fill={mask} />
            <Ellipse cx="21.3" cy="32.7" rx="2" ry="2.9" fill={colors.ink} />
            <Line x1="39.9" y1="32.8" x2="45.5" y2="32.8" stroke={colors.ink} strokeWidth={1.4} strokeLinecap="round" />
            <Polygon points={MUZZLE} fill={mask} stroke={mask} strokeWidth={5.2} strokeLinejoin="round" />
            {/* The muzzle's right half sits a little in shadow */}
            <G clipPath={`url(#${id}right)`} opacity={0.12}>
                <Polygon points={MUZZLE} fill={colors.ink} stroke={colors.ink} strokeWidth={5.2} strokeLinejoin="round" />
            </G>
            <Polygon points={NOSE} fill={colors.ink} stroke={colors.ink} strokeWidth={2.4} strokeLinejoin="round" />
        </Svg>
    );
};
