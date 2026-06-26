import { Octokit } from "@octokit/rest";
import { execFileSync } from "node:child_process";
import { config } from "../config.js";

/** The GitHub CLI's token, if `gh` is installed and authenticated; "" otherwise. */
function ghCliToken(): string {
  try {
    return execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** GITHUB_TOKEN if set, otherwise falls back to the `gh` CLI's token. */
export function resolveGithubToken(): string {
  return config.githubToken || ghCliToken();
}

/** Builds an authenticated Octokit client (GITHUB_TOKEN, or the gh CLI as a fallback). */
export function githubClient(): Octokit {
  return new Octokit({ auth: resolveGithubToken() });
}

/** Splits an "owner/name" repo slug into its parts. */
export function parseRepo(slug: string): { owner: string; repo: string } {
  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo "${slug}" — expected "owner/name".`);
  }
  return { owner, repo };
}
