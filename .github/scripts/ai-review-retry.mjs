import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_OWNERS = ['asabon', 'asabon-lab'];
const DEFAULT_COOLDOWN_MINUTES = 55;
const LABEL_SKIPPED = 'ai: skipped';
const LABEL_CHANGES_REQUESTED = 'ai: changes-requested';
const TRIGGER_COMMENT_BODY = '@coderabbitai review';

/**
 * ISO 8601 日時文字列をエポックミリ秒に変換する。無効な場合は 0 を返す。
 * @param {string | null | undefined} isoDate
 * @returns {number}
 */
export function parseTimestampMs(isoDate) {
  if (!isoDate) return 0;
  const ms = Date.parse(isoDate);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 配列の中から指定のタイムスタンプ取得関数で最大値（ミリ秒）を返す。
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string | null | undefined} getTimestamp
 * @returns {number}
 */
function getLatestTimestampMs(items, getTimestamp) {
  let latest = 0;
  for (const item of items) {
    const ms = parseTimestampMs(getTimestamp(item));
    if (ms > latest) latest = ms;
  }
  return latest;
}

/**
 * 直近の AI アクティビティの最大タイムスタンプとその発生元を特定する。
 * @param {{ lastTriggerMs: number, lastCrCommentMs: number, lastCrReviewMs: number }} timestamps
 * @returns {{ latestAiMs: number, latestAiSource: 'trigger' | 'cr_comment' | 'cr_review' | 'none' }}
 */
function resolveLatestAiActivity({ lastTriggerMs, lastCrCommentMs, lastCrReviewMs }) {
  const candidates = [
    { source: /** @type {const} */ ('cr_review'), ms: lastCrReviewMs },
    { source: /** @type {const} */ ('cr_comment'), ms: lastCrCommentMs },
    { source: /** @type {const} */ ('trigger'), ms: lastTriggerMs },
  ];

  let latestAiMs = 0;
  /** @type {'trigger' | 'cr_comment' | 'cr_review' | 'none'} */
  let latestAiSource = 'none';

  for (const candidate of candidates) {
    if (candidate.ms > latestAiMs) {
      latestAiMs = candidate.ms;
      latestAiSource = candidate.source;
    }
  }

  return { latestAiMs, latestAiSource };
}

/**
 * PR の現在の状態からレビュー再キックを実行すべきか判定する。
 *
 * @param {object} params
 * @param {string[]} params.labels
 * @param {string | null | undefined} params.latestCommitDate
 * @param {Array<{ user?: { login?: string }, body?: string, created_at?: string }>} params.comments
 * @param {Array<{ user?: { login?: string }, submitted_at?: string }>} params.reviews
 * @param {number} [params.nowMs]
 * @param {number} [params.cooldownMinutes]
 * @returns {{
 *   shouldTrigger: boolean,
 *   reason: string,
 *   diagnostics: {
 *     labels: string[],
 *     latestCommitIso: string,
 *     latestAiIso: string,
 *     latestAiSource: 'trigger' | 'cr_comment' | 'cr_review' | 'none',
 *     cooldownElapsedMin: number | null,
 *   }
 * }}
 */
