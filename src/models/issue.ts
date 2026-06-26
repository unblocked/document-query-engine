import { z } from "zod";
import { GithubUser, Label } from "./common.js";
import { Comment } from "./pull-request.js";

/**
 * An issue document as stored in MongoDB. Trimmed from the GitHub API payload.
 * Note: the GitHub REST API returns PRs in the issues endpoint too — ingestion
 * filters those out so this collection holds only true issues.
 */
export const IssueDoc = z.object({
  repo: z.string(), // "owner/name"
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().default(null),
  state: z.enum(["open", "closed"]),
  user: GithubUser,
  assignees: z.array(GithubUser).default([]),
  labels: z.array(Label).default([]),
  comments: z.array(Comment).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  closed_at: z.string().datetime().nullable().default(null),
  html_url: z.string().url(),
});
export type IssueDoc = z.infer<typeof IssueDoc>;
