/**
 * Scoring model.
 *
 * A number shown to a prospect has to be defensible — this company sells
 * compliance, so an arbitrary score is a liability. Two rules govern the design:
 *
 *   1. Everything is derived from what axe-core actually measured. No constants
 *      invented to make the number look bad enough to convert.
 *   2. The weighting is explainable in one sentence to a non-technical buyer,
 *      and the PDF prints that sentence.
 *
 * ACCESSIBILITY — conformance-criterion pass rate.
 *
 *   score = 100 x (weighted success criteria met) / (weighted criteria evaluated)
 *
 *   Scoring is per WCAG success criterion, NOT per element, because that is how
 *   conformance actually works: a store that leaves five images without alt text
 *   fails SC 1.1.1. It does not "mostly pass" it, and no amount of unrelated
 *   passing markup earns that back. An element-weighted model scores a page with
 *   no title, no lang attribute and unlabelled form fields at around 75 purely
 *   because thousands of other elements happened to pass unrelated checks — which
 *   would understate real legal exposure to a buyer.
 *
 *   Weight is the criterion's conformance level, which is what determines that
 *   exposure. Level is read from the rule's tags, available on passing and
 *   failing rules alike (axe's `impact` is null on passes, so it cannot weight
 *   the numerator):
 *
 *     Level A criteria      weight 3   (baseline; failing these is the usual claim)
 *     Level AA criteria     weight 2   (the ADA/EAA target)
 *     Best practice only    weight 1   (not a conformance failure)
 *
 *   Element counts still drive issue ranking and the remediation-effort figure —
 *   five broken images is more work than one, even though it is one failed
 *   criterion.
 *
 * SEO — a weighted checklist of on-page signals extracted from the same DOM.
 *
 * OVERALL — 60% accessibility, 40% SEO, matching how the product is positioned.
 */

/** Weight a rule by the strictest conformance level it belongs to. */
export function ruleWeight(tags = []) {
  const t = new Set(tags);
  if (t.has('wcag2a') || t.has('wcag21a')) return 3;
  if (t.has('wcag2aa') || t.has('wcag21aa') || t.has('wcag22aa')) return 2;
  return 1;
}

/** Order used for sorting and for the "worst first" issue list. */
export const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];
const IMPACT_RANK = Object.fromEntries(IMPACT_ORDER.map((k, i) => [k, i]));

