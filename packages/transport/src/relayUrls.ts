// SPDX-License-Identifier: Apache-2.0
// Relay URL validation, shared by the package clients (NostrTransport,
// WsDmRelay) so every caller inherits it, not just the app settings layer.
//
// Rules: scheme must be wss, no embedded credentials, host must be a
// sane domain or IP literal, port must be sane (1-65535, default 443),
// and private targets are dropped unless explicitly allowed. Output is
// canonical (lowercase host, default port dropped, trailing slash
// stripped) so case and port variants of one relay dedupe.

export interface RelayUrlOpts {
  /** Allow private-network targets (an explicitly user-added relay). */
  allowPrivateRelays?: boolean;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  // A single label that is not localhost is not a public relay host.
  if (!host.includes('.')) return true;
  return false;
}

function validDomainOrIp(host: string): boolean {
  if (host.startsWith('[') || host.includes(':')) {
    // IPv6 literal (URL parser strips the brackets from hostname).
    return host.length > 0 && !/\s/.test(host) && !host.includes('_');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return host.split('.').every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255 && p === String(n);
    });
  }
  if (host.length > 253 || host.includes('_')) return false;
  return host.split('.').every((label) => {
    return label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label);
  });
}

/**
 * Normalize one relay URL, or null when it is not a usable relay address.
 * Returns the canonical form for dedupe.
 */
export function normalizeRelayUrl(input: string, opts: RelayUrlOpts = {}): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:') return null;
  if (url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  if (!host || !validDomainOrIp(host)) return null;
  if (!opts.allowPrivateRelays && isPrivateHost(host)) return null;
  // Port sanity: the URL parser silently drops an out-of-range port, so
  // validate the port as written in the input, not the parsed value.
  const authority = trimmed.slice('wss://'.length).split('/')[0];
  const hostport = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  let portText = '';
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close === -1) return null;
    const rest = hostport.slice(close + 1);
    if (rest.startsWith(':')) portText = rest.slice(1);
    else if (rest !== '') return null;
  } else if (hostport.includes(':')) {
    portText = hostport.slice(hostport.lastIndexOf(':') + 1);
  }
  let portSuffix = '';
  if (portText !== '') {
    if (!/^\d+$/.test(portText)) return null;
    const port = Number(portText);
    if (port < 1 || port > 65535) return null;
    if (port !== 443) portSuffix = `:${port}`;
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `wss://${host}${portSuffix}${path}`;
}

/** Dedupe (preserving first-seen order) and drop invalid entries. */
export function sanitizeRelayList(urls: readonly string[], opts: RelayUrlOpts = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw, opts);
    if (url !== null && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
