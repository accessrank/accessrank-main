import test from 'node:test';
import assert from 'node:assert/strict';
import { minifyCss } from '../../server/lib/minify.js';

/**
 * These are regression tests for a bug that produced no error anywhere: the
 * minifier broke calc(), which invalidated a custom property, which silently
 * zeroed every section's padding across the whole site.
 */

test('calc() keeps the whitespace it requires around + and -', () => {
  const out = minifyCss('.a { --edge: max(64px, calc((100% - 1280px) / 2 + 64px)); }');
  assert.match(out, /2 \+ 64px/, '`2+64px` is invalid calc() syntax');
  assert.match(out, /100% - 1280px/, '`100%-1280px` is invalid calc() syntax');
});

test('other calc forms survive', () => {
  // Removing the space after a comma is valid and expected; what must survive is
  // the whitespace around + and - inside calc(), which CSS requires.
  const commaNormalized = (s) => s.replace(/,\s*/g, ',');

  for (const expr of [
    'calc(100% - 20px)',
    'calc(50% + 1rem)',
    'calc(var(--a) - var(--b))',
    'calc((100vw - 100%) / 2)',
    'clamp(1rem, calc(1rem + 2vw), 3rem)',
  ]) {
    const out = minifyCss(`.a { width: ${expr}; }`);
    assert.ok(
      out.includes(commaNormalized(expr)),
      `${expr} was mangled to: ${out}`,
    );
  }
});

test('comments are removed but license banners are kept', () => {
  assert.equal(minifyCss('/* note */ .a { color: red; }'), '.a{color: red}');
  assert.match(minifyCss('/*! (c) me */ .a { color: red; }'), /^\/\*! \(c\) me \*\//);
});

test('an apostrophe inside a comment cannot shield it from stripping', () => {
  // Regression: "index.html's <style> block" opened a phantom string under the
  // old per-segment order, and prose comments leaked into the shipped CSS.
  const css = "/* from legacy/index.html's <style> block */\n.a { color: red; }\n/* no \".btn-ghost\" class exists */\n.b { color: blue; }";
  const out = minifyCss(css);
  assert.equal(out.includes('legacy'), false, 'first comment is gone');
  assert.equal(out.includes('btn-ghost'), false, 'quoted-word comment is gone');
  assert.match(out, /\.a\{color: red\}/);
  assert.match(out, /\.b\{color: blue\}/);
});

test('comment markers inside genuine strings are not treated as comments', () => {
  // The space after `content:` dies at the protected-string boundary (segment
  // trim) — same as before this fix, and valid CSS either way.
  assert.equal(minifyCss('.a::before { content: "/* keep me */"; }'), '.a::before{content:"/* keep me */"}');
  assert.equal(minifyCss(".a::before { content: 'it\\'s fine'; }"), ".a::before{content:'it\\'s fine'}");
});

test('an unterminated comment swallows to EOF instead of leaking', () => {
  assert.equal(minifyCss('.a { color: red; } /* trailing prose that never closes'), '.a{color: red}');
});

test('structural whitespace is collapsed', () => {
  assert.equal(minifyCss('.a  ,  .b   {  color : red ;  }'), '.a,.b{color : red}');
  assert.equal(minifyCss('.a {\n  color: red;\n  background: blue;\n}'), '.a{color: red;background: blue}');
});

test('url() contents are never rewritten', () => {
  const css = ".a { background: url(data:image/svg+xml,%3Csvg a='1 + 2'%3E); }";
  const out = minifyCss(css);
  assert.ok(out.includes("url(data:image/svg+xml,%3Csvg a='1 + 2'%3E)"), `mangled: ${out}`);
});

test('quoted strings are never rewritten', () => {
  const out = minifyCss(`.a::after { content: "a  ,  b { } + c"; }`);
  assert.ok(out.includes('"a  ,  b { } + c"'), `mangled: ${out}`);
});

test('font-family stacks with quoted names survive', () => {
  const out = minifyCss(`.a { font-family: 'JetBrains Mono', ui-monospace, monospace; }`);
  assert.ok(out.includes(`'JetBrains Mono'`));
  assert.ok(out.includes('ui-monospace,monospace'));
});

test('media queries and nested at-rules survive', () => {
  const out = minifyCss('@media (min-width: 861px) and (max-width: 1200px) { .a { color: red; } }');
  assert.match(out, /@media \(min-width: 861px\) and \(max-width: 1200px\)/);
  assert.match(out, /\.a\{color: red\}/);
});

test('pseudo-selectors and :where() survive', () => {
  const out = minifyCss(':where(.site h2) { font-size: 36px; }\na:hover { color: blue; }');
  assert.ok(out.includes(':where(.site h2)'), `mangled: ${out}`);
  assert.ok(out.includes('a:hover'), `mangled: ${out}`);
});

test('it actually shrinks real input', () => {
  const css = `
    /* a long explanatory comment that should not survive */
    .selector {
      color: red;
      background: blue;
    }
  `;
  assert.ok(minifyCss(css).length < css.length / 2);
});
