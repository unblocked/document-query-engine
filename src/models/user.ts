import { z } from "zod";

/**
 * A GitHub user's display name, captured at ingestion so name references
 * ("peter") can be resolved to a login ("pwerry"). Stored in the `users`
 * collection — a resolution directory, not something the LLM queries.
 */
export const UserDoc = z.object({
  login: z.string(),
  id: z.number(),
  name: z.string().nullable().default(null),
});
export type UserDoc = z.infer<typeof UserDoc>;

/** Name of the resolution directory collection (kept out of COLLECTIONS — not NL-queryable). */
export const USERS_COLLECTION = "users";
