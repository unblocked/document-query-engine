import type { Octokit } from "@octokit/rest";
import { getCollection, getUsersCollection, ensureIndexes, getDb } from "../db.js";
import { parseRepo } from "./client.js";
import { toPullRequestDoc, toIssueDoc } from "./transform.js";
import { UserDoc } from "../models/user.js";

export interface IngestResult {
  pullRequests: number;
  issues: number;
  users: number;
}

/** Bounds on how much to ingest. PRs/issues are walked newest-updated first and we stop at whichever limit hits first. */
export interface IngestOptions {
  /** Stop after this many pull requests. */
  maxPRs?: number;
  /** Stop once items are older (by updated_at) than this date. */
  since?: Date;
  /** When false, ignore the saved checkpoint and re-ingest from `since` (or the start). Default true. */
  resume?: boolean;
}

/** Live progress hooks the CLI renders. ingestRepo calls these as work happens. */
export interface IngestProgress {
  /** Begin a labelled phase (closes any open one). */
  phase(label: string, hint?: string): void;
  /** Advance the current phase's counter by n (default 1). */
  tick(n?: number): void;
  /** Close the current phase. */
  endPhase(): void;
  /** Print a one-off informational line. */
  info(msg: string): void;
}

/** No-op progress, so ingestRepo works without a reporter (tests, scripts). */
const noopProgress: IngestProgress = { phase() {}, tick() {}, endPhase() {}, info() {} };

/** Per-repo high-water mark, so re-runs only fetch what changed since last time. */
const STATE_COLLECTION = "ingest_state";
interface IngestState {
  _id: string; // repo slug
  lastUpdatedAt: string; // newest updated_at ingested so far (ISO)
  ranAt: string;
}

async function readCheckpoint(slug: string): Promise<Date | null> {
  const doc = await (await getDb()).collection<IngestState>(STATE_COLLECTION).findOne({ _id: slug });
  return doc ? new Date(doc.lastUpdatedAt) : null;
}

async function writeCheckpoint(slug: string, lastUpdatedAt: string): Promise<void> {
  await (await getDb()).collection<IngestState>(STATE_COLLECTION).updateOne(
    { _id: slug },
    { $set: { lastUpdatedAt, ranAt: new Date().toISOString() } },
    { upsert: true },
  );
}

/** The later of two optional dates (the more restrictive lower bound). */
function laterDate(a?: Date, b?: Date): Date | undefined {
  if (a && b) return a > b ? a : b;
  return a ?? b;
}

/** The later of two optional ISO strings (ISO sorts lexicographically). */
function laterIso(a: string | null, b: string | null): string | null {
  if (a && b) return a > b ? a : b;
  return a ?? b;
}

/**
 * Fetches a repo's PRs and issues (with reviews/comments) and upserts them into
 * MongoDB keyed on (repo, number) so re-runs are idempotent, then captures
 * contributor display names for name->login resolution.
 *
 * Items are walked newest-updated first and bounded by `opts`: stop at maxPRs or
 * once older than the `since` floor — whichever comes first. The run's newest
 * updated_at is saved as a checkpoint so the next run resumes from there.
 */
export async function ingestRepo(
  gh: Octokit,
  slug: string,
  progress: IngestProgress = noopProgress,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const { owner, repo } = parseRepo(slug);
  progress.info("Ensuring indexes…");
  await ensureIndexes();

  const checkpoint = opts.resume === false ? null : await readCheckpoint(slug);
  if (checkpoint) progress.info(`Resuming from checkpoint · ${checkpoint.toISOString().slice(0, 10)}`);
  const floor = laterDate(opts.since, checkpoint ?? undefined);

  const limits = [opts.maxPRs ? `max ${opts.maxPRs} PRs` : null, floor ? `since ${floor.toISOString().slice(0, 10)}` : null]
    .filter(Boolean)
    .join(" · ");
  if (limits) progress.info(`Limits: ${limits}`);

  const pr = await ingestPullRequests(gh, owner, repo, slug, progress, floor, opts.maxPRs);

  // The issues endpoint returns PRs too, so a repo with Issues disabled would make
  // us page through hundreds of PRs to find zero issues. Skip it when it's off.
  const { data: info } = await gh.repos.get({ owner, repo });
  const iss = info.has_issues
    ? await ingestIssues(gh, owner, repo, slug, progress, floor)
    : (progress.info("Issues disabled on this repo — skipping"), { count: 0, newest: null });

  const userCount = await ingestUsers(gh, slug, progress);

  const newest = laterIso(pr.newest, iss.newest);
  if (newest) await writeCheckpoint(slug, newest);

  return { pullRequests: pr.count, issues: iss.count, users: userCount };
}

