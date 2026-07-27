import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreAccessibility, scoreSeo, scoreOverall, band, rankIssues,
  mergeAxeResults, ruleWeight, wcagCriteria, conformanceLevel,
} from '../../server/lib/scoring.js';

const rule = (id, { tags = [], impact = 'serious', nodeCount = 1, nodes } = {}) => ({
  id, tags, impact, help: `${id} help`, description: `${id} description`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.12/${id}`,
  nodeCount,
  nodes: nodes ?? Array.from({ length: Math.min(nodeCount, 8) }, (_, i) => ({
    target: [`#n${i}`], html: `<div id="n${i}">`, failureSummary: 'Fix this',
  })),
});

test('conformance level drives rule weight', () => {
  assert.equal(ruleWeight(['wcag2a', 'cat.text-alternatives']), 3);
  assert.equal(ruleWeight(['wcag2aa']), 2);
  assert.equal(ruleWeight(['wcag21aa']), 2);
  assert.equal(ruleWeight(['wcag22aa']), 2);
  assert.equal(ruleWeight(['best-practice']), 1);
  assert.equal(ruleWeight([]), 1);
});

test('WCAG criterion tags are decoded', () => {
  assert.deepEqual(wcagCriteria(['wcag143', 'wcag2aa', 'cat.color']), ['1.4.3']);
  assert.deepEqual(wcagCriteria(['wcag111', 'wcag412']), ['1.1.1', '4.1.2']);
  assert.deepEqual(wcagCriteria(['best-practice']), []);
  assert.equal(conformanceLevel(['wcag2a']), 'A');
  assert.equal(conformanceLevel(['wcag22aa']), 'AA');
  assert.equal(conformanceLevel(['best-practice']), 'Best practice');
});

test('a clean page scores 100 and a fully failing page scores 0', () => {
  const clean = scoreAccessibility({
    passes: [rule('image-alt', { tags: ['wcag2a', 'wcag111'], nodeCount: 40 })],
    violations: [], incomplete: [],
  });
  assert.equal(clean.score, 100);
  assert.deepEqual(clean.failedCriteria, []);

  const broken = scoreAccessibility({
    passes: [], incomplete: [],
    violations: [rule('image-alt', { tags: ['wcag2a', 'wcag111'], impact: 'critical', nodeCount: 40 })],
  });
  assert.equal(broken.score, 0);
  assert.equal(broken.counts.critical, 40, 'element count still reports the size of the job');
  assert.deepEqual(broken.failedCriteria, ['1.1.1']);
});

test('a failed criterion is not offset by unrelated passing markup', () => {
  // The defect this model replaces: thousands of passing elements used to drag
  // a page with no alt text up to ~75.
  const result = scoreAccessibility({
    passes: [
      rule('aria-valid-attr', { tags: ['wcag2a', 'wcag412'], nodeCount: 5000 }),
      rule('color-contrast', { tags: ['wcag2aa', 'wcag143'], nodeCount: 3000 }),
    ],
    violations: [rule('image-alt', { tags: ['wcag2a', 'wcag111'], impact: 'critical', nodeCount: 5 })],
    incomplete: [],
  });
  // Criteria: 4.1.2 met (3), 1.4.3 met (2), 1.1.1 failed (3) -> 5/8
  assert.equal(result.score, 63);
  assert.equal(result.criteriaFailed, 1);
  assert.deepEqual(result.failedCriteria, ['1.1.1']);
});

test('several rules testing one criterion count as one criterion', () => {
  const oneRule = scoreAccessibility({
    passes: [rule('link-name', { tags: ['wcag2a', 'wcag244'], nodeCount: 10 })],
    violations: [rule('image-alt', { tags: ['wcag2a', 'wcag111'], nodeCount: 1 })],
    incomplete: [],
  });
  const threeRulesSameCriterion = scoreAccessibility({
    passes: [rule('link-name', { tags: ['wcag2a', 'wcag244'], nodeCount: 10 })],
    violations: [
      rule('image-alt', { tags: ['wcag2a', 'wcag111'], nodeCount: 1 }),
      rule('input-image-alt', { tags: ['wcag2a', 'wcag111'], nodeCount: 1 }),
      rule('area-alt', { tags: ['wcag2a', 'wcag111'], nodeCount: 1 }),
    ],
    incomplete: [],
  });
  assert.equal(
    oneRule.score, threeRulesSameCriterion.score,
    'failing 1.1.1 three different ways is still failing 1.1.1 once',
  );
  assert.deepEqual(threeRulesSameCriterion.failedCriteria, ['1.1.1']);
});

test('element population drives the remediation figure, not the score', () => {
  const few = scoreAccessibility({
    passes: [rule('link-name', { tags: ['wcag2a', 'wcag244'], nodeCount: 10 })],
    violations: [rule('color-contrast', { tags: ['wcag2aa', 'wcag143'], impact: 'serious', nodeCount: 3 })],
    incomplete: [],
  });
  const many = scoreAccessibility({
    passes: [rule('link-name', { tags: ['wcag2a', 'wcag244'], nodeCount: 10 })],
    violations: [rule('color-contrast', { tags: ['wcag2aa', 'wcag143'], impact: 'serious', nodeCount: 900 })],
    incomplete: [],
  });
  assert.equal(few.score, many.score, 'conformance is binary per criterion');
  assert.equal(few.violationsTotal, 3);
  assert.equal(many.violationsTotal, 900, 'but the size of the job is reported honestly');
});

