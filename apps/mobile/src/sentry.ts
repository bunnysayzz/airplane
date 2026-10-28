// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal pure-JS Sentry client (no @sentry/react-native, on purpose).
 *
 * WHY NOT THE OFFICIAL SDK: @sentry/react-native ships Android native code
 * (libsentry.so via sentry-native). This repo's release pipeline hard-fails
 * on ANY Sentry native library (build-apk-no-eas.yml payload gate), and the
 * native-module guard (scripts/check-native-modules.js) requires every
 * startup-reachable native package to be autolinked — so the official SDK
 * cannot ship in a green release build at all. This client sends the same
 * Sentry envelope format over plain fetch instead: events land in the same
 * Sentry project dashboard, with zero native code and zero new dependency.
 *
 * SCOPE: publish failures, feed-cell resolution failures, and
 * keystore/connectivity breadcrumbs. initSentry() runs at app startup
 * (imported from apps/mobile/index.js, after fatalShim). captureError()
 * is called from the compose modal's publish catch and from feed-cell
 * resolution (feedCells), and breadcrumbs are added for keystore
 * fallback (identity) and connectivity changes (transport). No global
 * error handler is installed (fatalShim owns that).
 *
 * PRIVACY: an event carries ONLY the error name/message/stack, the publish
 * stage tag, and breadcrumbs. Post text, location, pubkeys, and secrets are
 * never passed to this module and never appear in a payload. As a second
 * layer, captureError scrubs runs of 32 or more hex chars and
 * latitude/longitude-like number pairs from the message, and drops any
 * breadcrumb data value failing the same check, so a future call site
 * that embeds such data cannot leak it through this egress point.
 *
 * SAFETY: every public function is wrapped so it can never throw — a
 * logging failure must never break launch or posting. When the DSN env var
 * is absent (local dev, tests), the client stays disabled silently.
 */

export interface SentryDsnParts {
  protocol: 'http' | 'https';
  publicKey: string;
  host: string;
  /** Path prefix between host and project id (empty for sentry.io). */
  pathPrefix: string;
  projectId: string;
}

export interface SentryBreadcrumb {
  timestamp: number;
  message: string;
  data?: Record<string, string>;
}

const MAX_BREADCRUMBS = 20;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_FRAMES = 50;

/**
 * Egress scrubbing (P2-5): a run of 32 or more hex chars is long enough
 * to be a pubkey fragment, an id, or a key, and a pair of long decimals
 * separated by a comma looks like latitude/longitude. Neither belongs
 * in a telemetry event, whatever the call site embedded.
 */
function containsSensitiveValue(value: string): boolean {
  return (
    /[0-9a-fA-F]{32,}/.test(value) ||
    /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/.test(value)
  );
}

function scrubMessage(message: string): string {
  return message
    .replace(/[0-9a-fA-F]{32,}/g, '[redacted]')
    .replace(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, '[redacted]');
}

/** Parse a Sentry DSN. Returns null for anything malformed. */
export function parseDsn(dsn: string): SentryDsnParts | null {
  try {
    const match = /^(https?):\/\/([^@/]+)@([^/]+)\/(.+)$/.exec(dsn.trim());
    if (!match) return null;
    const [, protocol, publicKey, host, rest] = match;
    const segments = rest.split('/').filter((s) => s.length > 0);
    const projectId = segments[segments.length - 1];
    if (!projectId || !/^\d+$/.test(projectId)) return null;
    return {
      protocol: protocol === 'http' ? 'http' : 'https',
      publicKey,
      host,
      pathPrefix: segments.slice(0, -1).join('/'),
      projectId,
    };
  } catch {
    return null;
  }
}

function envelopeUrl(parts: SentryDsnParts): string {
  const prefix = parts.pathPrefix ? `/${parts.pathPrefix}` : '';
  return (
    `${parts.protocol}://${parts.host}${prefix}/api/${parts.projectId}/envelope/` +
    `?sentry_key=${encodeURIComponent(parts.publicKey)}&sentry_version=7`
  );
}

function randomEventId(): string {
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

interface StackFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

/** Best-effort V8/Hermes stack parse. Sentry wants frames oldest-first. */
function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lineRe = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
  for (const line of stack.split('\n')) {
    if (frames.length >= MAX_FRAMES) break;
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, fn, file, lineNo, colNo] = m;
    frames.push({
      function: fn,
      filename: file,
      lineno: Number(lineNo),
      colno: Number(colNo),
    });
  }
  return frames.reverse();
}

let enabled = false;
let dsnParts: SentryDsnParts | null = null;
let breadcrumbs: SentryBreadcrumb[] = [];
/** Last DSN string init saw, so re-init with the same DSN keeps crumbs. */
let lastDsnSeen: string | undefined = undefined;
let haveLastDsn = false;
/**
 * Disabled-state note (P2-6): when init ends disabled, one log line is
 * owed to the diagnostics log. The log sink is not attached yet at
 * import time, so init only arms the note; the log starter consumes
 * it once per launch. An enabled init re-arms, so a later disable in
 * the same launch can note again.
 */
let disabledNotePending = false;
let disabledNoteConsumed = false;

