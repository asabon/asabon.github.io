import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePrRetry, parseTimestampMs } from './ai-review-retry.mjs';

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
