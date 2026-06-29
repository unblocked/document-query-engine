// The query engine's public interface. The UX (server, chat agent, frontend) is
// written against this and never changes — each workshop step fills in the
// internals so runQuery() starts returning real results instead of NotImplemented.
import { synthesize } from "../synthesis/synthesize.js";
import { validatePlan } from "../validation/validate.js";
import { executePlan } from "./execute.js";

/** A synthesized query plan: which collection to run against, and the aggregation pipeline. */
export interface QueryPlan {
  collection: string;
  pipeline: Record<string, unknown>[];
}

/** One synthesis attempt: the plan, and why it was rejected (empty errors = it passed validation). */
export interface Attempt {
  plan: QueryPlan;
  errors: string[];
}

/** The result of running a natural-language query through the engine. */
export type Outcome =
  | { type: "Success"; rows: Record<string, unknown>[]; plan: QueryPlan; attempts: number; trace: Attempt[] }
  | { type: "NoResults"; plan: QueryPlan; attempts: number; trace: Attempt[] }
  | { type: "MaxAttemptsExceeded"; errors: string[]; plan: QueryPlan; attempts: number; trace: Attempt[] }
  | { type: "ResolutionFailed"; reason: string; attempts: number }
  | { type: "NotImplemented"; message: string };

export interface RunOptions {
  /** Person names the caller (the chat agent) extracted, to resolve to logins. */
  names?: string[];
  /** Max synthesis attempts (initial + retries). */
  maxAttempts?: number;
  /** Called with each generated plan — used to show synthesis live. */
  onPlan?: (plan: QueryPlan, attempt: number) => void;
}

/**
 * Turn a natural-language question into a MongoDB query, run it, return the outcome.
 * Step 4: synthesize -> validate -> execute. (The retry loop comes in step 5.)
 */
export async function runQuery(query: string, opts: RunOptions = {}): Promise<Outcome> {
  let plan: QueryPlan;
  try {
    ({ plan } = await synthesize(query, { names: opts.names }));
  } catch (err) {
    return { type: "ResolutionFailed", reason: errorText(err), attempts: 1 };
  }

  opts.onPlan?.(plan, 1);

  // The trace records each attempt (plan + why it was rejected) so the UI can show
  // the validation outcome. Step 4 has a single attempt; step 5 appends per retry.
  const validation = await validatePlan(plan);
  const trace: Attempt[] = [{ plan, errors: validation.ok ? [] : validation.errors }];
  if (!validation.ok) {
    return { type: "MaxAttemptsExceeded", errors: validation.errors, plan, attempts: 1, trace };
  }

  const rows = await executePlan(plan);
  return rows.length
    ? { type: "Success", rows, plan, attempts: 1, trace }
    : { type: "NoResults", plan, attempts: 1, trace };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