export function evaluatePrRetry({
  labels,
  latestCommitDate,
  comments,
  reviews,
  nowMs = Date.now(),
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
}) {
  const hasSkipped = labels.includes(LABEL_SKIPPED);
  const hasChangesRequested = labels.includes(LABEL_CHANGES_REQUESTED);
  const latestCommitMs = parseTimestampMs(latestCommitDate);

  const triggerComments = comments.filter((c) =>
    (c.body ?? '').includes(TRIGGER_COMMENT_BODY),
  );
  const crComments = comments.filter((c) =>
    /coderabbitai/i.test(c.user?.login ?? ''),
  );
  const crReviews = reviews.filter((r) =>
    /coderabbitai/i.test(r.user?.login ?? ''),
  );

  const lastTriggerMs = getLatestTimestampMs(triggerComments, (c) => c.created_at);
  const lastCrCommentMs = getLatestTimestampMs(crComments, (c) => c.created_at);
  const lastCrReviewMs = getLatestTimestampMs(crReviews, (r) => r.submitted_at);
  const { latestAiMs, latestAiSource } = resolveLatestAiActivity({
    lastTriggerMs,
    lastCrCommentMs,
    lastCrReviewMs,
  });

  const cooldownElapsedMin =
    latestAiMs > 0 ? Math.floor((nowMs - latestAiMs) / 60000) : null;

  const diagnostics = {
    labels,
    latestCommitIso: latestCommitMs > 0 ? new Date(latestCommitMs).toISOString() : 'none',
    latestAiIso: latestAiMs > 0 ? new Date(latestAiMs).toISOString() : 'none',
    latestAiSource,
    cooldownElapsedMin,
  };

  // ai: changes-requested が付いており、かつ ai: skipped でない場合:
  // 直近の AI レビュー以降に新しいコミットがプッシュされていなければスキップ（修正待ち）
  if (hasChangesRequested && !hasSkipped) {
    if (latestAiMs > 0 && latestCommitMs <= latestAiMs) {
      return {
        shouldTrigger: false,
        reason: 'Skipping: No new commits pushed since last review/trigger (waiting for user changes).',
        diagnostics,
      };
    }
  }

  // フェイルセーフ: ラベルが ai: skipped のまま等であっても、直近の CodeRabbit コメントが
  // 「すでに最新コミットをレビュー済み」を示しており、新コミットがなければスキップ
  const lastCrComment = crComments.at(-1);
  if (
    lastCrComment?.body &&
    /already reviewed the last commit/i.test(lastCrComment.body) &&
    latestAiMs > 0 &&
    latestCommitMs <= latestAiMs
  ) {
    return {
      shouldTrigger: false,
      reason: 'Skipping: CodeRabbit already reviewed the last commit (waiting for new commits).',
      diagnostics,
    };
  }

  // クールダウン判定（直近の AI アクティビティから指定分数未満の場合はスキップ）
  const cooldownMs = cooldownMinutes * 60 * 1000;
  if (latestAiMs > 0) {
    const diffMs = nowMs - latestAiMs;
    if (diffMs < cooldownMs) {
      return {
        shouldTrigger: false,
        reason: `Skipping: Last AI activity was only ${cooldownElapsedMin}m ago (Cooldown: ${cooldownMinutes}m).`,
        diagnostics,
      };
    }
  }

  const reason =
    hasChangesRequested && !hasSkipped
      ? 'Detected new commit(s) after last review for changes-requested PR.'
      : 'Eligible for review retry.';

  return { shouldTrigger: true, reason, diagnostics };
}

/**
 * GitHub Actions の Job Summary 向け Markdown テーブルを生成する。
 * @param {object} params
 * @param {string} params.runAtIso
 * @param {number} params.cooldownMinutes
 * @param {Array<{
 *   repo: string,
 *   number: number,
 *   action: 'Triggered' | 'Skipped' | 'Deferred',
 *   labels?: string[],
 *   latestCommitIso?: string,
 *   latestAiIso?: string,
 *   latestAiSource?: string,
 *   cooldownElapsedMin?: number | null,
 *   reason: string,
 *   commentUrl?: string,
 * }>} params.records
 * @returns {string}
 */
