import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny logic-light template renderer, shared by the static site build and the
 * PDF report so both use identical semantics.
 *
 *   {{ value }}                    HTML-escaped interpolation
 *   {{{ value }}}                  raw interpolation
 *   {{> partial }}                 include (only when `partialsDir` is given)
 *   {{#if value}}…{{else}}…{{/if}} conditional
 *   {{#unless value}}…{{/unless}}  negated conditional
 *   {{#each list}}…{{/each}}       iteration; inside, `this` is the item and the
 *                                  item's own properties are in scope
 *
 * Escaping is on by default. `{{{ }}}` is the only way to emit raw markup, so a
 * value that reaches the page unescaped is always visible at the call site —
 * which matters here because report content includes HTML snippets copied
 * verbatim from a stranger's website.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolvePath(context, expression) {
  const key = expression.trim();
  if (key === 'this') return context.this ?? context;
  return key.split('.').reduce((acc, part) => {
    if (acc == null) return undefined;
    if (part === 'this') return acc.this ?? acc;
    return acc[part];
  }, context);
}

const truthy = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

const BLOCK_OPEN = /\{\{#(each|if|unless)\s+([\w.@]+)\s*\}\}/;

/**
 * Find the `{{/tag}}` that closes the block opened at `from`, tracking depth so
 * nested blocks of the same type are matched correctly.
 *
 * A non-greedy regex cannot do this: `{{#each a}}{{#each b}}x{{/each}}{{/each}}`
 * would terminate the outer block at the inner `{{/each}}`, leaving the second
 * closer stranded and the inner loop unrendered. That produced literal
 * `{{#each criteria}}` text and `[object Object]` in the PDF report.
 *
 * @returns {{ body: string, end: number, elseBody: string|null }}
 */
function findBlockEnd(source, from, tag) {
  // Depth must count EVERY block type, not just `tag`. Counting only same-tag
  // tokens let an `{{else}}` belonging to a nested `{{#if}}` be claimed by an
  // enclosing `{{#each}}`, which split the inner block in half.
  const scanner = /\{\{#(each|if|unless)\b|\{\{\/(each|if|unless)\}\}|\{\{else\}\}/g;
  scanner.lastIndex = from;

  let depth = 1;
  let elseAt = -1;
  let match;

  while ((match = scanner.exec(source)) !== null) {
    const token = match[0];

    if (match[1]) {
      depth += 1;
    } else if (match[2]) {
      depth -= 1;
      if (depth === 0) {
        if (match[2] !== tag) {
          throw new Error(`Mismatched template block: {{#${tag}}} closed by {{/${match[2]}}}`);
        }
        const body = source.slice(from, elseAt === -1 ? match.index : elseAt);
        const elseBody = elseAt === -1 ? null : source.slice(elseAt + '{{else}}'.length, match.index);
        return { body, elseBody, end: match.index + token.length };
      }
    } else if (depth === 1 && elseAt === -1) {
      // The `{{else}}` at our own depth belongs to this block.
      elseAt = match.index;
    }
  }

  throw new Error(`Unclosed {{#${tag}}} block in template`);
}

function renderBlocks(template, context, opts) {
  let out = '';
  let cursor = 0;

  for (;;) {
    const rest = template.slice(cursor);
    const open = BLOCK_OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }

    const openStart = cursor + open.index;
    const bodyStart = openStart + open[0].length;
    const [, tag, expr] = open;
    const { body, elseBody, end } = findBlockEnd(template, bodyStart, tag);

    out += template.slice(cursor, openStart);
    const value = resolvePath(context, expr);

    if (tag === 'each') {
      if (!Array.isArray(value) || value.length === 0) {
        out += elseBody ? render(elseBody, context, opts) : '';
      } else {
        out += value
          .map((item, index) => render(body, {
            ...context,
            this: item,
            ...(item && typeof item === 'object' && !Array.isArray(item) ? item : {}),
            '@index': index,
            '@number': index + 1,
            '@first': index === 0,
            '@last': index === value.length - 1,
          }, opts))
          .join('');
      }
    } else if (tag === 'if') {
      const branch = truthy(value) ? body : (elseBody ?? '');
      out += render(branch, context, opts);
    } else {
      out += truthy(value) ? '' : render(body, context, opts);
    }

    cursor = end;
  }

  return out;
}

export function render(template, context = {}, { partialsDir = null, depth = 0 } = {}) {
  if (depth > 24) throw new Error('Template recursion too deep — check for a partial including itself');
  const opts = { partialsDir, depth: depth + 1 };
  let out = template;

  if (partialsDir) {
    out = out.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
      const file = path.join(partialsDir, `${name}.html`);
      if (!fs.existsSync(file)) throw new Error(`Missing partial: ${name}`);
      return render(fs.readFileSync(file, 'utf8'), context, opts);
    });
  }

  out = renderBlocks(out, context, opts);

  out = out.replace(/\{\{\{\s*([\w.@]+)\s*\}\}\}/g, (_, expr) => resolvePath(context, expr) ?? '');
  out = out.replace(/\{\{\s*([\w.@]+)\s*\}\}/g, (_, expr) => {
    const value = resolvePath(context, expr);
    if (value == null) return '';
    // An object reaching the output means the template addressed a container
    // rather than a field; "[object Object]" in a customer PDF is worse than loud.
    if (typeof value === 'object') {
      throw new Error(`Template expression {{ ${expr} }} resolved to an object, not a value`);
    }
    return escapeHtml(value);
  });

  return out;
}

export function renderFile(file, context, options) {
  return render(fs.readFileSync(file, 'utf8'), context, options);
}

export default { render, renderFile, escapeHtml };
