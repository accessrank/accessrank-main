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

/** Split on url(...) and quoted strings so their contents are never rewritten.
 *
 * The string alternatives exclude newlines deliberately: per the CSS grammar a
 * string cannot contain an unescaped newline, so nothing valid is lost — and
 * allowing them was an actual bug. An apostrophe inside a COMMENT ("legacy/
 * index.html's <style> block") opened a phantom multi-line 'string' that
 * swallowed everything to the next apostrophe; that span was then protected
 * from comment-stripping, so fragments of prose comments leaked into the
 * shipped stylesheet between rules. */
const PROTECTED = /(url\([^)]*\)|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*')/;

/**
 * Remove comments in a single stateful pass, BEFORE string protection runs.
 *
 * Comment removal used to happen per unprotected segment, which broke two ways:
 * an apostrophe inside a comment ("legacy/index.html's <style> block") opened a
 * phantom string that shielded the rest of the comment from stripping, and a
 * comment whose closing star-slash fell across a protected-string boundary left
 * its opener unmatched. Both leaked prose comments into the shipped stylesheet.
 * A tokenizer cannot be confused that way: it knows at every character whether
 * it is inside a comment, a string, or plain CSS.
 *
 * `/*!` license banners survive. Genuine strings pass through untouched, even
 * ones containing comment markers.
 */
function stripComments(css) {
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i];

    // Comment — skip it (or copy it verbatim when it is a /*! banner).
    if (ch === '/' && css[i + 1] === '*') {
      const banner = css[i + 2] === '!';
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2; // unterminated: swallow to EOF, like a parser
      if (banner) out += css.slice(i, stop);
      i = stop;
      continue;
    }

    // String — copy verbatim through the matching close quote. Per the CSS
    // grammar a string cannot contain an unescaped newline; treat one as an
    // implicit close so malformed input cannot make the state stick.
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && css[j] !== ch && css[j] !== '\n') {
        if (css[j] === '\\') j += 1; // escaped char, including \" \' and \newline
        j += 1;
      }
      if (j < n) j += 1; // include the closing quote (or the newline)
      out += css.slice(i, j);
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function minifySegment(css) {
  return css
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
  return stripComments(String(css))
    .split(PROTECTED)
    .map((segment, index) => (index % 2 === 1 ? segment : minifySegment(segment)))
    .join('')
    .trim();
}

export default minifyCss;
