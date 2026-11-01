// SPDX-License-Identifier: Apache-2.0
// Pure route-transition tracker for UI navigation logging. The React
// binding lives in components/RouteTracker/routeTracker.tsx; this
// module holds no React Native imports so the logic runs in the node
// test harness. The stack holds raw route paths in memory only; only
// static screen names ever reach the log, so dynamic ids (post ids,
// peer pubkeys) can never appear in the file. Only the focused route
// screen reports, and the same-path guard makes a double report of
// one transition a no-op.

let stack: string[] = [];

export function resetRouteTrackerForTests(): void {
    stack = [];
}

export function getRouteTrackerStackForTests(): string[] {
    return [...stack];
}

export function staticScreenName(path: string): string {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return 'index';
    const first = segments[0];
    if (first === '(tabs)') return segments[1] ?? 'tabs';
    if (first === 'post') return 'post';
    if (first === 'dm') return 'dm';
    return first;
}

function isLaunchPath(path: string): boolean {
    return path === '/' || path === '';
}

export function observeRoutePath(path: string): { direction: 'forward' | 'back'; screen: string } | null {
    if (stack.length === 0) {
        stack.push(path);
        return null;
    }
    const prev = stack[stack.length - 1];
    if (prev === path) return null;
    if (stack.length >= 2 && stack[stack.length - 2] === path) {
        stack.pop();
        return { direction: 'back', screen: staticScreenName(path) };
    }
    // Launch redirect (index to first tab) is system navigation, not a
    // user tap: replace the stack top with no line.
    if (isLaunchPath(prev)) {
        stack[stack.length - 1] = path;
        return null;
    }
    stack.push(path);
    if (stack.length > 50) stack.splice(0, stack.length - 50);
    return { direction: 'forward', screen: staticScreenName(path) };
}