test('level A failures cost more than level AA failures', () => {
  const failA = scoreAccessibility({
    passes: [rule('p', { tags: ['wcag2aa', 'wcag143'], nodeCount: 100 })],
    violations: [rule('a', { tags: ['wcag2a', 'wcag111'], nodeCount: 50 })],
    incomplete: [],
  });
  const failAA = scoreAccessibility({
    passes: [rule('p', { tags: ['wcag2a', 'wcag111'], nodeCount: 100 })],
    violations: [rule('a', { tags: ['wcag2aa', 'wcag143'], nodeCount: 50 })],
    incomplete: [],
  });
  assert.ok(failA.score < failAA.score, 'a Level A failure must hurt more');
});

test('items needing human review count half', () => {
  const result = scoreAccessibility({
    passes: [], violations: [],
    incomplete: [rule('color-contrast', { tags: ['wcag2aa', 'wcag143'], nodeCount: 10 })],
  });
  assert.equal(result.score, 50);
  assert.equal(result.criteriaReview, 1);
  assert.equal(result.rulesIncomplete, 1);
});

test('best-practice rules count but do not masquerade as conformance failures', () => {
  const result = scoreAccessibility({
    passes: [rule('x', { tags: ['wcag2a', 'wcag111'], nodeCount: 1 })],
    violations: [rule('region', { tags: ['best-practice'], impact: 'moderate', nodeCount: 14 })],
    incomplete: [],
  });
  assert.equal(result.criteriaFailed, 1);
  assert.deepEqual(result.failedCriteria, [], 'no WCAG criterion is reported as failed');
  assert.equal(result.score, 75, 'weight 1 against a weight-3 Level A pass');
});

test('nothing measurable yields null rather than a flattering 100', () => {
  assert.equal(scoreAccessibility({ passes: [], violations: [], incomplete: [] }).score, null);
});

test('SEO checklist scores and reports per-signal status', () => {
  const perfect = scoreSeo({
    title: true, description: true, h1: true, headings: true, imageAlt: true,
    canonical: true, lang: true, viewport: true, structured: true, openGraph: true,
    https: true, indexable: true, linkText: true, favicon: true,
  });
  assert.equal(perfect.score, 100);
  assert.equal(perfect.passed, perfect.total);

  const empty = scoreSeo({});
  assert.equal(empty.score, 0);

  const partial = scoreSeo({ title: { value: 'partial', detail: '12 characters' } });
  const titleCheck = partial.checks.find((c) => c.id === 'title');
  assert.equal(titleCheck.status, 'partial');
  assert.equal(titleCheck.detail, '12 characters');
});

test('overall blends 60/40 and tolerates a missing half', () => {
  assert.equal(scoreOverall(100, 100), 100);
  assert.equal(scoreOverall(50, 100), 70);
  assert.equal(scoreOverall(80, null), 80);
  assert.equal(scoreOverall(null, 80), 80);
  assert.equal(scoreOverall(null, null), null);
});

test('bands describe the score in words', () => {
  assert.equal(band(95).label, 'Strong');
  assert.equal(band(80).label, 'Fair');
  assert.equal(band(60).label, 'At risk');
  assert.equal(band(20).label, 'High risk');
  assert.equal(band(null).label, 'Not scored');
});

test('issues rank most severe and most widespread first', () => {
  const ranked = rankIssues([
    rule('minor-thing', { impact: 'minor', nodeCount: 100, tags: ['best-practice'] }),
    rule('contrast', { impact: 'serious', nodeCount: 5, tags: ['wcag2aa', 'wcag143'] }),
    rule('no-alt', { impact: 'critical', nodeCount: 2, tags: ['wcag2a', 'wcag111'] }),
    rule('contrast-more', { impact: 'serious', nodeCount: 50, tags: ['wcag2aa'] }),
  ]);
  assert.deepEqual(ranked.map((r) => r.id), ['no-alt', 'contrast-more', 'contrast', 'minor-thing']);
  assert.deepEqual(ranked[0].criteria, ['1.1.1']);
  assert.equal(ranked[0].level, 'A');
  assert.ok(ranked[0].sample.length > 0, 'samples survive ranking');
  assert.ok(ranked[0].sample[0].snippet.includes('<div'));
});

test('merging pages sums populations without triple-counting a sitewide issue', () => {
  const merged = mergeAxeResults([
    { violations: [rule('color-contrast', { impact: 'serious', nodeCount: 10, tags: ['wcag2aa'] })], passes: [], incomplete: [] },
    { violations: [rule('color-contrast', { impact: 'critical', nodeCount: 5, tags: ['wcag2aa'] })], passes: [], incomplete: [] },
    { violations: [rule('link-name', { impact: 'serious', nodeCount: 3, tags: ['wcag2a'] })], passes: [], incomplete: [] },
  ]);

  assert.equal(merged.violations.length, 2, 'one entry per rule, not per page');
  const contrast = merged.violations.find((v) => v.id === 'color-contrast');
  assert.equal(contrast.nodeCount, 15, 'populations add up');
  assert.equal(contrast.impact, 'critical', 'worst impact across pages wins');
  assert.ok(contrast.nodes.length <= 8, 'display sample stays capped');
});
