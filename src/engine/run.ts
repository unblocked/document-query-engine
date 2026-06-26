// The query engine's public interface. The UX (server, chat agent, frontend) is
// written against this and never changes — each workshop step fills in the
// internals so runQuery() starts returning real results instead of NotImplemented.
import { synthesize } from "../synthesis/synthesize.js";
import { validatePlan } from "../validation/validate.js";
import { executePlan } from "./execute.js";
import { toolResultMessage, type LlmMessage } from "../llm/provider.js";

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
 * Step 5: synthesize -> validate -> execute, feeding validation/runtime errors back
 * to the model so it self-corrects, up to maxAttempts. The trace records every
 * attempt (plan + why it was rejected) so the UI can show the self-correction.
 */
export async function runQuery(query: string, opts: RunOptions = {}): Promise<Outcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const trace: Attempt[] = [];

  let plan: QueryPlan;
  let toolUseId: string;
  let messages: LlmMessage[];
  try {
    ({ plan, toolUseId, messages } = await synthesize(query, { names: opts.names }));
  } catch (err) {
    return { type: "ResolutionFailed", reason: errorText(err), attempts: 1 };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.onPlan?.(plan, attempt);

    let errors: string[] | null = null;
    const validation = await validatePlan(plan);
    if (!validation.ok) {
      errors = validation.errors;
    } else {
      try {
        const rows = await executePlan(plan);
        trace.push({ plan, errors: [] });
        return rows.length
          ? { type: "Success", rows, plan, attempts: attempt, trace }
          : { type: "NoResults", plan, attempts: attempt, trace };
      } catch (err) {
        errors = [errorText(err)];
      }
    }

    trace.push({ plan, errors });

    if (attempt === maxAttempts) {
      return { type: "MaxAttemptsExceeded", errors, plan, attempts: attempt, trace };
    }

    // Feed the error back as a tool result and let the model correct itself.
    const feedback = `Query rejected:\n- ${errors.join("\n- ")}\nFix the pipeline and call the tool again.`;
    messages = [...messages, toolResultMessage(toolUseId, feedback, true)];
    try {
      ({ plan, toolUseId, messages } = await synthesize(query, { history: messages }));
    } catch (err) {
      return { type: "ResolutionFailed", reason: errorText(err), attempts: attempt + 1 };
    }
  }

  return { type: "ResolutionFailed", reason: "exhausted attempts", attempts: maxAttempts };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
