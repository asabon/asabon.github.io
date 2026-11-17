import { execFileSync } from 'node:child_process';
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
 * PR の現在の状態からレビュー再キックを実行すべきか判定する。
 *
 * @param {object} params
 * @param {string[]} params.labels
 * @param {string | null | undefined} params.latestCommitDate
 * @param {Array<{ user?: { login?: string }, body?: string, created_at?: string }>} params.comments
 * @param {Array<{ user?: { login?: string }, submitted_at?: string }>} params.reviews
 * @param {number} [params.nowMs]
 * @param {number} [params.cooldownMinutes]
 * @returns {{ shouldTrigger: boolean, reason: string }}
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
  const latestAiMs = Math.max(lastTriggerMs, lastCrCommentMs, lastCrReviewMs);

  // ai: changes-requested が付いており、かつ ai: skipped でない場合:
  // 直近の AI レビュー以降に新しいコミットがプッシュされていなければスキップ（修正待ち）
  if (hasChangesRequested && !hasSkipped) {
    if (latestAiMs > 0 && latestCommitMs <= latestAiMs) {
      return {
        shouldTrigger: false,
        reason: 'Skipping: No new commits pushed since last review/trigger (waiting for user changes).',
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
    };
  }

  // クールダウン判定（直近の AI アクティビティから指定分数未満の場合はスキップ）
  const cooldownMs = cooldownMinutes * 60 * 1000;
  if (latestAiMs > 0) {
    const diffMs = nowMs - latestAiMs;
    if (diffMs < cooldownMs) {
      const elapsedMin = Math.floor(diffMs / 60000);
      return {
        shouldTrigger: false,
        reason: `Skipping: Last AI activity was only ${elapsedMin}m ago (Cooldown: ${cooldownMinutes}m).`,
      };
    }
  }

  const reason =
    hasChangesRequested && !hasSkipped
      ? 'Detected new commit(s) after last review for changes-requested PR.'
      : 'Eligible for review retry.';

  return { shouldTrigger: true, reason };
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

    for (const { repo, number } of prList) {
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

      if (!result.shouldTrigger) {
        console.log(result.reason);
        continue;
      }

      if (result.reason !== 'Eligible for review retry.') {
        console.log(result.reason);
      }

      console.log(`Triggering review for ${repo} #${number}...`);
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
        console.log(commentUrl);
      }

      // 1時間に1回の上限枠を守るため、1件キックしたら今回の実行は終了
      console.log(
        `Successfully triggered review for ${repo} #${number}. Exiting to preserve hourly rate limit.`,
      );
      return;
    }
  }

  console.log('No PRs were eligible for review retry in this run.');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
