# `report.html` data contract

This documents every placeholder used by `server/templates/report.html`, so the
code that builds the render context (`server/lib/pdf.js: buildReportContext`)
and the renderer (`server/lib/template.js: render`) stay in sync with the
template.

Verified against the actual production code as of this writing:
`server/lib/pdf.js` (`buildReportContext`, `describeCriteria`,
`CRITERION_NAMES`), `server/lib/scoring.js` (`scoreAccessibility`, `scoreSeo`,
`scoreOverall`, `band`, `rankIssues`), and `server/lib/template.js` (the
renderer). Field names below match that code exactly -- nothing here is
invented or renamed.

## Engine notes (read this before adding new placeholders)

- `{{ value }}` -- HTML-escaped. Used for everything in this template; no field
  needs raw markup, so `{{{ value }}}` is never used here.
- `{{#each list}}...{{/each}}` -- inside the loop, `this` is the current item,
  and if the item is a plain object, its own properties are also merged
  directly into scope. So inside `{{#each a11y.issues}}`, both `{{ impact }}`
  and `{{ this.impact }}` resolve the same value. This template consistently
  writes `this.field` only for items produced by nested loops (e.g.
  `sample`, `failedCriteriaDetailed`) to keep provenance obvious, and bare
  `field` for the outer loop item, matching how the two read most naturally.
- Inside `{{#each}}`, `{{ @number }}` (1-based index), `{{ @index }}`
  (0-based), `{{ @first }}` and `{{ @last }}` (booleans) are also available.
  This template uses `{{ @number }}` to number priority issues without any
  arithmetic in the template layer.
- `{{#if value}}...{{else}}...{{/if}}` and `{{#unless value}}...{{/unless}}` only
  test truthiness of a single dotted path (arrays are truthy iff non-empty).
  There is no equality operator. Anywhere the template needs different
  styling per literal string value (e.g. `status: "pass"|"partial"|"fail"`,
  or a score-band `tone`), it interpolates the literal string directly into a
  `class` or `data-*` attribute and lets CSS branch on that
  (`.badge--{{ impact }}`, `.tone-{{ scores.band.tone }}`,
  `[data-level="{{ level }}"]`) instead of asking the template to branch.
  Keep using this pattern rather than adding template-level conditionals for
  new literal-valued fields.
- Arrays passed into the context are real JS arrays, so `list.length` resolves
  through the same dotted-path lookup as any other field (e.g.
  `a11y.issues.length` would work) -- not currently used in this template
  since explicit count fields (`seo.total`, `a11y.criteriaFailed`, etc.) are
  already provided and are the source of truth; prefer those over `.length`
  if new counts are added.
- `sample` on each issue is already capped to 3 entries by
  `rankIssues()` in `server/lib/scoring.js` before it reaches the template --
  the template does not (and cannot) truncate it itself.
- `a11y.issues` and `a11y.needsReview` are already sorted worst-first by
  `rankIssues()` (impact, then element count, then level). The template
  renders them in the order given.

## Field reference

