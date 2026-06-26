import { githubClient, resolveGithubToken } from "../github/client.js";
import { ingestRepo, type IngestOptions } from "../github/ingest.js";
import { closeDb } from "../db.js";
import { Reporter } from "./reporter.js";

const USAGE = `Usage: bun run ingest -- owner/repo [options]

Options:
  --max N          stop after N pull requests (default 200)
  --since DATE     only ingest items updated on/after DATE (default: 30 days ago)
  --full           ignore the saved checkpoint; re-ingest within the window
  --all            no PR cap (overrides the default --max 200)`;

const DEFAULT_WINDOW_DAYS = 30;

/** Parses argv into a repo slug + ingest options. */
function parseArgs(argv: string[]): { slug?: string; opts: IngestOptions } {
  const slug = argv.find((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const opts: IngestOptions = {};
  const max = flag("max");
  if (max !== undefined) opts.maxPRs = Number(max);
  else if (!argv.includes("--all")) opts.maxPRs = 200; // sensible default; --all removes the cap

  const since = flag("since");
  if (since !== undefined) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid --since date: "${since}"`);
    opts.since = d;
  } else {
    // Default to a recent window so the issues endpoint uses its server-side
    // `since` filter (otherwise it pages through every PR it returns). Widen with --since.
    const d = new Date();
    d.setDate(d.getDate() - DEFAULT_WINDOW_DAYS);
    opts.since = d;
  }

  if (argv.includes("--full")) opts.resume = false;
  return { slug, opts };
}

async function main(): Promise<void> {
  const { slug, opts } = parseArgs(process.argv.slice(2));
  if (!slug) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (Number.isNaN(opts.maxPRs ?? 0)) {
    console.error("--max must be a number.");
    process.exitCode = 1;
    return;
  }
  if (!resolveGithubToken()) {
    console.error("No GitHub token. Set GITHUB_TOKEN in .env, or run `gh auth login`.");
    process.exitCode = 1;
    return;
  }

  const reporter = new Reporter();
  reporter.start(slug);
  const t0 = Date.now();
  try {
    const result = await ingestRepo(githubClient(), slug, reporter, opts);
    reporter.finish(
      { pull_requests: result.pullRequests, issues: result.issues, users: result.users },
      Date.now() - t0,
    );
  } catch (err) {
    reporter.fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main();