/**
 * Initialize the client. The DSN comes from EXPO_PUBLIC_SENTRY_DSN (inlined
 * into the JS bundle at build time; CI injects it from eas.json). Passing an
 * explicit DSN overrides the env var (tests). Never throws.
 */
export function initSentry(dsn?: string): void {
  try {
    const raw =
      dsn ?? (typeof process !== 'undefined' ? process.env['EXPO_PUBLIC_SENTRY_DSN'] : undefined);
    // Only clear breadcrumbs when the DSN actually changes: a re-init
    // with the same DSN (for example after a settings change) must not
    // silently drop the breadcrumbs collected for the next event.
    if (!haveLastDsn || raw !== lastDsnSeen) {
      breadcrumbs = [];
      haveLastDsn = true;
      lastDsnSeen = raw;
    }
    dsnParts = raw ? parseDsn(raw) : null;
    enabled = dsnParts !== null;
    if (enabled) {
      disabledNotePending = false;
      disabledNoteConsumed = false;
    } else if (!disabledNoteConsumed) {
      disabledNotePending = true;
    }
  } catch {
    enabled = false;
    dsnParts = null;
    if (!disabledNoteConsumed) disabledNotePending = true;
  }
}

/** True when the client has a valid DSN and will send events. */
export function isSentryEnabled(): boolean {
  return enabled;
}

/**
 * Consume the owed disabled note, if any. Returns true exactly once
 * per disabled stretch; the caller records the diagnostics log line.
 */
export function takeSentryDisabledNote(): boolean {
  if (!disabledNotePending) return false;
  disabledNotePending = false;
  disabledNoteConsumed = true;
  return true;
}

/** Record a breadcrumb for the next captured event. Never throws. */
export function addBreadcrumb(message: string, data?: Record<string, string>): void {
  try {
    breadcrumbs.push({
      timestamp: Math.floor(Date.now() / 1000),
      message,
      data,
    });
    while (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
  } catch {
    // Logging must never break the caller.
  }
}

/**
 * Send an error event to Sentry. Carries only the error name/message/stack,
 * the publish stage (when the error is a staged PublishError), and
 * breadcrumbs. Never throws, never awaits — fire and forget.
 */
export function captureError(error: unknown): void {
  try {
    if (!enabled || !dsnParts) return;
    const g = globalThis as { fetch?: unknown };
    if (typeof g.fetch !== 'function') return;

    const name = error instanceof Error ? error.name : 'UnknownError';
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = scrubMessage(rawMessage).slice(0, MAX_MESSAGE_LENGTH);
    const stack = error instanceof Error ? error.stack : undefined;
    const stage = (error as { stage?: unknown } | null)?.stage ?? undefined;
    const eventId = randomEventId();
    const abortSignalCtor = (
      globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }
    ).AbortSignal;
    const timeoutSignal =
      abortSignalCtor?.timeout !== undefined ? abortSignalCtor.timeout(10_000) : undefined;
    const scrubbedBreadcrumbs: SentryBreadcrumb[] = breadcrumbs.map((crumb) => {
      const scrubbed: SentryBreadcrumb = {
        timestamp: crumb.timestamp,
        message: scrubMessage(crumb.message),
      };
      if (crumb.data) {
        const data: Record<string, string> = {};
        for (const [key, value] of Object.entries(crumb.data)) {
          if (!containsSensitiveValue(value)) data[key] = value;
        }
        scrubbed.data = data;
      }
      return scrubbed;
    });

    const event: Record<string, unknown> = {
      event_id: eventId,
      timestamp: Math.floor(Date.now() / 1000),
      level: 'error',
      platform: 'javascript',
      sdk: { name: 'airplane.sentry-js', version: '1.0.0' },
      exception: {
        values: [
          {
            type: name,
            value: message,
            ...(stack ? { stacktrace: { frames: parseStack(stack) } } : {}),
          },
        ],
      },
      tags: typeof stage === 'string' && stage.length > 0 ? { publish_stage: stage } : {},
      breadcrumbs: { values: scrubbedBreadcrumbs },
    };

    const envelope =
      JSON.stringify({
        event_id: eventId,
        sent_at: new Date().toISOString(),
        sdk: { name: 'airplane.sentry-js', version: '1.0.0' },
      }) +
      '\n' +
      JSON.stringify({ type: 'event', content_type: 'application/json' }) +
      '\n' +
      JSON.stringify(event);

    const result = (g.fetch as (url: string, init: Record<string, unknown>) => Promise<unknown>)(
      envelopeUrl(dsnParts),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: envelope,
        // A hung request must not linger: abort after about 10 seconds.
        // No retry: retrying error telemetry risks duplicate events.
        ...(timeoutSignal !== undefined ? { signal: timeoutSignal } : {}),
      },
    );
    if (result && typeof (result as { catch?: unknown }).catch === 'function') {
      (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // A logging failure must never surface to the caller.
  }
}

/** Test seam: inspect the breadcrumb buffer. */
export function __getBreadcrumbsForTests(): readonly SentryBreadcrumb[] {
  return breadcrumbs;
}

// Self-init at import: index.js imports this module at startup. Guarded
// inside initSentry; a missing DSN simply leaves the client disabled.
initSentry();
