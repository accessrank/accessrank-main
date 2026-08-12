import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTargetUrl,
  ipBlockReason,
  isPublicIp,
  isAllowedHopSync,
  BlockedTargetError,
} from '../../server/lib/ssrf.js';

const blocked = (input) => {
  assert.throws(
    () => normalizeTargetUrl(input),
    (err) => err instanceof BlockedTargetError,
    `expected ${JSON.stringify(input)} to be rejected`,
  );
};

test('accepts ordinary store addresses', () => {
  assert.equal(normalizeTargetUrl('yourstore.com').href, 'https://yourstore.com/');
  assert.equal(normalizeTargetUrl('  yourstore.com  ').href, 'https://yourstore.com/');
  assert.equal(normalizeTargetUrl('http://shop.example.org/path?a=1').href, 'http://shop.example.org/path?a=1');
  assert.equal(normalizeTargetUrl('https://a.co/x#frag').hash, '', 'fragment is stripped');
  assert.equal(normalizeTargetUrl('yourstore.com.').hostname, 'yourstore.com', 'trailing dot normalized');
});

test('punycodes internationalized domains rather than rejecting them', () => {
  assert.equal(normalizeTargetUrl('münchen.de').hostname, 'xn--mnchen-3ya.de');
});

test('rejects non-HTTP schemes', () => {
  for (const input of [
    'file:///etc/passwd',
    'gopher://127.0.0.1:11211/_stats',
    'ftp://example.com',
    'javascript:alert(1)',
    'data:text/html,<h1>x',
    'dict://localhost:11211/',
  ]) blocked(input);
});

test('rejects loopback in every spelling', () => {
  for (const input of [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://LOCALHOST/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://127.1/',
    'http://0177.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0.0.0.0/',
    'http://app.localhost/',
  ]) blocked(input);
});

test('rejects the cloud metadata endpoint', () => {
  for (const input of [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://metadata/',
    'http://[fe80::1]/',
  ]) blocked(input);
});

test('rejects RFC1918 and other private ranges', () => {
  for (const input of [
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
  ]) blocked(input);
});

test('rejects IPv6 tunnels that embed a private IPv4 destination', () => {
  blocked('http://[64:ff9b::192.168.0.1]/');
  blocked('http://[2002:c0a8:0001::]/');
  blocked('http://[::ffff:169.254.169.254]/');
  assert.equal(ipBlockReason('64:ff9b::8.8.8.8'), null, 'NAT64 wrapping a public IPv4 is fine');
});

test('accepts the bracketed IPv6 spelling Playwright reports for peer addresses', () => {
  // response.serverAddr() returns '[2606:4700::1]', not '2606:4700::1'. Treating
  // that as unparseable made the post-navigation peer check in scanner.js reject
  // every target reached over IPv6 — which, on an IPv6-preferring host, was most
  // of the public internet. The scan ran, then failed with 'private_address'.
  assert.equal(ipBlockReason('[2606:4700:3034::6815:32a2]'), null, 'bracketed public IPv6 is contactable');
  assert.equal(ipBlockReason('[64:ff9b::8.8.8.8]'), null, 'bracketed NAT64 over a public IPv4 is fine');

  // Stripping brackets must not open a hole: these stay blocked, and now for the
  // right reason rather than by falling through to 'not an IP address'.
  assert.ok(ipBlockReason('[::1]'), 'bracketed loopback stays blocked');
  assert.ok(ipBlockReason('[::ffff:127.0.0.1]'), 'bracketed mapped loopback stays blocked');
  assert.ok(ipBlockReason('[::ffff:169.254.169.254]'), 'bracketed mapped metadata address stays blocked');
  assert.ok(ipBlockReason('[fd00::1]'), 'bracketed unique-local stays blocked');
  assert.ok(ipBlockReason('[not-an-address]'), 'bracketed junk still fails closed');
  assert.ok(ipBlockReason('[]'), 'empty brackets fail closed');
  assert.ok(ipBlockReason('[2606:4700::1'), 'a half-bracketed string fails closed');
});

test('rejects internal-looking hostname suffixes', () => {
  for (const input of ['http://db.internal/', 'http://printer.local/', 'http://foo.lan/', 'http://x.home.arpa/']) {
    blocked(input);
  }
});

test('rejects credentials, odd ports, and malformed hosts', () => {
  blocked('http://user:pass@example.com/');
  blocked('http://example.com:22/');
  blocked('http://example.com:6379/');
  blocked('http://nodot/');
  blocked('http://-lead.com/');
  blocked('');
  blocked('   ');
  blocked('https://exa mple.com');
  blocked(`https://${'a'.repeat(2100)}.com`);
});

test('classifies public addresses as reachable', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '23.227.38.65', '2606:4700::1111', '2a00:1450:4001:80f::200e']) {
    assert.equal(isPublicIp(ip), true, `${ip} should be public`);
  }
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fe80::1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPublicIp(ip), false, `${ip} should be blocked`);
  }
});

test('redirect hops are re-checked', () => {
  assert.equal(isAllowedHopSync('https://shop.example.com/next'), true);
  assert.equal(isAllowedHopSync('http://169.254.169.254/'), false);
  assert.equal(isAllowedHopSync('http://127.0.0.1:8080/'), false);
  assert.equal(isAllowedHopSync('file:///etc/passwd'), false);
});

test('block reasons never leak whether an internal host exists', () => {
  for (const input of ['http://10.0.0.5/', 'http://169.254.169.254/', 'http://db.internal/']) {
    try {
      normalizeTargetUrl(input);
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /cannot be checked/);
      assert.doesNotMatch(err.message, /10\.0\.0|169\.254|internal/);
    }
  }
});
