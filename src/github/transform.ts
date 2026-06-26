import { GithubUser, Label, Review, Comment, PullRequestDoc, IssueDoc } from "../models/index.js";
import type { z } from "zod";

/** Narrow the parts of the GitHub API payloads we read. Octokit's response types are huge; we accept loose input and validate on the way out via zod. */
type RawUser = { login: string; id: number; type?: string } | null;
type RawLabel = string | { name?: string; description?: string | null };

function mapUser(u: RawUser): z.input<typeof GithubUser> {
  // Ghost/deleted accounts come back null; represent them explicitly.
  if (!u) return { login: "ghost", id: 0, type: "User" };
  const type = u.type === "Bot" || u.type === "Organization" ? u.type : "User";
  return { login: u.login, id: u.id, type };
}

function mapLabels(labels: RawLabel[] | undefined): z.input<typeof Label>[] {
  return (labels ?? []).map((l) =>
    typeof l === "string" ? { name: l, description: null } : { name: l.name ?? "", description: l.description ?? null },
  );
}

/** Maps a raw PR (plus separately-fetched reviews/comments) into a validated PullRequestDoc. */
export function toPullRequestDoc(
  repo: string,
  pr: Record<string, any>,
  reviews: Record<string, any>[],
  comments: Record<string, any>[],
): PullRequestDoc {
  return PullRequestDoc.parse({
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.state,
    draft: pr.draft ?? false,
    merged: Boolean(pr.merged_at),
    user: mapUser(pr.user),
    assignees: (pr.assignees ?? []).map(mapUser),
    requested_reviewers: (pr.requested_reviewers ?? []).map(mapUser),
    labels: mapLabels(pr.labels),
    reviews: reviews.map((r) => ({
      id: r.id,
      user: mapUser(r.user),
      state: r.state,
      body: r.body ?? null,
      submitted_at: r.submitted_at ?? null,
    } satisfies z.input<typeof Review>)),
    comments: comments.map((c) => ({
      id: c.id,
      user: mapUser(c.user),
      body: c.body ?? "",
      created_at: c.created_at,
    } satisfies z.input<typeof Comment>)),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at ?? null,
    merged_at: pr.merged_at ?? null,
    html_url: pr.html_url,
  });
}

/** Maps a raw issue (plus comments) into a validated IssueDoc. Caller must exclude PRs. */
export function toIssueDoc(repo: string, issue: Record<string, any>, comments: Record<string, any>[]): IssueDoc {
  return IssueDoc.parse({
    repo,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    user: mapUser(issue.user),
    assignees: (issue.assignees ?? []).map(mapUser),
    labels: mapLabels(issue.labels),
    comments: comments.map((c) => ({
      id: c.id,
      user: mapUser(c.user),
      body: c.body ?? "",
      created_at: c.created_at,
    } satisfies z.input<typeof Comment>)),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at ?? null,
    html_url: issue.html_url,
  });
}
