import test from 'node:test';
import assert from 'node:assert/strict';
import { render, escapeHtml } from '../../server/lib/template.js';

test('escapes interpolations by default', () => {
  assert.equal(render('<p>{{ x }}</p>', { x: '<script>alert(1)</script>' }),
    '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(render('{{ x }}', { x: `a"b'c&d` }), 'a&quot;b&#39;c&amp;d');
});

test('triple braces emit raw markup', () => {
  assert.equal(render('{{{ x }}}', { x: '<b>hi</b>' }), '<b>hi</b>');
});

test('missing values render as empty, not "undefined"', () => {
  assert.equal(render('[{{ nope }}]', {}), '[]');
  assert.equal(render('[{{ a.b.c }}]', { a: {} }), '[]');
});

test('dotted paths resolve', () => {
  assert.equal(render('{{ a.b.c }}', { a: { b: { c: 'deep' } } }), 'deep');
});

test('conditionals with else', () => {
  assert.equal(render('{{#if x}}yes{{else}}no{{/if}}', { x: true }), 'yes');
  assert.equal(render('{{#if x}}yes{{else}}no{{/if}}', { x: false }), 'no');
  assert.equal(render('{{#if x}}yes{{/if}}', { x: 0 }), '');
  assert.equal(render('{{#if list}}has{{else}}empty{{/if}}', { list: [] }), 'empty');
  assert.equal(render('{{#unless x}}shown{{/unless}}', { x: false }), 'shown');
});

test('iteration exposes the item and its properties', () => {
  const out = render('{{#each items}}<li>{{ this.name }}={{ value }}</li>{{/each}}',
    { items: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] });
  assert.equal(out, '<li>a=1</li><li>b=2</li>');
});

test('iteration exposes @index, @number, @first and @last', () => {
  const out = render('{{#each xs}}{{ @number }}{{#if @last}}.{{else}},{{/if}}{{/each}}', { xs: [0, 0, 0] });
  assert.equal(out, '1,2,3.');
});

/* The defect this engine had: a non-greedy regex closed the outer block at the
 * INNER {{/each}}, so nested loops emitted literal template text into the PDF. */

test('nested each blocks of the same type render correctly', () => {
  const template = '{{#each groups}}[{{ label }}:{{#each items}}{{ this }}{{/each}}]{{/each}}';
  const out = render(template, {
    groups: [
      { label: 'a', items: ['1', '2'] },
      { label: 'b', items: ['3'] },
    ],
  });
  assert.equal(out, '[a:12][b:3]');
});

test('three levels of nesting still resolve', () => {
  const template = '{{#each a}}({{#each b}}<{{#each c}}{{ this }}{{/each}}>{{/each}}){{/each}}';
  const out = render(template, { a: [{ b: [{ c: ['x', 'y'] }, { c: ['z'] }] }] });
  assert.equal(out, '(<xy><z>)');
});

test('nested if inside each, and each inside if', () => {
  assert.equal(
    render('{{#each xs}}{{#if flag}}Y{{else}}N{{/if}}{{/each}}',
      { xs: [{ flag: true }, { flag: false }, { flag: true }] }),
    'YNY',
  );
  assert.equal(
    render('{{#if on}}{{#each xs}}{{ this }}{{/each}}{{/if}}', { on: true, xs: ['a', 'b'] }),
    'ab',
  );
});

test('an else inside a nested block does not hijack the outer block', () => {
  const template = '{{#if outer}}O{{#if inner}}I{{else}}i{{/if}}{{else}}X{{/if}}';
  assert.equal(render(template, { outer: true, inner: true }), 'OI');
  assert.equal(render(template, { outer: true, inner: false }), 'Oi');
  assert.equal(render(template, { outer: false, inner: true }), 'X');
});

test('this refers to a primitive item directly', () => {
  assert.equal(render('{{#each xs}}[{{ this }}]{{/each}}', { xs: ['a', 'b'] }), '[a][b]');
});

test('a non-array in each renders nothing rather than throwing', () => {
  assert.equal(render('{{#each nope}}x{{/each}}', {}), '');
  assert.equal(render('{{#each s}}x{{/each}}', { s: 'string' }), '');
});

test('an unclosed block is a loud error, not silent truncation', () => {
  assert.throws(() => render('{{#each xs}}oops', { xs: [1] }), /Unclosed/);
});

test('interpolating an object throws instead of printing [object Object]', () => {
  assert.throws(
    () => render('{{ obj }}', { obj: { a: 1 } }),
    /resolved to an object/,
    'a customer-facing PDF must never contain [object Object]',
  );
});

test('escapeHtml is exported and total', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
});
