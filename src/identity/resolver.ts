import { config } from "../config.js";
import { getCollection, getUsersCollection } from "../db.js";
import { COLLECTIONS, type CollectionName } from "../models/index.js";

export interface ResolvedUser {
  /** The reference as the user phrased it ("me", "alice"). */
  reference: string;
  /** GitHub logins this reference maps to. */
  logins: string[];
}

// Self-reference: "my"/"mine"/"myself", or "me" only after a preposition
// (so "show me ..." doesn't count, but "PRs by me" / "assigned to me" does).
const ME_PATTERN = /\b(my|mine|myself)\b|\b(?:by|to|for|from)\s+me\b/i;

/** Returns all distinct author logins present across the ingested collections. */
export async function knownLogins(): Promise<string[]> {
  const names = Object.keys(COLLECTIONS) as CollectionName[];
  const sets = await Promise.all(
    names.map(async (n) => (await getCollection(n)).distinct("user.login")),
  );
  return [...new Set(sets.flat() as string[])];
}

/** True if a query token plausibly refers to a login (exact, substring, or a >=4-char shared prefix). */
function tokenMatchesLogin(token: string, login: string): boolean {
  const t = token.toLowerCase();
  const l = login.toLowerCase();
  if (t === l) return true;
  if (t.length >= 3 && (l.includes(t) || t.includes(l))) return true;
  let p = 0;
  while (p < t.length && p < l.length && t[p] === l[p]) p++;
  return p >= 4; // e.g. "rashin" ~ "rasharab" (shared "rash")
}

/** True if a token matches a display name (substring, or a name word that shares a prefix). */
function tokenMatchesName(token: string, fullName: string): boolean {
  const t = token.toLowerCase();
  const n = fullName.toLowerCase();
  if (t.length >= 3 && n.includes(t)) return true; // "peter" in "peter werry"
  return n.split(/\s+/).some((w) => w.length >= 2 && (w.startsWith(t) || t.startsWith(w)));
}

/**
 * Resolves a single named reference to logins using the `users` directory
 * (display name + login). "peter" -> "Peter Werry" -> "pwerry". Falls back to
 * login-only matching if the directory hasn't been populated yet.
 */
export async function resolveName(name: string): Promise<ResolvedUser> {
  const q = name.toLowerCase();
  const dir = await (await getUsersCollection()).find({}, { projection: { _id: 0 } }).toArray();

  if (dir.length === 0) {
    const logins = await knownLogins();
    const exact = logins.filter((l) => l.toLowerCase() === q);
    const matches = exact.length ? exact : logins.filter((l) => tokenMatchesLogin(q, l));
    return { reference: name, logins: matches };
  }

  const matched = dir.filter(
    (u) =>
      u.login.toLowerCase() === q ||
      (u.name ? tokenMatchesName(q, u.name) : false) ||
      tokenMatchesLogin(q, u.login),
  );
  return { reference: name, logins: [...new Set(matched.map((u) => u.login))] };
}

/**
 * Resolves user references for a query. Handles self-reference ("my"/"by me")
 * via CALLER_LOGIN, plus any names the caller extracted (the agent fills these);
 * each name is resolved to logins in code. Mirrors OneShotMongoQueryService,
 * which receives already-resolved users rather than scanning the query itself.
 */
export async function resolveUsers(query: string, names: string[] = []): Promise<ResolvedUser[]> {
  const resolved: ResolvedUser[] = [];

  if (ME_PATTERN.test(query) && config.callerLogin) {
    resolved.push({ reference: "me", logins: [config.callerLogin] });
  }
  for (const name of names) {
    const r = await resolveName(name);
    if (r.logins.length) resolved.push(r);
  }
  return resolved;
}

/**
 * Formats resolved users as a prompt section. The LLM is told these are an
 * exhaustive alias set for one person, not examples — so it filters on all of them.
 */
export function formatResolvedUsers(users: ResolvedUser[]): string {
  if (!users.length) return "";
  const blocks = users.map(
    (u) =>
      `## Resolved User: "${u.reference}"\nGitHub logins: ${u.logins.join(", ")}\n` +
      `Use these logins when filtering for this person. They are an exhaustive alias set for ONE person, not examples or ranked suggestions.`,
  );
  return blocks.join("\n\n");
}
