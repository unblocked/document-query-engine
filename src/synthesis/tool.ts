import { COLLECTIONS } from "../models/index.js";
import type { ToolSpec } from "../llm/provider.js";

export const TOOL_NAME = "execute_mongo_query";

/** The single tool the model must call. Its input IS the query plan. */
export const mongoQueryTool: ToolSpec = {
  name: TOOL_NAME,
  description:
    "Execute a MongoDB aggregation pipeline against one collection and return the matching documents.",
  schema: {
    type: "object",
    properties: {
      collection: {
        type: "string",
        enum: Object.keys(COLLECTIONS),
        description: "The collection to query.",
      },
      pipeline: {
        type: "array",
        items: { type: "object" },
        description: "A MongoDB aggregation pipeline (array of stage objects).",
      },
    },
    required: ["collection", "pipeline"],
  },
};
