/**
 * Conservative CSS minifier.
 *
 * Deliberately timid. An aggressive whitespace-stripping pass looks harmless and
 * is not: an earlier version collapsed spaces around `+`, which turned
 *
 *     calc((100% - 1280px) / 2 + 64px)     into     calc((100% - 1280px) / 2+64px)
 *
 * `calc()` REQUIRES whitespace around `+` and `-`. Without it the declaration is
 * invalid, so the `--edge` custom property never resolved, so every
 * `padding: 50px var(--edge) 64px` became invalid-at-computed-value-time and
 * silently fell back to zero. The whole site lost its section spacing and
 * nothing errored anywhere.
 *
 * The rules here therefore avoid every character that is meaningful inside a
 * value: `+ - * / :` are never touched, and `url(...)` and quoted strings are
 * passed through untouched. Comments are the bulk of the saving anyway.
 */

/** Split on url(...) and quoted strings so their contents are never rewritten. */
const PROTECTED = /(url\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;

function minifySegment(css) {
  return css
    // Strip comments, but keep `/*!` license banners.
    .replace(/\/\*(?!!)[\s\S]*?\*\//g, '')
    // Collapse runs of whitespace to a single space.
    .replace(/\s+/g, ' ')
    // Tighten around structural characters only. Deliberately excluded:
    //   `+ - * /`  meaningful inside calc()
    //   `:`        ambiguous between pseudo-selectors and declarations
    //   `( )`      `@media (a) and (b)` becomes `@media(a)and(b)`, which is invalid
    //   `> ~`      safe in selectors but also appear inside some values
    .replace(/ *([{};,]) */g, '$1')
    // A trailing semicolon before a closing brace is redundant.
    .replace(/;}/g, '}')
    // Restore the single space after a colon in declarations that need it for
    // readability of the output; purely cosmetic and always safe.
    .trim();
}

export function minifyCss(css) {
  return String(css)
    .split(PROTECTED)
    .map((segment, index) => (index % 2 === 1 ? segment : minifySegment(segment)))
    .join('')
    .trim();
}

export default minifyCss;