/** Map an axe tag like `wcag143` to a readable success criterion. */
export function wcagCriteria(tags = []) {
  const out = [];
  for (const tag of tags) {
    const m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return [...new Set(out)].sort();
}

/** Highest conformance level the rule belongs to, for display. */
export function conformanceLevel(tags = []) {
  const t = new Set(tags);
  if (t.has('wcag2a') || t.has('wcag21a')) return 'A';
  if (t.has('wcag2aa') || t.has('wcag21aa') || t.has('wcag22aa')) return 'AA';
  if (t.has('wcag2aaa') || t.has('wcag21aaa')) return 'AAA';
  return 'Best practice';
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/**
 * The number of elements a rule actually applied to.
 *
 * The scanner ships only a capped sample of nodes for display, so `nodes.length`
 * understates a widespread failure. `nodeCount` carries the true population and
 * must always win when present — otherwise a page with 900 contrast failures
 * would be scored as if it had 8.
 */
const countNodes = (rule) => (typeof rule?.nodeCount === 'number' ? rule.nodeCount : rule?.nodes?.length ?? 0);

/**
 * @param {{violations: any[], passes: any[], incomplete: any[]}} axeResults
 *   Merged results across every page scanned.
 */
export function scoreAccessibility(axeResults) {
  const { violations = [], passes = [], incomplete = [] } = axeResults;

  /**
   * Collapse rules onto the success criteria they test.
   *
   * Several axe rules map to one criterion (e.g. `image-alt`, `input-image-alt`
   * and `area-alt` all test SC 1.1.1) and one rule can map to several. Grouping
   * by criterion means a store is judged on the standard it is held to, not on
   * how many rules the tool happens to ship. Rules with no WCAG tag are kept
   * under their own key at best-practice weight so they still count for
   * something without polluting the conformance picture.
   */
  const criteria = new Map(); // key -> { weight, failed, needsReview }

  const touch = (rule, outcome) => {
    const keys = wcagCriteria(rule.tags);
    const entries = keys.length ? keys.map((c) => ({ key: c, weight: ruleWeight(rule.tags) }))
      : [{ key: `rule:${rule.id}`, weight: 1 }];

    for (const { key, weight } of entries) {
      const existing = criteria.get(key) ?? { weight, failed: false, needsReview: false };
      // If two rules disagree on level, the stricter one governs.
      existing.weight = Math.max(existing.weight, weight);
      if (outcome === 'fail') existing.failed = true;
      if (outcome === 'review') existing.needsReview = true;
      criteria.set(key, existing);
    }
  };

  for (const rule of passes) touch(rule, 'pass');
  for (const rule of incomplete) touch(rule, 'review');
  for (const rule of violations) touch(rule, 'fail');

  let weightedMet = 0;
  let weightedTotal = 0;
  let criteriaFailed = 0;
  let criteriaReview = 0;

  for (const entry of criteria.values()) {
    weightedTotal += entry.weight;
    if (entry.failed) {
      criteriaFailed += 1;
    } else if (entry.needsReview) {
      // axe could not decide without a human. Counting it as a failure would
      // overstate the problem; ignoring it would hide it. Half credit.
      criteriaReview += 1;
      weightedMet += entry.weight / 2;
    } else {
      weightedMet += entry.weight;
    }
  }

  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const rule of violations) {
    const impact = IMPACT_RANK[rule.impact] !== undefined ? rule.impact : 'minor';
    counts[impact] += countNodes(rule);
  }

  // A site with nothing to check is not a 100 — it is unscored.
  const score = weightedTotal === 0 ? null : clamp(Math.round((weightedMet / weightedTotal) * 100));

  return {
    score,
    weightedMet: Math.round(weightedMet * 10) / 10,
    weightedTotal,
    criteriaEvaluated: criteria.size,
    criteriaFailed,
    criteriaReview,
    criteriaMet: criteria.size - criteriaFailed - criteriaReview,
    /** Failing success criteria, e.g. ["1.1.1", "1.4.3"] — what a demand letter cites. */
    failedCriteria: [...criteria.entries()]
      .filter(([key, v]) => v.failed && !key.startsWith('rule:'))
      .map(([key]) => key)
      .sort(),
    counts,
    /** Element-level totals: the size of the remediation job, not the score. */
    violationsTotal: Object.values(counts).reduce((a, b) => a + b, 0),
    rulesFailed: violations.length,
    rulesPassed: passes.length,
    rulesIncomplete: incomplete.length,
  };
}

/**
 * On-page SEO checklist. Each entry is scored 1 (pass), 0.5 (partial) or 0 and
 * multiplied by its weight. Signals chosen because they are (a) measurable from
 * one page load and (b) genuinely actionable — no vanity metrics.
 */
export const SEO_CHECKS = [
  { id: 'title',        weight: 3, label: 'Page title present and well-sized' },
  { id: 'description',  weight: 3, label: 'Meta description present and well-sized' },
  { id: 'h1',           weight: 3, label: 'Exactly one H1' },
  { id: 'headings',     weight: 2, label: 'Heading levels in order' },
  { id: 'imageAlt',     weight: 3, label: 'Images carry alt text' },
  { id: 'canonical',    weight: 2, label: 'Canonical URL declared' },
  { id: 'lang',         weight: 2, label: 'Page language declared' },
  { id: 'viewport',     weight: 2, label: 'Mobile viewport configured' },
  { id: 'structured',   weight: 2, label: 'Structured data (JSON-LD) present' },
  { id: 'openGraph',    weight: 1, label: 'Open Graph tags for sharing' },
  { id: 'https',        weight: 2, label: 'Served over HTTPS' },
  { id: 'indexable',    weight: 3, label: 'Page is indexable (no noindex)' },
  { id: 'linkText',     weight: 2, label: 'Links have descriptive text' },
  { id: 'favicon',      weight: 1, label: 'Favicon declared' },
];

export function scoreSeo(signals = {}) {
  const results = [];
  let earned = 0;
  let possible = 0;

  for (const check of SEO_CHECKS) {
    const raw = signals[check.id];
    const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
    const score = value === true ? 1 : value === 'partial' ? 0.5 : 0;
    earned += score * check.weight;
    possible += check.weight;
    results.push({
      id: check.id,
      label: check.label,
      weight: check.weight,
      status: score === 1 ? 'pass' : score === 0.5 ? 'partial' : 'fail',
      detail: (typeof raw === 'object' && raw !== null ? raw.detail : null) ?? null,
    });
  }

  return {
    score: possible === 0 ? null : clamp(Math.round((earned / possible) * 100)),
    checks: results,
    passed: results.filter((r) => r.status === 'pass').length,
    total: results.length,
  };
}

export const OVERALL_WEIGHTS = { accessibility: 0.6, seo: 0.4 };

export function scoreOverall(a11yScore, seoScore) {
  if (a11yScore == null && seoScore == null) return null;
  if (a11yScore == null) return seoScore;
  if (seoScore == null) return a11yScore;
  return clamp(Math.round(a11yScore * OVERALL_WEIGHTS.accessibility + seoScore * OVERALL_WEIGHTS.seo));
}

/** Plain-English band used for the headline and the PDF cover. */
export function band(score) {
  if (score == null) return { label: 'Not scored', tone: 'neutral' };
  if (score >= 90) return { label: 'Strong', tone: 'good' };
  if (score >= 75) return { label: 'Fair', tone: 'ok' };
  if (score >= 50) return { label: 'At risk', tone: 'warn' };
  return { label: 'High risk', tone: 'bad' };
}

/**
 * Rank failing rules for display: severity first, then how widespread the
 * failure is, then conformance level. A buyer should see the thing that will
 * get them sued at the top.
 */
export function rankIssues(violations = [], limit = Infinity) {
  return [...violations]
    .map((rule) => ({
      id: rule.id,
      impact: IMPACT_RANK[rule.impact] !== undefined ? rule.impact : 'minor',
      help: rule.help,
      description: rule.description,
      helpUrl: rule.helpUrl,
      nodes: countNodes(rule),
      criteria: wcagCriteria(rule.tags),
      level: conformanceLevel(rule.tags),
      sample: (rule.nodes ?? []).slice(0, 3).map((n) => ({
        target: Array.isArray(n.target) ? n.target.join(' ') : String(n.target ?? ''),
        snippet: typeof n.html === 'string' ? n.html.slice(0, 300) : '',
        summary: n.failureSummary ?? null,
      })),
    }))
    .sort((a, b) => {
      const byImpact = IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact];
      if (byImpact !== 0) return byImpact;
      if (b.nodes !== a.nodes) return b.nodes - a.nodes;
      return a.level.localeCompare(b.level);
    })
    .slice(0, limit);
}