export function buildSummaryMarkdown({ runAtIso, cooldownMinutes, records }) {
  const lines = [
    '## AI Review Retry Orchestrator Summary',
    '',
    `- **Run at (UTC)**: \`${runAtIso}\``,
    `- **Cooldown**: \`${cooldownMinutes}m\``,
    `- **Candidate PRs found**: \`${records.length}\``,
    '',
  ];

  if (records.length === 0) {
    lines.push('No target PRs were found across configured owners.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    '| PR | Labels | Latest Commit | Latest AI (Source) | Result | Reason |',
  );
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');

  for (const rec of records) {
    const prLink = `[${rec.repo}#${rec.number}](https://github.com/${rec.repo}/pull/${rec.number})`;
    const labelsText = rec.labels?.length ? rec.labels.map((l) => `\`${l}\``).join(', ') : '-';
    const commitText = rec.latestCommitIso ? `\`${rec.latestCommitIso}\`` : '-';
    const aiText =
      rec.latestAiIso && rec.latestAiIso !== 'none'
        ? `\`${rec.latestAiIso}\` (${rec.latestAiSource}, ${rec.cooldownElapsedMin ?? '?'}m ago)`
        : rec.latestAiIso === 'none'
          ? '`none`'
          : '-';
    const resultText =
      rec.action === 'Triggered' && rec.commentUrl
        ? `[Triggered](${rec.commentUrl})`
        : rec.action;
    const escapedReason = rec.reason.replace(/\|/g, '\\|');

    lines.push(
      `| ${prLink} | ${labelsText} | ${commitText} | ${aiText} | ${resultText} | ${escapedReason} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * gh CLI を実行して標準出力を返す。
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

/**
 * gh CLI で JSON レスポンスを取得する。
 * @param {string[]} args
 * @returns {any}
 */
function runGhJson(args) {
  const output = runGh(args);
  return output ? JSON.parse(output) : null;
}

/**
 * 指定オーナー配下の対象オープン PR（重複排除済み）を検索する。
 * @param {string} owner
 * @returns {Array<{ repo: string, number: number }>}
 */
function searchTargetPrs(owner) {
  const seen = new Set();
  const targets = [];

  for (const label of [LABEL_SKIPPED, LABEL_CHANGES_REQUESTED]) {
    const prs =
      runGhJson([
        'search',
        'prs',
        '--owner',
        owner,
        '--state',
        'open',
        '--label',
        label,
        '--json',
        'repository,number',
      ]) ?? [];

    for (const pr of prs) {
      const repo = pr.repository?.nameWithOwner;
      const number = pr.number;
      if (!repo || !number) continue;
      const key = `${repo}#${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ repo, number });
    }
  }

  return targets.sort((a, b) =>
    `${a.repo}#${a.number}`.localeCompare(`${b.repo}#${b.number}`),
  );
}

/**
 * ページネーションを考慮して GitHub REST API から配列を全件取得する。
 * @param {string} endpoint
 * @returns {any[]}
 */
function fetchPaginatedArray(endpoint) {
  const pages = runGhJson(['api', '--paginate', '--slurp', endpoint]) ?? [];
  return Array.isArray(pages) ? pages.flat() : [];
}

/**
 * メイン処理
 */
export function main() {
  if (!process.env.GH_TOKEN) {
    console.error('Error: ORG_REVIEW_TRIGGER_PAT secret is not configured.');
    process.exit(1);
  }

  const parsedCooldown = Number(process.env.COOLDOWN_MINUTES);
  const cooldownMinutes =
    Number.isFinite(parsedCooldown) && parsedCooldown > 0
      ? parsedCooldown
      : DEFAULT_COOLDOWN_MINUTES;
  const nowMs = Date.now();
  const runAtIso = new Date(nowMs).toISOString();

  /** @type {Array<{ repo: string, number: number }>} */
  const allCandidates = [];

  for (const owner of DEFAULT_OWNERS) {
    console.log('==================================================');
    console.log(
      `Searching open PRs with '${LABEL_SKIPPED}' or '${LABEL_CHANGES_REQUESTED}' in: ${owner}`,
    );
    console.log('==================================================');

    const prList = searchTargetPrs(owner);
    if (prList.length === 0) {
      console.log(`No target PRs found for ${owner}.`);
      continue;
    }

    console.log(
      `Found ${prList.length} candidate PR(s) for ${owner}: ${prList.map((p) => `${p.repo}#${p.number}`).join(', ')}`,
    );
    allCandidates.push(...prList);
  }

  /** @type {Parameters<typeof buildSummaryMarkdown>[0]['records']} */
  const records = [];
  let triggered = false;

  for (const { repo, number } of allCandidates) {
    if (triggered) {
      records.push({
        repo,
        number,
        action: 'Deferred',
        reason: 'Deferred to preserve 1-review-per-hour rate limit.',
      });
      continue;
    }

    console.log(`--- Checking ${repo} #${number} ---`);

    const prData =
      runGhJson([
        'pr',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'labels,commits',
      ]) ?? {};

    const labels = (prData.labels ?? []).map((l) => l.name);
    const latestCommitDate = prData.commits?.at(-1)?.committedDate ?? null;

    const comments = fetchPaginatedArray(`repos/${repo}/issues/${number}/comments`);
    const reviews = fetchPaginatedArray(`repos/${repo}/pulls/${number}/reviews`);

    const result = evaluatePrRetry({
      labels,
      latestCommitDate,
      comments,
      reviews,
      nowMs,
      cooldownMinutes,
    });

    const { diagnostics } = result;
    const elapsedStr =
      diagnostics.cooldownElapsedMin !== null
        ? `${diagnostics.cooldownElapsedMin}m ago`
        : 'n/a';
    console.log(`  Labels: ${diagnostics.labels.join(', ') || '(none)'}`);
    console.log(`  Latest commit: ${diagnostics.latestCommitIso}`);
    console.log(
      `  Latest AI activity: ${diagnostics.latestAiIso} (source: ${diagnostics.latestAiSource}, elapsed: ${elapsedStr})`,
    );

    if (!result.shouldTrigger) {
      console.log(`  Decision: ${result.reason}`);
      records.push({
        repo,
        number,
        action: 'Skipped',
        ...diagnostics,
        reason: result.reason,
      });
      continue;
    }

    if (result.reason !== 'Eligible for review retry.') {
      console.log(`  Note: ${result.reason}`);
    }

    console.log(`  Triggering review for ${repo} #${number}...`);
    const commentUrl = runGh([
      'pr',
      'comment',
      String(number),
      '--repo',
      repo,
      '--body',
      TRIGGER_COMMENT_BODY,
    ]);
    if (commentUrl) {
      console.log(`  Comment URL: ${commentUrl}`);
    }

    console.log(
      `Successfully triggered review for ${repo} #${number}. Stopping further triggers to preserve hourly rate limit.`,
    );
    records.push({
      repo,
      number,
      action: 'Triggered',
      ...diagnostics,
      reason: result.reason,
      commentUrl,
    });
    triggered = true;
  }

  if (!triggered) {
    console.log('No PRs were eligible for review retry in this run.');
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const markdown = buildSummaryMarkdown({
      runAtIso,
      cooldownMinutes,
      records,
    });
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
