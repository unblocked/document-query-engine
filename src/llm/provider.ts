// A thin LLM provider layer so the engine works with either Anthropic or OpenAI.
// Selection is automatic: if OPENAI_API_KEY is set, OpenAI is used; otherwise
// Anthropic. Callers (synthesis, chat) speak in terms of the helpers below and
// never touch a vendor SDK directly. Conversation messages are kept opaque
// (vendor-shaped) and built via userMessage()/toolResultMessage().
//
// OpenAI uses the Responses API (/v1/responses): GPT-5 reasoning models don't
// support function tools on chat-completions. Anthropic uses the Messages API.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../config.js";

export type ProviderName = "openai" | "anthropic";

/** OpenAI wins when its key is present, else Anthropic. */
export const provider: ProviderName = config.openaiApiKey ? "openai" : "anthropic";

/** Default models per provider. */
export const MODELS =
  provider === "openai"
    ? { synth: "gpt-5.4-mini", chat: "gpt-5.4-mini" }
    : { synth: "claude-haiku-4-5-20251001", chat: "claude-sonnet-4-6" };

/** GPT-5 / o-series are reasoning models — they take a `reasoning` effort and ignore temperature. */
const isReasoningModel = (model: string): boolean => /^(gpt-5|o\d)/.test(model);
/** Reasoning models spend output tokens on hidden reasoning, so give responses headroom. */
const outputCap = (model: string, want: number): number => (isReasoningModel(model) ? Math.max(want, 4096) : want);

/** An opaque, vendor-shaped conversation message. Build via the helpers; don't inspect. */
export type LlmMessage = Anthropic.MessageParam | OpenAI.Responses.ResponseInputItem;

/** A tool the model may call. `schema` is a JSON Schema for the tool's input. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ForcedToolResult {
  /** The tool's parsed input arguments. */
  input: unknown;
  /** Provider-specific id for this tool call, used to attach a result/error on retry. */
  toolCallId: string;
  /** The assistant turn items to append before feeding back a result (OpenAI requires the
   *  reasoning item to accompany its function_call, so this is the full output, not one item). */
  assistant: LlmMessage[];
}

export interface ChatTurnResult {
  /** Items to append to the conversation for the next turn (assistant tool calls). */
  assistant: LlmMessage[];
  /** Concatenated assistant text for this turn. */
  text: string;
  toolCalls: { id: string; name: string; args: unknown }[];
}

let anthropicClient: Anthropic | undefined;
let openaiClient: OpenAI | undefined;
function anthropic(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  return anthropicClient;
}
function openai(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.openaiApiKey });
  return openaiClient;
}

/** A plain user-text message (valid input for both providers). */
export function userMessage(text: string): LlmMessage {
  return { role: "user", content: text };
}

/** A tool result to feed back to the model (set isError for validation/runtime failures). */
export function toolResultMessage(toolCallId: string, content: string, isError = false): LlmMessage {
  if (provider === "openai") {
    return { type: "function_call_output", call_id: toolCallId, output: content };
  }
  return { role: "user", content: [{ type: "tool_result", tool_use_id: toolCallId, content, is_error: isError }] };
}

/**
 * Forces the model to call exactly one tool and returns its parsed input. Used for
 * synthesis (emit a query plan) and name extraction (report people).
 */
export async function forceTool(opts: {
  system: string;
  messages: LlmMessage[];
  tool: ToolSpec;
  model: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<ForcedToolResult> {
  const max = opts.maxTokens ?? 1024;

  if (provider === "openai") {
    const res = await openai().responses.create({
      model: opts.model,
      instructions: opts.system,
      input: opts.messages as OpenAI.Responses.ResponseInputItem[],
      tools: [{ type: "function", name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.schema, strict: false }],
      tool_choice: { type: "function", name: opts.tool.name },
      ...(isReasoningModel(opts.model) ? { reasoning: { effort: "low" } } : {}),
      max_output_tokens: outputCap(opts.model, max),
    });
    const fc = res.output.find(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call" && o.name === opts.tool.name,
    );
    if (!fc) throw new Error("Model did not produce a tool call.");
    return { input: safeParse(fc.arguments), toolCallId: fc.call_id, assistant: res.output as LlmMessage[] };
  }

  const res = await anthropic().messages.create({
    model: opts.model,
    max_tokens: max,
    temperature: opts.temperature ?? 0,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: "tool", name: opts.tool.name },
    messages: opts.messages as Anthropic.MessageParam[],
  });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === opts.tool.name);
  if (!tu) throw new Error("Model did not produce a tool call.");
  return { input: tu.input, toolCallId: tu.id, assistant: [{ role: "assistant", content: res.content }] };
}

/**
 * Runs one chat turn, streaming the model's thinking as it arrives (Anthropic
 * extended thinking; OpenAI reasoning summaries). Yields `thinking` chunks; the
 * generator's return value is the finished turn.
 */
export async function* streamChatTurn(opts: {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  model: string;
  maxTokens: number;
}): AsyncGenerator<{ type: "thinking"; text: string }, ChatTurnResult, void> {
  if (provider === "openai") {
    const stream = await openai().responses.create({
      model: opts.model,
      instructions: opts.system,
      input: opts.messages as OpenAI.Responses.ResponseInputItem[],
      tools: opts.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.schema, strict: false })),
      ...(isReasoningModel(opts.model) ? { reasoning: { effort: "low", summary: "auto" } } : {}),
      max_output_tokens: outputCap(opts.model, opts.maxTokens),
      stream: true,
    });
    let final: OpenAI.Responses.Response | undefined;
    let text = ""; // accumulate from deltas — the streamed completed event lacks the output_text getter
    for await (const ev of stream) {
      if (ev.type === "response.output_text.delta") text += ev.delta;
      else if (ev.type === "response.reasoning_summary_text.delta") yield { type: "thinking", text: ev.delta };
      else if (ev.type === "response.completed") final = ev.response;
    }
    const output = final?.output ?? [];
    const fcItems = output.filter(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call",
    );
    return {
      // Echo the whole output (reasoning + calls) so a follow-up turn keeps the reasoning↔call pairing.
      assistant: output as LlmMessage[],
      text,
      toolCalls: fcItems.map((o) => ({ id: o.call_id, name: o.name, args: safeParse(o.arguments) })),
    };
  }

  const stream = anthropic().messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens,
    thinking: { type: "enabled", budget_tokens: 1536 },
    system: opts.system,
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema })),
    messages: opts.messages as Anthropic.MessageParam[],
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta") {
      yield { type: "thinking", text: ev.delta.thinking };
    }
  }
  const resp = await stream.finalMessage();
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text" && b.text.trim().length > 0)
    .map((b) => b.text)
    .join("\n\n");
  const toolCalls = resp.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, args: b.input }));
  return { assistant: [{ role: "assistant", content: resp.content }], text, toolCalls };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}