| Placeholder | Type | Meaning / where used |
|---|---|---|
| `report.generatedAt` | string | Human date, e.g. `"12 July 2026"` (produced by `formatDate()` in `pdf.js`, `en-GB` long format). Cover meta, disclaimer page. |
| `report.id` | string | Short report id (8 chars in current code). Cover meta, disclaimer page. |
| `site.url` | string | Full URL of the scanned page, e.g. `"https://acmestore.com"`. Cover subtitle. |
| `site.origin` | string | Origin/root domain, e.g. `"https://acmestore.com"`. "At a glance" intro line. |
| `site.title` | string | The scanned page's `<title>`. Document `<title>`, cover `<h1>`. |
| `site.pagesScanned` | integer | Number of pages crawled. "At a glance" intro, disclaimer intro. |
| `site.pageUrls` | string[] | Full URLs of every page scanned. Looped with `{{#each site.pageUrls}}{{ this }}{{/each}}` on the disclaimer page, guarded by `{{#if site.pageUrls}}`. |
| `lead.name` | string | Person the report was prepared for. Cover meta ("Prepared for"). |
| `scores.overall` | integer 0-100 | Cover score ring, "At a glance" overall card (also drives that card's meter bar width via inline `style="width:{{ scores.overall }}%"`). |
| `scores.accessibility` | integer 0-100 | "At a glance" accessibility card + meter width. |
| `scores.seo` | integer 0-100 | "At a glance" SEO card + meter width. |
| `scores.band.label` | string | `"High risk"` / `"At risk"` / `"Fair"` / `"Strong"` (per `band()` in `scoring.js`). Cover band pill, overall score card. |
| `scores.band.tone` | string | `"bad"` / `"warn"` / `"ok"` / `"good"` -- interpolated directly as `tone-{{ scores.band.tone }}` CSS class (see engine notes). Defensive note: `band()` also returns tone `"neutral"` when `score` is `null` (nothing to evaluate); the stylesheet includes a `.tone-neutral` rule so this degrades gracefully even though it is not one of the four documented values. |
| `a11y.criteriaEvaluated` | integer | "What this means" stat row. |
| `a11y.criteriaMet` | integer | "What this means" stat row. |
| `a11y.criteriaFailed` | integer | "What this means" stat row; also referenced in the "At a glance" severity intro sentence. |
| `a11y.criteriaReview` | integer | "What this means" stat row ("Needs manual review"). |
| `a11y.failedCriteria` | string[] | Raw failed success-criterion ids, e.g. `["1.1.1","1.4.3"]`. Not interpolated directly in the template -- it is the source array that `a11y.failedCriteriaDetailed` is derived from. Kept in the contract because it is the field the template's data depends on upstream. |
| `a11y.failedCriteriaDetailed` | `{ id, name, level }[]` | Prepared list, one entry per id in `a11y.failedCriteria`, already built server-side by `describeCriteria()` in `server/lib/pdf.js` using its `CRITERION_NAMES` lookup table (covers far more than the 12 criteria commonly seen -- see that table for the canonical id -> name/level mapping; the 12 the visual spec called out by name are `1.1.1`, `1.3.1`, `1.4.3`, `2.1.1`, `2.4.2`, `2.4.4`, `2.4.7`, `2.5.8`, `3.1.1`, `3.3.2`, `4.1.2`, `4.1.3`). Rendered as a table on "Failed success criteria": `{{#each a11y.failedCriteriaDetailed}}` -> `{{ this.id }}`, `{{ this.name }}`, `{{ this.level }}`. Section falls back to an empty-state note via `{{#if a11y.failedCriteriaDetailed}}...{{else}}...{{/if}}` when empty. |
| `a11y.violationsTotal` | integer | Total failing elements (not criteria) across all rules. "At a glance" severity intro. |
| `a11y.counts.critical` | integer | Severity tile. Also `.serious`, `.moderate`, `.minor` (same shape). |
| `a11y.issues` | array (see below) | Priority issues list. `{{#each a11y.issues}}`, guarded by `{{#if a11y.issues}}...{{else}}...{{/if}}` for the empty-scan case. |
| `a11y.issues[].id` | string | Axe rule id. Not currently printed (kept available for a future "rule id" footnote / dedupe key). |
| `a11y.issues[].impact` | string | One of `critical`/`serious`/`moderate`/`minor` (`rankIssues()` defaults unknown impact to `minor`). Interpolated as `badge--{{ impact }}`. |
| `a11y.issues[].help` | string | Short rule title. Issue card `<h3>`. |
| `a11y.issues[].description` | string | Longer rule description. Issue card body paragraph. |
| `a11y.issues[].helpUrl` | string | Link to rule documentation. Rendered as visible, wrapping link text (useful both on screen and if the PDF is ever printed to paper). |
| `a11y.issues[].nodes` | integer | Count of affected elements. Issue meta chip ("N element(s) affected"). |
| `a11y.issues[].criteria` | string[] | WCAG SC ids the rule maps to, e.g. `["1.4.3"]`. Looped as chips: `{{#each criteria}}{{ this }}{{/each}}`. Can be empty (best-practice-only rules); `{{#unless criteria}}` renders a "No specific criterion mapped" chip in that case. |
| `a11y.issues[].level` | string | `"A"` / `"AA"` / `"Best practice"` per the brief's contract. In practice `conformanceLevel()` in `scoring.js` can also emit `"AAA"` for a Level AAA-tagged rule; rendered via a `data-level="{{ level }}"` attribute (not a CSS class) specifically so a value containing a space, `"Best practice"`, still works as a single attribute-selector target (`[data-level="Best practice"]`). |
| `a11y.issues[].sample` | `{ target, snippet, summary }[]` | Up to 3 concrete DOM examples, already truncated upstream. `{{#if sample}}...{{/if}}` guards the whole block since some issues may have none. |
| `a11y.issues[].sample[].target` | string | CSS selector of the offending element. Shown above the snippet in small mono text. |
| `a11y.issues[].sample[].snippet` | string | Raw HTML snippet (already length-capped upstream to 300 chars by `rankIssues()`). Rendered inside `<pre>` with `white-space:pre-wrap; overflow-wrap:anywhere;` so it always wraps instead of overflowing the page. |
| `a11y.issues[].sample[].summary` | string or null | Axe's `failureSummary` for that node, when present. Guarded with `{{#if this.summary}}`. |
| `a11y.needsReview` | array, same shape as `a11y.issues` | "Needs human review" section. Deliberately rendered without the `sample` block (kept brief per the visual spec) even though the field exists on each item. Guarded with `{{#if a11y.needsReview}}...{{else}}...{{/if}}`. |
| `seo.checks` | array (see below) | SEO checklist table rows. |
| `seo.checks[].id` | string | Stable check id (e.g. `"title"`, `"imageAlt"`). Not directly printed. |
| `seo.checks[].label` | string | Human-readable check name. First table column. |
| `seo.checks[].weight` | integer | Relative importance (1-3 in current data). Third table column. |
| `seo.checks[].status` | string | `"pass"` / `"partial"` / `"fail"`. Interpolated directly as `seo-mark--{{ status }}` and `status-{{ status }}` classes (dot + colour-coded label text; the literal status word is always shown as real text too, not colour alone). |
| `seo.checks[].detail` | string or null | Optional explanation. `{{#if detail}}{{ detail }}{{else}}--{{/if}}`. |
| `seo.passed` | integer | "SEO checklist" intro line ("N of M checks passed"). |
| `seo.total` | integer | Same line. |
| `engine.axeVersion` | string | e.g. `"4.12.1"`. Disclaimer page methodology line, guarded with `{{#if engine.axeVersion}}` since it can be an empty string upstream. |
| `engine.name` | string | `"Accessrank audit engine"`. Disclaimer page. |
| `engine.version` | string | e.g. `"1.0.0"`. Disclaimer page. |

## Fields intentionally not used from the live context

`buildReportContext()` in `server/lib/pdf.js` currently also puts
`lead.email`, `site_url` (top-level) and `contactEmail` on the render context.
None of these are referenced by `report.html`: the "What happens next"
section intentionally hardcodes `accessrank.ai` / `info@accessrank.ai` as
literal text per the visual spec, rather than pointing at
`config.siteUrl` / `config.email.replyTo`. If the CTA should ever become
environment-driven, switch those two lines to `{{ site_url }}` /
`{{ contactEmail }}` and add them to this contract.

## Empty-state behaviour

Every list that could plausibly be empty on a real scan is guarded so the PDF
never renders a broken-looking blank section:

- `a11y.failedCriteriaDetailed` -> "No failed success criteria were recorded
  for this scan."
- `a11y.issues` -> "No priority issues were found in this scan."
- `a11y.needsReview` -> "No additional items were flagged for manual review."

`seo.checks` is not guarded with an empty state -- `SEO_CHECKS` in
`scoring.js` is a fixed, non-empty list, so `seo.checks` is always populated.
