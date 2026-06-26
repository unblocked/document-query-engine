import { runQuery } from "../engine/run.js";
import { formatOutcome } from "../format/format.js";
import type { QueryPlan } from "../engine/run.js";
import { MODELS, streamChatTurn, toolResultMessage, type LlmMessage, type ToolSpec } from "../llm/provider.js";

const MAX_TURNS = 6;

/** The tool the agent uses to pull data. It delegates to the full NL->query engine. */
const queryTool: ToolSpec = {
  name: "query_github",
  description:
    "Query the GitHub pull-request and issue database with a natural-language question. " +
    "Returns matching records (or a count/aggregation). Call this whenever answering needs " +
    "real data about PRs, issues, authors, reviews, labels, counts, or dates. " +
    "Ask one focused question per call, e.g. \"open PRs by alice\" or \"count issues by label\".",
  schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "A focused natural-language data question." },
      user_name: {
        type: "string",
        description:
          "If the question references a specific person (author/reviewer/assignee), extract their " +
          'name or username here so it can be resolved to a GitHub login — e.g. "rashin". ' +
          "Keep the person and their role in the question text too. Omit if no person is referenced.",
      },
    },
    required: ["question"],
  },
};

const SYSTEM = `You are a helpful assistant answering questions about a GitHub repository's pull requests and issues.

You cannot see the data directly. To answer anything factual, call the \`query_github\` tool with a focused natural-language question; it runs a real database query and returns the results. Break complex questions into multiple tool calls if needed.

When you have enough data, answer concisely in prose. Cite specific PR/issue numbers (e.g. #7) when relevant. If a query returns nothing, say so rather than guessing.`;

/** An event streamed to the chat client as the agent works. */
export type AgentEvent =
  | { type: "thinking"; text: string } // live extended-thinking (Anthropic; ephemeral ticker)
  | { type: "note"; text: string } // interim narration the model emits before tool calls
  | { type: "tool_call"; question: string }
  | { type: "tool_result"; summary: string; plan: QueryPlan | null }
  | { type: "answer"; text: string } // the final answer (rendered as markdown)
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * Runs the agent loop over a conversation, yielding events. The agent calls
 * query_github as needed; each call executes the real engine and the result is
 * fed back so the model can reason over actual data before answering. Works with
 * whichever LLM provider is configured (see src/llm/provider.ts).
 */
export async function* runAgent(history: LlmMessage[]): AsyncGenerator<AgentEvent> {
  const messages: LlmMessage[] = [...history];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // Stream the turn so we can surface the model's thinking live (where supported).
      const gen = streamChatTurn({ system: SYSTEM, messages, tools: [queryTool], model: MODELS.chat, maxTokens: 3072 });
      let result;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        yield { type: "thinking", text: value.text };
      }

      messages.push(...result.assistant); // keep the assistant turn for the next round

      if (result.toolCalls.length === 0) {
        if (result.text) yield { type: "answer", text: result.text };
        yield { type: "done" };
        return;
      }

      // Turn ends in tool calls — its text is interim narration, not the answer.
      if (result.text) yield { type: "note", text: result.text };

      for (const call of result.toolCalls) {
        if (call.name !== queryTool.name) continue;
        const input = call.args as { question: string; user_name?: string };
        yield { type: "tool_call", question: input.question };

        // The agent extracts the person into user_name; the engine resolves it to logins.
        const names = input.user_name ? [input.user_name] : [];
        const outcome = await runQuery(input.question, { names });
        const summary = formatOutcome(outcome);
        const plan = "plan" in outcome ? outcome.plan : null;
        yield { type: "tool_result", summary, plan };

        messages.push(toolResultMessage(call.id, summary));
      }
    }
    yield { type: "answer", text: "(Reached the step limit before finishing.)" };
    yield { type: "done" };
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