/**
 * Merge axe results from several pages into one result set, deduplicating by
 * rule and concatenating nodes, so a 3-page crawl does not triple-count a
 * sitewide header problem as three unrelated issues.
 */
export function mergeAxeResults(pages = []) {
  const merge = (key) => {
    const byRule = new Map();
    for (const page of pages) {
      for (const rule of page[key] ?? []) {
        const existing = byRule.get(rule.id);
        if (!existing) {
          byRule.set(rule.id, { ...rule, nodes: [...(rule.nodes ?? [])], nodeCount: countNodes(rule) });
        } else {
          // Populations add across pages; the display sample stays capped.
          existing.nodeCount += countNodes(rule);
          for (const node of rule.nodes ?? []) {
            if (existing.nodes.length < 8) existing.nodes.push(node);
          }
          // Keep the most severe impact seen for the rule across pages.
          if (IMPACT_RANK[rule.impact] < IMPACT_RANK[existing.impact]) existing.impact = rule.impact;
        }
      }
    }
    return [...byRule.values()];
  };
  return { violations: merge('violations'), passes: merge('passes'), incomplete: merge('incomplete') };
}

export default {
  scoreAccessibility, scoreSeo, scoreOverall, band, rankIssues,
  mergeAxeResults, ruleWeight, wcagCriteria, conformanceLevel, SEO_CHECKS, OVERALL_WEIGHTS,
};
