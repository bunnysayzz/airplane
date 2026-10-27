// Compact count formatting for hero stats: 999 -> "999", 1_200 -> "1.2k",
// 3_400_000 -> "3.4M". Pure function, no React Native imports (unit-tested).
export function formatCompact(value: number): string {
    const sign = value < 0 ? '-' : '';
    const abs = Math.abs(value);
    const trim = (n: number) => {
        const rounded = (Math.round(n * 10) / 10).toString();
        return rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded;
    };
    if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000)}B`;
    if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
    if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
    return `${value}`;
}
