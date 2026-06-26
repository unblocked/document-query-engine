import { z } from "zod";

/** A GitHub account reference as it appears nested in PRs, issues, reviews, etc. */
export const GithubUser = z.object({
  login: z.string(),
  id: z.number(),
  type: z.enum(["User", "Bot", "Organization"]).default("User"),
});
export type GithubUser = z.infer<typeof GithubUser>;

/** A label attached to a PR or issue. */
export const Label = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
});
export type Label = z.infer<typeof Label>;

/** ISO-8601 timestamp string. Stored as string for transparent LLM-readable queries. */
export const Timestamp = z.string().datetime();
