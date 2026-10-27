// Controls drawn over photos and video stay light-on-dark whatever the coat or mode,
// because the media underneath can be any color
export const mediaColors = {
    backdrop: '#000000',
    scrim: 'rgba(0, 0, 0, 0.5)',
    scrimLight: 'rgba(0, 0, 0, 0.3)',
    scrimStrong: 'rgba(0, 0, 0, 0.85)',
    ink: '#FFFFFF',
} as const;
