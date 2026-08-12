import dns from 'node:dns/promises';
import net from 'node:net';
import config from './config.js';

/**
 * SSRF protection for the scanner.
 *
 * The scanner navigates to a URL supplied by an anonymous internet user. Without
 * these checks that is a server-side request forgery primitive pointed at our own
 * private network and at the cloud metadata endpoint. Every one of the following
 * is a real, exploited attack path, so each is closed explicitly:
 *
 *   http://169.254.169.254/latest/meta-data/   cloud instance credentials
 *   http://localhost:5432/                     internal service port scan
 *   http://[::1]/ and http://[::ffff:127.0.0.1]/   IPv6 spellings of loopback
 *   http://127.0.0.1.nip.io/                   public DNS name resolving to loopback
 *   file:///etc/passwd  and  gopher://         non-HTTP scheme abuse
 *   a public host that 302-redirects to any of the above
 *   a public host whose DNS TTL flips to a private IP after we validate (rebinding)
 *
 * Defence is applied at three points:
 *   1. before navigation  — parse, scheme/port check, DNS resolve, range check
 *   2. on every redirect  — the same check re-run against each hop
 *   3. after response     — the socket's actual peer IP is re-checked, which is
 *                           what closes the DNS-rebinding window
 */

export class BlockedTargetError extends Error {
  constructor(message, code = 'blocked_target') {
    super(message);
    this.name = 'BlockedTargetError';
    this.code = code;
    /** Safe to show a visitor: never leaks whether an internal host exists. */
    this.public = true;
    /** A rejected target is bad input, not a server fault. */
    this.status = 400;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/** Hostname suffixes that are private by convention or reserved by RFC 6761/8375. */
const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.internal', '.intranet', '.private',
  '.corp', '.home', '.lan', '.home.arpa', '.test', '.example', '.invalid',
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'metadata', 'metadata.google.internal',
  'instance-data', 'metadata.goog',
]);

/* ------------------------------------------------------------------ IPv4 --- */

/** [network, prefixLength, human-readable reason] */
const IPV4_BLOCKS = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private (RFC1918)'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private (RFC1918)'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.31.196.0', 24, 'AS112'],
  ['192.52.193.0', 24, 'AMT'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private (RFC1918)'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // Reject octal/hex/short forms such as 0177.0.0.1 or 2130706433, which some
    // parsers silently accept as loopback.
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function ipv4Blocked(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return 'unparseable IPv4 address';
  for (const [network, prefix, reason] of IPV4_BLOCKS) {
    const base = ipv4ToInt(network);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) === (base & mask)) return reason;
  }
  if (value === 0xffffffff) return 'broadcast';
  return null;
}

/* ------------------------------------------------------------------ IPv6 --- */

/** Expand any valid IPv6 text form to 8 groups of 16-bit numbers. */
function ipv6Groups(ip) {
  let addr = ip.trim().toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  // Strip a zone index (fe80::1%eth0) — a zone means link-local, blocked below anyway.
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);

  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1 or 64:ff9b::192.168.0.1
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parse = (chunk) =>
    chunk === '' ? [] : chunk.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : NaN));

  let groups;
  if (halves.length === 2) {
    const head = parse(halves[0]);
    const tailGroups = parse(halves[1]);
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tailGroups];
  } else {
    groups = parse(halves[0]);
  }

  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g))) return null;
  return groups;
}

function ipv6Blocked(ip) {
  const g = ipv6Groups(ip);
  if (!g) return 'unparseable IPv6 address';

  const isZeroPrefix = (count) => g.slice(0, count).every((x) => x === 0);

  if (g.every((x) => x === 0)) return 'unspecified address';
  if (isZeroPrefix(7) && g[7] === 1) return 'loopback';

  // ::ffff:a.b.c.d — IPv4-mapped. Unwrap and apply the IPv4 rules.
  if (isZeroPrefix(5) && g[5] === 0xffff) {
    return ipv4Blocked(intsToIpv4(g[6], g[7])) ?? null;
  }
  // ::a.b.c.d — deprecated IPv4-compatible. Unwrap too.
  if (isZeroPrefix(6) && !(g[6] === 0 && g[7] === 0)) {
    return ipv4Blocked(intsToIpv4(g[6], g[7])) ?? 'IPv4-compatible IPv6';
  }
  // 64:ff9b::/96 — NAT64. The embedded IPv4 is the real destination.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return ipv4Blocked(intsToIpv4(g[6], g[7])) ?? null;
  }
  // 2002::/16 — 6to4. Bytes 2-5 carry the IPv4 address.
  if (g[0] === 0x2002) {
    return ipv4Blocked(intsToIpv4(g[1], g[2])) ?? null;
  }

  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return 'discard-only';
  if ((g[0] & 0xfe00) === 0xfc00) return 'unique local (fc00::/7)';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'documentation';
  if (g[0] === 0x2001 && g[1] <= 0x01ff) return 'IETF protocol assignment';

  return null;
}

