import { buildSchemaContext } from "../schema/describe.js";
import { resolveUsers, formatResolvedUsers } from "../identity/resolver.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { mongoQueryTool } from "./tool.js";
import { forceTool, userMessage, MODELS, type LlmMessage, type ToolSpec } from "../llm/provider.js";
import type { QueryPlan } from "../engine/run.js";

export interface SynthesizeOptions {
  /** Named people to resolve to logins (beyond automatic "me" handling). */
  names?: string[];
  /** Prior turns to continue from — used by the retry loop (Step 5). */
  history?: LlmMessage[];
}

export interface SynthesisResult {
  plan: QueryPlan;
  toolUseId: string;
  /** The full message history including this turn, for feeding a retry. */
  messages: LlmMessage[];
}

/** Forced tool the extractor must call — removes the model's option to refuse via prose. */
const peopleTool: ToolSpec = {
  name: "report_people",
  description: "Report the specific people the question is about (PR/issue authors, reviewers, assignees).",
  schema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description:
          'Each specific person named in the question, exactly as written. Bare first names, last ' +
          'names, and usernames all count (e.g. "peter", "alice", "octocat"). Empty array if no ' +
          "person is named. Exclude generic self-references (me/my/I/mine).",
      },
    },
    required: ["names"],
  },
};

const EXTRACT_SYSTEM = "Identify the specific people the question is about (PR/issue authors, reviewers, assignees).";

/**
 * Pulls names of specific people out of a query via a forced tool call, so the
 * query console (which, unlike the chat agent, has no tool layer to extract a
 * user_name) can still resolve "peter's PRs" to a login. A forced tool call +
 * temperature 0 makes this deterministic. Names that don't match the directory
 * resolve to nothing downstream, so over-extraction is safe.
 */
async function extractNames(query: string): Promise<string[]> {
  const { input } = await forceTool({
    system: EXTRACT_SYSTEM,
    messages: [userMessage(query)],
    tool: peopleTool,
    model: MODELS.synth,
    temperature: 0,
    maxTokens: 256,
  });
  const names = (input as { names?: unknown }).names;
  return Array.isArray(names) ? names.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Turns a natural-language query into a MongoDB query plan via a single forced
 * tool call. Does not validate or execute the plan — that's Steps 4 and 5.
 */
export async function synthesize(query: string, opts: SynthesizeOptions = {}): Promise<SynthesisResult> {
  const schemaContext = await buildSchemaContext();
  const system = buildSystemPrompt(schemaContext);

  let messages: LlmMessage[];
  if (opts.history) {
    messages = [...opts.history];
  } else {
    // Caller-provided names (the chat agent's extracted user_name) take priority;
    // otherwise extract them from the query so the console resolves names too.
    const names = opts.names?.length ? opts.names : await extractNames(query);
    const resolved = await resolveUsers(query, names);
    messages = [userMessage(buildUserMessage(query, formatResolvedUsers(resolved), new Date().toISOString()))];
  }

  const { input, toolCallId, assistant } = await forceTool({
    system,
    messages,
    tool: mongoQueryTool,
    model: MODELS.synth,
    temperature: 0,
    maxTokens: 1024,
  });

  return { plan: input as QueryPlan, toolUseId: toolCallId, messages: [...messages, ...assistant] };
}
