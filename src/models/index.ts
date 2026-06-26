export { GithubUser, Label, Timestamp } from "./common.js";
export { Review, Comment, PullRequestDoc } from "./pull-request.js";
export { IssueDoc } from "./issue.js";

import { PullRequestDoc } from "./pull-request.js";
import { IssueDoc } from "./issue.js";

/** Collection names keyed to their document schema. Single source of truth for storage + schema description. */
export const COLLECTIONS = {
  pull_requests: PullRequestDoc,
  issues: IssueDoc,
} as const;

export type CollectionName = keyof typeof COLLECTIONS;
