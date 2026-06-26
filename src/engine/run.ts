// The query engine's public interface. The UX (server, chat agent, frontend) is
// written against this and never changes — each workshop step fills in the
// internals so runQuery() starts returning real results instead of NotImplemented.

/** A synthesized query plan: which collection to run against, and the aggregation pipeline. */
export interface QueryPlan {
  collection: string;
  pipeline: Record<string, unknown>[];
}

/** The result of running a natural-language query through the engine. */
export type Outcome =
  | { type: "Success"; rows: Record<string, unknown>[]; plan: QueryPlan; attempts: number }
  | { type: "NoResults"; plan: QueryPlan; attempts: number }
  | { type: "MaxAttemptsExceeded"; errors: string[]; plan: QueryPlan; attempts: number }
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
 * Turn a natural-language question into a MongoDB query, run it, and return the
 * outcome.
 *
 * TODO (workshop): this is a stub. You'll build the real engine across the steps —
 * schema description, identity resolution, synthesis, validation, retry, full-text —
 * and wire it up here so it returns Success/NoResults instead of NotImplemented.
 */
export async function runQuery(_query: string, _opts: RunOptions = {}): Promise<Outcome> {
  return {
    type: "NotImplemented",
    message: "TODO: Wire up the query engine",
  };
}
