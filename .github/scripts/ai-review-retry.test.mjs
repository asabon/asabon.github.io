import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSummaryMarkdown,
  evaluatePrRetry,
  parseTimestampMs,
} from './ai-review-retry.mjs';

const MIN = 60 * 1000;
const BASE_TIME = Date.parse('2026-11-18T06:00:00Z');

function isoAt(offsetMin) {
  return new Date(BASE_TIME + offsetMin * MIN).toISOString();
}

test('parseTimestampMs handles valid, null, and invalid inputs', () => {
  assert.equal(parseTimestampMs('2026-11-18T06:00:00Z'), BASE_TIME);
  assert.equal(parseTimestampMs(null), 0);
  assert.equal(parseTimestampMs(undefined), 0);
  assert.equal(parseTimestampMs('invalid-date'), 0);
});

test('triggers when ai: skipped has no prior AI activity', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-120),
    comments: [],
    reviews: [],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, true);
  assert.equal(result.diagnostics.latestAiSource, 'none');
  assert.equal(result.diagnostics.cooldownElapsedMin, null);
});

test('skips when last AI activity is within cooldown window', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-120),
    comments: [
      {
        user: { login: 'asabon' },
        body: '@coderabbitai review',
        created_at: isoAt(-30),
      },
    ],
    reviews: [],
    nowMs: BASE_TIME,
    cooldownMinutes: 55,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /30m ago/);
  assert.equal(result.diagnostics.latestAiSource, 'trigger');
  assert.equal(result.diagnostics.cooldownElapsedMin, 30);
});

test('triggers when ai: skipped (rate limited) has passed cooldown', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-120),
    comments: [
      {
        user: { login: 'coderabbitai[bot]' },
        body: 'Review skipped due to rate limit.',
        created_at: isoAt(-60),
      },
    ],
    reviews: [],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, true);
  assert.equal(result.diagnostics.latestAiSource, 'cr_comment');
  assert.equal(result.diagnostics.cooldownElapsedMin, 60);
});

test('failsafe skips when ai: skipped has "Already reviewed" and no new commits', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-120),
    comments: [
      {
        user: { login: 'coderabbitai' },
        body: 'Already reviewed the last commit. Use `@coderabbitai full review` to rerun.',
        created_at: isoAt(-60),
      },
    ],
    reviews: [],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /already reviewed the last commit/i);
});

test('triggers when "Already reviewed" is followed by a newer commit and cooldown passed', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-60),
    comments: [
      {
        user: { login: 'coderabbitai' },
        body: 'Already reviewed the last commit.',
        created_at: isoAt(-90),
      },
    ],
    reviews: [],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, true);
});

test('failsafe skips when ai: skipped has a CodeRabbit review after latest commit', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-180),
    comments: [
      {
        user: { login: 'coderabbitai' },
        body: 'Review finished.',
        created_at: isoAt(-175),
      },
    ],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-170),
      },
    ],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /CodeRabbit review already exists/);
  assert.equal(result.diagnostics.latestAiSource, 'cr_review');
});

test('triggers when ai: skipped has an older CodeRabbit review followed by a newer commit', () => {
  const result = evaluatePrRetry({
    labels: ['ai: skipped'],
    latestCommitDate: isoAt(-60),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-120),
      },
    ],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, true);
});

test('skips ai: changes-requested when no new commits pushed after review', () => {
  const result = evaluatePrRetry({
    labels: ['ai: changes-requested'],
    latestCommitDate: isoAt(-120),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-90),
      },
    ],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /No new commits pushed/);
  assert.equal(result.diagnostics.latestAiSource, 'cr_review');
});

test('skips ai: changes-requested with new commit if still in cooldown', () => {
  const result = evaluatePrRetry({
    labels: ['ai: changes-requested'],
    latestCommitDate: isoAt(-20),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-40),
      },
    ],
    nowMs: BASE_TIME,
    cooldownMinutes: 55,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /40m ago/);
});

test('triggers ai: changes-requested when new commit exists and cooldown passed', () => {
  const result = evaluatePrRetry({
    labels: ['ai: changes-requested'],
    latestCommitDate: isoAt(-30),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-90),
      },
    ],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, true);
  assert.match(result.reason, /Detected new commit/);
});

test('skips ai: not-reviewed when latest commit is within commit grace period', () => {
  const result = evaluatePrRetry({
    labels: ['ai: not-reviewed'],
    latestCommitDate: isoAt(-3),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-120),
      },
    ],
    nowMs: BASE_TIME,
    commitGraceMinutes: 10,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /Latest commit was only 3m ago/);
});

test('triggers ai: not-reviewed when commit grace period and cooldown passed', () => {
  const result = evaluatePrRetry({
    labels: ['ai: not-reviewed'],
    latestCommitDate: isoAt(-20),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-120),
      },
    ],
    nowMs: BASE_TIME,
    commitGraceMinutes: 10,
  });
  assert.equal(result.shouldTrigger, true);
});

test('skips ai: not-reviewed if CodeRabbit review already exists after latest commit', () => {
  const result = evaluatePrRetry({
    labels: ['ai: not-reviewed'],
    latestCommitDate: isoAt(-60),
    comments: [],
    reviews: [
      {
        user: { login: 'coderabbitai' },
        submitted_at: isoAt(-30),
      },
    ],
    nowMs: BASE_TIME,
  });
  assert.equal(result.shouldTrigger, false);
  assert.match(result.reason, /CodeRabbit review already exists/);
});

test('buildSummaryMarkdown formats empty and populated records cleanly', () => {
  const emptyMd = buildSummaryMarkdown({
    runAtIso: '2026-11-20T06:00:00.000Z',
    cooldownMinutes: 55,
    records: [],
  });
  assert.match(emptyMd, /Candidate PRs found\*\*: `0`/);
  assert.match(emptyMd, /No target PRs were found/);

  const populatedMd = buildSummaryMarkdown({
    runAtIso: '2026-11-20T06:00:00.000Z',
    cooldownMinutes: 55,
    records: [
      {
        repo: 'asabon/vajra',
        number: 6,
        action: 'Skipped',
        labels: ['ai: changes-requested'],
        latestCommitIso: '2026-11-19T00:00:00.000Z',
        latestAiIso: '2026-11-19T01:00:00.000Z',
        latestAiSource: 'cr_review',
        cooldownElapsedMin: 1800,
        reason: 'Skipping: No new commits pushed.',
      },
      {
        repo: 'asabon/agq-hud',
        number: 10,
        action: 'Triggered',
        labels: ['ai: skipped'],
        latestCommitIso: '2026-11-20T04:00:00.000Z',
        latestAiIso: 'none',
        latestAiSource: 'none',
        cooldownElapsedMin: null,
        reason: 'Eligible for review retry.',
        commentUrl: 'https://github.com/asabon/agq-hud/pull/10#issuecomment-1',
      },
      {
        repo: 'asabon/other',
        number: 2,
        action: 'Deferred',
        reason: 'Deferred to preserve 1-review-per-hour rate limit.',
      },
    ],
  });

  assert.match(populatedMd, /\[asabon\/vajra#6\]/);
  assert.match(populatedMd, /\[Triggered\]\(https:\/\/github\.com\/asabon\/agq-hud\/pull\/10#issuecomment-1\)/);
  assert.match(populatedMd, /\| Deferred \|/);
});
