import { z } from "zod";
import { GithubUser, Label } from "./common.js";

/** A single review on a pull request. */
export const Review = z.object({
  id: z.number(),
  user: GithubUser,
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  body: z.string().nullable().default(null),
  submitted_at: z.string().datetime().nullable().default(null),
});
export type Review = z.infer<typeof Review>;

/** A comment thread entry — covers both inline review comments and issue-style PR comments. */
export const Comment = z.object({
  id: z.number(),
  user: GithubUser,
  body: z.string(),
  created_at: z.string().datetime(),
});
export type Comment = z.infer<typeof Comment>;

/**
 * A pull request document as stored in MongoDB. Trimmed from the GitHub API
 * payload to the fields the query engine reasons over. Mirrors the shape of
 * Unblocked's GithubPullRequestDocument.
 */
export const PullRequestDoc = z.object({
  repo: z.string(), // "owner/name" — partitions documents by source repo
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().default(null),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().default(false),
  merged: z.boolean().default(false),
  user: GithubUser,
  assignees: z.array(GithubUser).default([]),
  requested_reviewers: z.array(GithubUser).default([]),
  labels: z.array(Label).default([]),
  reviews: z.array(Review).default([]),
  comments: z.array(Comment).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable().default(null),
  merged_at: z.string().datetime().nullable().default(null),
  html_url: z.string().url(),
});
export type PullRequestDoc = z.infer<typeof PullRequestDoc>;
