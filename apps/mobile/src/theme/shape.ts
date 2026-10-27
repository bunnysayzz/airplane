export const radii = {
    input: 12,
    well: 16,
    card: 20,
    sheet: 28,
    pill: 999,
} as const;

export const space = {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
} as const;

// Smallest touch target (pt) on every platform
export const MIN_TOUCH = 44;

// Grows a control's hit area to MIN_TOUCH without changing its visual size
export const hitSlopFor = (width: number, height: number) => {
    const x = Math.max(0, (MIN_TOUCH - width) / 2);
    const y = Math.max(0, (MIN_TOUCH - height) / 2);
    return { top: y, bottom: y, left: x, right: x };
};
