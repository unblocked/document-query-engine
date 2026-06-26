import { COLLECTIONS, type CollectionName } from "../models/index.js";
import { collectFieldPaths } from "../schema/describe.js";
import type { QueryPlan } from "../engine/run.js";

const ALLOWED_STAGES = new Set([
  "$match",
  "$sort",
  "$limit",
  "$count",
  "$group",
  "$project",
  "$unwind",
]);

const ALLOWED_OPERATORS = new Set([
  // query operators
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$and", "$or", "$not", "$nor", "$exists", "$size", "$elemMatch",
  // full-text search (backed by the title/body text index)
  "$text", "$search", "$language", "$caseSensitive", "$diacriticSensitive",
  // accumulators / group expressions
  "$sum", "$avg", "$min", "$max", "$first", "$last", "$push", "$addToSet",
]);

/** Field paths a query may never reference. */
function isBlocked(path: string): boolean {
  return path === "_id" || path === "metadata" || path.startsWith("metadata.");
}

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Statically validates a query plan before execution: known collection, only
 * allow-listed stages and operators, and every referenced field exists in the
 * schema and isn't blocked. Returns structured errors so the retry loop (Step 5)
 * can feed them back to the model.
 */
export async function validatePlan(plan: QueryPlan): Promise<ValidationResult> {
  const errors: string[] = [];

  if (!(plan.collection in COLLECTIONS)) {
    return { ok: false, errors: [`Unknown collection "${plan.collection}".`] };
  }
  if (!Array.isArray(plan.pipeline) || plan.pipeline.length === 0) {
    return { ok: false, errors: ["Pipeline must be a non-empty array of stages."] };
  }

  const fields = await collectFieldPaths(plan.collection as CollectionName);

  // $group/$project rebuild the document shape, so downstream stages reference
  // computed fields (e.g. a $sum alias) that aren't in the source schema. We only
  // validate field existence against the schema up to the first reshaping stage.
  let reshaped = false;

  for (const stage of plan.pipeline) {
    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      errors.push(`Each stage must have exactly one operator; got [${keys.join(", ")}].`);
      continue;
    }
    const stageName = keys[0]!;
    if (!ALLOWED_STAGES.has(stageName)) {
      errors.push(`Stage "${stageName}" is not allowed.`);
      continue;
    }
    checkOperators(stage[stageName], errors);
    if (!reshaped) checkFields(stageName, stage[stageName], fields, errors);
    if (stageName === "$group" || stageName === "$project") reshaped = true;
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Recursively rejects any $-prefixed key that isn't an allow-listed operator/accumulator. */
function checkOperators(value: unknown, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v) => checkOperators(v, errors));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith("$") && !ALLOWED_OPERATORS.has(key)) {
        errors.push(`Operator "${key}" is not allowed.`);
      }
      checkOperators(v, errors);
    }
  }
}

/** Validates field references for the field-bearing stages. */
function checkFields(stage: string, value: unknown, fields: Set<string>, errors: string[]): void {
  const check = (path: string) => {
    if (isBlocked(path)) errors.push(`Field "${path}" is not accessible.`);
    else if (!fields.has(path)) errors.push(`Unknown field "${path}" in ${stage}.`);
  };

  switch (stage) {
    case "$match":
      collectMatchFields(value).forEach(check);
      break;
    case "$sort":
      // _id is always a valid sort key (document order). Other keys must be real fields.
      if (value && typeof value === "object") Object.keys(value).filter((k) => k !== "_id").forEach(check);
      break;
    // $project is intentionally not field-checked: it renames/computes output fields
    // (e.g. {login: "$user.login"}), so its keys are new names, not source paths.
    case "$unwind":
      if (typeof value === "string") check(value.replace(/^\$/, ""));
      else if (value && typeof value === "object" && "path" in value)
        check(String((value as { path: unknown }).path).replace(/^\$/, ""));
      break;
    default:
      break; // $limit, $count, $group keys are not document field paths
  }
}

/** Pulls dotted document field paths out of a $match expression, descending through $and/$or/$not and nested docs. */
function collectMatchFields(value: unknown): string[] {
  const out: string[] = [];
  const isPlainDoc = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => !k.startsWith("$"));

  const visit = (v: unknown, prefix: string) => {
    if (Array.isArray(v)) return v.forEach((x) => visit(x, prefix));
    if (v && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        if (key.startsWith("$")) {
          visit(child, prefix); // logical operator — recurse, keep prefix
        } else {
          const path = prefix ? `${prefix}.${key}` : key;
          // A nested doc value (e.g. {user: {login: "x"}}) extends the dotted path.
          if (isPlainDoc(child)) visit(child, path);
          else out.push(path);
        }
      }
    }
  };
  visit(value, "");
  return out;
}
