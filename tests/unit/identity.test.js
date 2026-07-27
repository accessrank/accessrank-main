import test from 'node:test';
import assert from 'node:assert/strict';

process.env.IP_HASH_SALT = process.env.IP_HASH_SALT || 'a-test-salt-that-is-at-least-32-characters-long';

const {
  normalizeEmail, normalizeIp, hashIp, clientIp, normalizePhone, cleanText,
  UNKNOWN_CLIENT, InvalidEmailError,
} = await import('../../server/lib/identity.js');

/* ---------------------------------------------------------------- email --- */

test('gmail aliases collapse to one quota key', () => {
  const canonical = normalizeEmail('carlos@gmail.com').normalized;
  for (const variant of [
    'carlos+promo@gmail.com', 'c.a.r.l.o.s@gmail.com', 'CARLOS@GMAIL.COM',
    'carlos@googlemail.com', 'Carlos+a+b@GoogleMail.com', '  carlos@gmail.com  ',
  ]) {
    assert.equal(normalizeEmail(variant).normalized, canonical, `${variant} should collapse`);
  }
});

test('dots are significant outside gmail', () => {
  assert.notEqual(
    normalizeEmail('first.last@fastmail.com').normalized,
    normalizeEmail('firstlast@fastmail.com').normalized,
    'dot-stripping must not be applied to providers where dots matter',
  );
});

test('the deliverable address is preserved separately from the quota key', () => {
  const r = normalizeEmail('Carlos+Promo@Gmail.com');
  assert.equal(r.email, 'carlos+promo@gmail.com', 'we must send to what they typed');
  assert.equal(r.normalized, 'carlos@gmail.com', 'but count against the collapsed key');
});

test('disposable domains are refused', () => {
  assert.throws(() => normalizeEmail('a@mailinator.com'), (e) => e.code === 'email_disposable');
  assert.throws(() => normalizeEmail('a@yopmail.com'), (e) => e.code === 'email_disposable');
});

test('malformed addresses are refused', () => {
  for (const bad of ['', '   ', 'nope', 'a@b', 'a@@b.com', 'a b@c.com', `${'x'.repeat(250)}@y.com`]) {
    assert.throws(() => normalizeEmail(bad), (e) => e instanceof InvalidEmailError, `${bad} should be refused`);
  }
});

/* ------------------------------------------------------------------- ip --- */

test('IPv4 addresses normalize to themselves', () => {
  assert.equal(normalizeIp('203.0.113.9'), '203.0.113.9');
  assert.equal(normalizeIp('::ffff:203.0.113.9'), '203.0.113.9', 'dual-stack IPv4 is unwrapped');
});

test('IPv6 addresses collapse to their /64 prefix', () => {
  assert.equal(normalizeIp('2a00:1450:4001:80f:abcd:1234:5678:9abc'), '2a00:1450:4001:80f::/64');
  assert.equal(
    normalizeIp('2a00:1450:4001:80f:1111:2222:3333:4444'),
    normalizeIp('2a00:1450:4001:80f:9999:8888:7777:6666'),
    'a subscriber cannot escape their own /64 by rotating the host part',
  );
  assert.notEqual(
    normalizeIp('2a00:1450:4001:80f::1'),
    normalizeIp('2a00:1450:4001:810::1'),
    'different /64s remain different',
  );
});

/**
 * REGRESSION — this shipped and disabled the per-IP quota for every IPv6 client.
 *
 * `clientIp()` used to return an already-normalized value, and every route then
 * called `hashIp(clientIp(req))`. hashIp normalizes again, and "2a00::/64" is
 * not a parseable IP literal, so the second pass returned null. Because the
 * quota code guards with `if (ipHash)`, null meant "skip the check" — a total
 * bypass requiring no attacker effort, on the majority of modern connections.
 */
test('normalizeIp is idempotent', () => {
  for (const raw of [
    '203.0.113.9', '::1', '2a00:1450:4001:80f:abcd:1234:5678:9abc', 'fe80::1', '::ffff:127.0.0.1',
  ]) {
    const once = normalizeIp(raw);
    assert.ok(once, `${raw} should normalize`);
    assert.equal(normalizeIp(once), once, `normalizing "${once}" again must be stable`);
  }
});

test('hashIp survives being handed an already-normalized address', () => {
  for (const raw of ['203.0.113.9', '::1', '2a00:1450:4001:80f:abcd:1234:5678:9abc']) {
    const direct = hashIp(raw);
    const viaNormalized = hashIp(normalizeIp(raw));
    assert.ok(direct && direct !== UNKNOWN_CLIENT, `hashIp("${raw}") must produce a key`);
    assert.equal(viaNormalized, direct, `double normalization changed the key for ${raw}`);
  }
});

test('every IPv6 client gets a real, stable quota key', () => {
  const a = hashIp('2a00:1450:4001:80f:abcd:1234:5678:9abc');
  const b = hashIp('2a00:1450:4001:80f:ffff:0000:1111:2222');
  const c = hashIp('2606:4700:4700::1111');

  for (const [label, value] of [['a', a], ['b', b], ['c', c]]) {
    assert.ok(value, `${label} produced no key`);
    assert.notEqual(value, UNKNOWN_CLIENT, `${label} fell back to the shared bucket`);
  }
  assert.equal(a, b, 'the same /64 is one client');
  assert.notEqual(a, c, 'different /64s are different clients');
});

test('an undeterminable address fails closed onto a shared bucket, never onto null', () => {
  for (const bad of [null, undefined, '', 'garbage', 123]) {
    assert.equal(hashIp(bad), UNKNOWN_CLIENT, `hashIp(${JSON.stringify(bad)}) must not return a falsy key`);
  }
});

test('hashes are not reversible and do not contain the address', () => {
  const hash = hashIp('203.0.113.9');
  assert.ok(!hash.includes('203'), 'the address must not appear in the key');
  assert.ok(hash.length >= 16);
});

test('clientIp returns the raw address for the proxy-resolved IP', () => {
  assert.equal(clientIp({ ip: '2a00:1450:4001:80f::1', socket: {} }), '2a00:1450:4001:80f::1');
  assert.equal(clientIp({ socket: { remoteAddress: '203.0.113.4' } }), '203.0.113.4');
  assert.equal(clientIp({ socket: {} }), null);
});

/* ---------------------------------------------------------------- misc --- */

test('phone numbers are accepted internationally and normalized', () => {
  assert.equal(normalizePhone(' +1 (555) 010-9999 '), '+15550109999');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('555'), null, 'too short');
  assert.equal(normalizePhone('1234567890123456789'), null, 'too long');
  assert.equal(normalizePhone(''), null);
});

test('cleanText strips control characters and clamps length', () => {
  assert.equal(cleanText('  hello   world  '), 'hello world');
  assert.equal(cleanText('a'.repeat(500), 10), 'a'.repeat(10));
  assert.equal(cleanText(null), '');
});

test('cleanText removes angle brackets from names so no markup is ever stored', () => {
  assert.equal(cleanText('<script>alert(1)</script>Dana'), 'scriptalert(1)/scriptDana');
  assert.equal(cleanText('Dana <dana@x.com>'), 'Dana dana@x.com');
});