/** Captures GitHub display names for every login seen in the repo's PRs/issues. */
async function ingestUsers(gh: Octokit, slug: string, progress: IngestProgress): Promise<number> {
  const prs = await getCollection("pull_requests");
  const issues = await getCollection("issues");
  const paths = ["user.login", "assignees.login", "requested_reviewers.login", "reviews.user.login", "comments.user.login"];

  progress.phase("Users", "resolving display names");
  const logins = new Set<string>();
  for (const col of [prs, issues]) {
    for (const path of paths) {
      const values = (await col.distinct(path, { repo: slug })) as string[];
      values.forEach((v) => v && v !== "ghost" && logins.add(v));
    }
  }
  progress.info(`Found ${logins.size} unique contributors`);

  const users = await getUsersCollection();
  let count = 0;
  for (const login of logins) {
    let name: string | null = null;
    let id = 0;
    try {
      const { data } = await gh.users.getByUsername({ username: login });
      name = data.name ?? null;
      id = data.id;
    } catch {
      // deleted/renamed account — keep the login with no display name
    }
    await users.replaceOne({ login }, UserDoc.parse({ login, id, name }), { upsert: true });
    count++;
    progress.tick();
  }
  progress.endPhase();
  return count;
}

async function ingestPullRequests(
  gh: Octokit,
  owner: string,
  repo: string,
  slug: string,
  progress: IngestProgress,
  floor: Date | undefined,
  maxPRs: number | undefined,
): Promise<{ count: number; newest: string | null }> {
  const col = await getCollection("pull_requests");
  progress.phase("Pull requests", "+ reviews & comments");
  let count = 0;
  let newest: string | null = null;

  // Newest-updated first, so we can stop as soon as we cross the `since`/checkpoint floor.
  outer: for await (const { data: prs } of gh.paginate.iterator(gh.pulls.list, {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  })) {
    for (const pr of prs) {
      if (floor && new Date(pr.updated_at) <= floor) break outer; // reached the boundary
      const [reviews, comments] = await Promise.all([
        gh.paginate(gh.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 }),
        gh.paginate(gh.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 }),
      ]);
      const doc = toPullRequestDoc(slug, pr, reviews, comments);
      await col.replaceOne({ repo: slug, number: doc.number }, doc, { upsert: true });
      newest ??= pr.updated_at; // first item is the newest (sorted desc)
      count++;
      progress.tick();
      if (maxPRs && count >= maxPRs) break outer;
    }
  }
  progress.endPhase();
  return { count, newest };
}

async function ingestIssues(
  gh: Octokit,
  owner: string,
  repo: string,
  slug: string,
  progress: IngestProgress,
  floor: Date | undefined,
): Promise<{ count: number; newest: string | null }> {
  const col = await getCollection("issues");
  progress.phase("Issues", "+ comments");
  let count = 0;
  let newest: string | null = null;

  outer: for await (const { data: issues } of gh.paginate.iterator(gh.issues.listForRepo, {
    owner,
    repo,
    state: "all",
    sort: "updated",
    direction: "desc",
    ...(floor ? { since: floor.toISOString() } : {}), // server-side updated>=since
    per_page: 100,
  })) {
    for (const issue of issues) {
      if (floor && new Date(issue.updated_at) <= floor) break outer;
      // The issues endpoint also returns PRs — skip them; they're ingested above.
      if (issue.pull_request) continue;
      const comments = await gh.paginate(gh.issues.listComments, {
        owner,
        repo,
        issue_number: issue.number,
        per_page: 100,
      });
      const doc = toIssueDoc(slug, issue, comments);
      await col.replaceOne({ repo: slug, number: doc.number }, doc, { upsert: true });
      newest ??= issue.updated_at;
      count++;
      progress.tick();
    }
  }
  progress.endPhase();
  return { count, newest };
}
