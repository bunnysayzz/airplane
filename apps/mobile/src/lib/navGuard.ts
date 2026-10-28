// SPDX-License-Identifier: Apache-2.0
// Navigation guards for post routes: rapid or repeated taps must open a
// post once, never stack the same thread screen twice.

/** True when this push repeats the previous push of the same id within windowMs. */
export function isDoublePush(
    last: { eventId: string; atMs: number } | null,
    eventId: string,
    nowMs: number,
    windowMs = 1000,
): boolean {
    if (last === null) return false;
    return last.eventId === eventId && nowMs - last.atMs < windowMs;
}

/**
 * True when an inner action fired within windowMs of now: a card press
 * that close after an inner action is treated as that action, not a
 * navigation. The initial 0 timestamp never matches (nowMs is epoch ms).
 */
export function isWithinWindow(lastAtMs: number, nowMs: number, windowMs: number): boolean {
    return nowMs - lastAtMs < windowMs;
}
