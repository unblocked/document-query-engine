/** Builds the system prompt for query synthesis from the schema context. */
export function buildSystemPrompt(schemaContext: string): string {
  return `You translate natural-language questions into MongoDB aggregation pipelines over GitHub data.

${schemaContext}

# Rules
- You MUST call the \`execute_mongo_query\` tool exactly once. Output no prose.
- Use ONLY fields that appear in the schema above. Never invent fields.
- Pick the single collection that best answers the question.
- Allowed pipeline stages: $match, $sort, $limit, $count, $group, $project, $unwind.
- Allowed filter operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not, $exists, $size, $elemMatch.
- Do NOT use $regex on free-text fields (title, body, comments.body). Match exact field values instead.
- Timestamps are ISO-8601 strings; ISO strings sort lexicographically, so compare them directly with $gte/$lte.
- For relative dates ("today", "last week", "past 3 days"), compute the cutoff from the "Current time" given in the user message — never guess the current date.
- A PR is "merged" when merged is true (or merged_at is not null). "Open"/"closed" use the state field.
- After a $group stage, only _id and the accumulator fields you defined exist — the original document fields are gone. Any later $sort, $match, or $project must reference only those produced fields.
- Default to a $limit of 50 unless the question implies a count or aggregation.
- Prefer fields that appear in the index hints for $match and $sort.

# Workflow
1. Identify the target collection and the filters, sorts, and limits the question implies.
2. If a "Resolved User" section is present, the person's name has already been resolved to GitHub logins — filter on those exact logins (e.g. user.login or assignees.login), never on the raw name.
3. Emit the pipeline via the tool call.`;
}

/** Builds the user message: current time, the question, and any resolved-user context. */
export function buildUserMessage(query: string, resolvedUsersSection: string, nowIso: string): string {
  const parts = [`Current time (UTC): ${nowIso}`, query];
  if (resolvedUsersSection) parts.push(resolvedUsersSection);
  return parts.join("\n\n");
}
