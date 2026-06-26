import { getCollection } from "../db.js";
import type { CollectionName } from "../models/index.js";
import type { QueryPlan } from "./run.js";

/** Runs a query plan's aggregation pipeline and returns the matching documents. */
export async function executePlan(plan: QueryPlan): Promise<Record<string, unknown>[]> {
  const col = await getCollection(plan.collection as CollectionName);
  return col.aggregate(plan.pipeline).toArray();
}