function intsToIpv4(hi, lo) {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

/* ---------------------------------------------------------------- public --- */

/**
 * @returns {string|null} a human-readable reason when the literal IP is not a
 *   routable public address, or null when it is safe to contact.
 */
export function ipBlockReason(ip) {
  // Accept the bracketed IPv6 spelling. Playwright's `response.serverAddr()`
  // returns `[2606:4700::1]`, not `2606:4700::1`, and `net.isIP` rejects that —
  // so the post-navigation peer check in scanner.js received 'not an IP address'
  // for every site reached over IPv6 and blocked it as a private address. Fly
  // prefers IPv6 for egress, so on the deployed instance that was most of the
  // public internet: the scan appeared to work, then died with "That address
  // cannot be checked."
  //
  // Stripping here can only make the check STRICTER, never looser. Unparseable
  // input was already blocked, so the sole behaviour change is that a bracketed
  // address now gets classified on its merits: `[::1]` is finally recognised as
  // loopback rather than blocked-by-accident for being unparseable, and a
  // bracketed public address stops being a false positive. `net.isIP` still
  // gates everything after the brackets come off, so a bracketed non-address
  // keeps failing closed.
  const candidate =
    typeof ip === 'string' && ip.length > 2 && ip.startsWith('[') && ip.endsWith(']')
      ? ip.slice(1, -1)
      : ip;
  const version = net.isIP(candidate);
  if (version === 4) return ipv4Blocked(candidate);
  if (version === 6) return ipv6Blocked(candidate);
  return 'not an IP address';
}

export const isPublicIp = (ip) => ipBlockReason(ip) === null;

/**
 * Normalize user input into a URL we are willing to fetch. Pure/synchronous:
 * no DNS. Throws BlockedTargetError with a visitor-safe message.
 */
export function normalizeTargetUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BlockedTargetError('Enter the address of the store you want to check.', 'empty_url');
  }

  let input = raw.trim();
  if (input.length > 2000) {
    throw new BlockedTargetError('That address is too long.', 'url_too_long');
  }
  // Reject control characters and whitespace used to smuggle past parsers.
  if (/[\u0000-\u001F\u007F\s\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF]/.test(input)) {
    throw new BlockedTargetError("That doesn't look like a valid web address.", 'invalid_url');
  }
  // Bare domains are the common case: "yourstore.com".
  if (!/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `https://${input}`;

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new BlockedTargetError("That doesn't look like a valid web address.", 'invalid_url');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedTargetError('Only http and https addresses can be checked.', 'bad_scheme');
  }
  // Test-only bypass, placed immediately after the scheme check so a fixture
  // server on an ephemeral loopback port is reachable. The http/https
  // restriction above still applies. `allowPrivateTargets` is ANDed with
  // !isProd in config, so this branch is unreachable on a deployed instance.
  if (config.security.allowPrivateTargets) {
    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    url.hash = '';
    return url;
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    throw new BlockedTargetError('Only standard web ports can be checked.', 'bad_port');
  }
  // Credentials in the URL are a classic parser-confusion vector.
  if (url.username || url.password) {
    throw new BlockedTargetError('Remove the username and password from the address.', 'credentials_in_url');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) {
    throw new BlockedTargetError("That doesn't look like a valid web address.", 'invalid_url');
  }

  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new BlockedTargetError('That address cannot be checked.', 'blocked_host');
  }
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new BlockedTargetError('That address cannot be checked.', 'blocked_host');
  }
  for (const blocked of config.security.scanBlocklist) {
    const b = blocked.toLowerCase();
    if (host === b || host.endsWith(`.${b}`)) {
      throw new BlockedTargetError('That address cannot be checked.', 'blocked_host');
    }
  }

  // A literal IP is checked immediately; a name is checked after resolution.
  if (net.isIP(host)) {
    const reason = ipBlockReason(host);
    if (reason) throw new BlockedTargetError('That address cannot be checked.', 'private_address');
  } else if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.startsWith('-') || host.endsWith('-')) {
    // `new URL` already punycodes IDNs, so anything outside this set is malformed.
    throw new BlockedTargetError("That doesn't look like a valid web address.", 'invalid_hostname');
  }

  // Write the canonical host back. Validation ran against `host`, so every
  // downstream consumer (cache key, dedupe, blocklists) must see that same
  // value rather than the raw input spelling.
  url.hostname = host;
  url.hash = '';
  return url;
}

/**
 * Resolve the hostname and require that EVERY answer is a public address.
 * Requiring all of them (not just the first) prevents a multi-record host from
 * steering us onto a private IP by connection order.
 */
export async function assertResolvesPublicly(hostname) {
  if (config.security.allowPrivateTargets) return [hostname];
  if (net.isIP(hostname)) {
    if (ipBlockReason(hostname)) {
      throw new BlockedTargetError('That address cannot be checked.', 'private_address');
    }
    return [hostname];
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BlockedTargetError(
      "We couldn't find that domain. Check the spelling and try again.",
      'dns_failure',
    );
  }

  if (!addresses.length) {
    throw new BlockedTargetError("We couldn't find that domain. Check the spelling and try again.", 'dns_failure');
  }

  for (const { address } of addresses) {
    if (ipBlockReason(address)) {
      throw new BlockedTargetError('That address cannot be checked.', 'private_address');
    }
  }

  return addresses.map((a) => a.address);
}

/** Full pre-navigation validation: syntax, policy, and DNS. */
export async function validateScanTarget(raw) {
  const url = normalizeTargetUrl(raw);
  const addresses = await assertResolvesPublicly(url.hostname);
  return { url, addresses };
}

/**
 * Re-validation for a redirect hop or for the peer IP reported by the socket.
 * Synchronous and cheap so it can run inside a Playwright route handler.
 */
export function isAllowedHopSync(rawUrl) {
  if (config.security.allowPrivateTargets) return true;
  try {
    const url = normalizeTargetUrl(rawUrl);
    // A literal-IP hop is fully decided here; a named hop still needs DNS, which
    // the post-response peer-IP check covers.
    if (net.isIP(url.hostname)) return !ipBlockReason(url.hostname);
    return true;
  } catch {
    return false;
  }
}

export default {
  validateScanTarget,
  normalizeTargetUrl,
  assertResolvesPublicly,
  isAllowedHopSync,
  isPublicIp,
  ipBlockReason,
  BlockedTargetError,
};
