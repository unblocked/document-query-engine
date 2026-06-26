import { COLLECTIONS, type CollectionName } from "../models/index.js";
import { getCollection } from "../db.js";

// Schema DISCOVERY: instead of hard-coding the shape, sample the live collection
// and infer it from the actual documents — including enum values (e.g. open|closed)
// learned from the data. The zod models still govern ingestion; this is query-time.

const SAMPLE_SIZE = 300;
const ENUM_MAX = 8; // a string field with <= this many distinct values is shown as an enum

/** A short, single-token string — the kind a real enum value looks like ("open", "APPROVED"). */
const ENUM_TOKEN = /^[A-Za-z][\w.+-]{0,23}$/;

/** Inferred shape of a value, merged across sampled documents. */
type Node =
  | { kind: "object"; fields: Map<string, Node> }
  | { kind: "array"; elem: Node | null }
  | { kind: "scalar"; prims: Set<string>; values: Set<string>; count: number; enumOk: boolean };

function primOf(v: unknown): string {
  if (v instanceof Date) return "date";
  return typeof v; // "string" | "number" | "boolean"
}

/** Merge one value into the inferred node for its position. */
function merge(node: Node | undefined, v: unknown): Node {
  if (Array.isArray(v)) {
    const arr = node?.kind === "array" ? node : { kind: "array" as const, elem: null as Node | null };
    for (const item of v) if (item != null) arr.elem = merge(arr.elem ?? undefined, item);
    return arr;
  }
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    const obj = node?.kind === "object" ? node : { kind: "object" as const, fields: new Map<string, Node>() };
    for (const [k, val] of Object.entries(v)) {
      if (val == null) continue;
      obj.fields.set(k, merge(obj.fields.get(k), val));
    }
    return obj;
  }
  const sc =
    node?.kind === "scalar"
      ? node
      : { kind: "scalar" as const, prims: new Set<string>(), values: new Set<string>(), count: 0, enumOk: true };
  sc.prims.add(primOf(v));
  sc.count++;
  if (typeof v === "string") {
    if (ENUM_TOKEN.test(v)) {
      if (sc.values.size <= ENUM_MAX) sc.values.add(v);
    } else {
      sc.enumOk = false; // free text / urls / paths → not an enum
    }
  }
  return sc;
}

// Discovery samples hundreds of documents, so we do it once per collection and
// reuse the inferred shape. Without this, every query (and every retry, via both
// the synthesizer's schema context and the validator's field paths) re-samples
// the collection — the dominant source of query latency. warmSchemas() primes
// this at startup so even the first query is fast.
const schemaCache = new Map<CollectionName, Promise<Node>>();

/** Sample a collection and infer its document shape (excluding _id). Cached per collection. */
export async function discoverSchema(name: CollectionName): Promise<Node> {
  let pending = schemaCache.get(name);
  if (!pending) {
    pending = (async () => {
      const col = await getCollection(name);
      const docs = await col.find({}, { projection: { _id: 0 } }).limit(SAMPLE_SIZE).toArray();
      let root: Node = { kind: "object", fields: new Map() };
      for (const doc of docs) root = merge(root, doc);
      return root;
    })();
    // Don't cache a failed discovery (e.g. a transient DB hiccup) — that would
    // poison every later query. Drop it so the next call retries.
    pending.catch(() => schemaCache.delete(name));
    schemaCache.set(name, pending);
  }
  return pending;
}

/** Pre-discover every collection's schema (call at startup so the first query isn't slow). */
export async function warmSchemas(): Promise<void> {
  await Promise.all((Object.keys(COLLECTIONS) as CollectionName[]).map((name) => discoverSchema(name)));
}

/** Render an inferred node as compact type text: a|b enums, [T] arrays, {f: T} objects. */
export function renderNode(node: Node): string {
  if (node.kind === "object") {
    const fields = [...node.fields.entries()].map(([k, v]) => `${k}: ${renderNode(v)}`);
    return `{${fields.join(", ")}}`;
  }
  if (node.kind === "array") return `[${node.elem ? renderNode(node.elem) : "any"}]`;
  // Show a discovered enum only for a repeating, small, simple-token string vocabulary
  // (e.g. open|closed) — not for ids, logins, urls, or free text that happen to be low-cardinality.
  const isEnum =
    node.enumOk &&
    node.prims.size === 1 &&
    node.prims.has("string") &&
    node.values.size >= 2 &&
    node.values.size <= ENUM_MAX &&
    node.count >= Math.max(10, node.values.size * 3);
  if (isEnum) return [...node.values].sort().join("|");
  return [...node.prims].sort().join("|") || "any";
}

/** Collects every valid dotted field path from an inferred node (for validation). */
function collectPaths(node: Node, prefix: string, out: Set<string>): void {
  if (node.kind === "object") {
    for (const [k, v] of node.fields) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      collectPaths(v, path, out);
    }
  } else if (node.kind === "array" && node.elem) {
    collectPaths(node.elem, prefix, out); // array element fields share the parent path
  }
}

/** Valid field paths for a collection, discovered from the data. */
export async function collectFieldPaths(name: CollectionName): Promise<Set<string>> {
  const out = new Set<string>();
  collectPaths(await discoverSchema(name), "", out);
  return out;
}

/** Reads live MongoDB indexes for a collection and formats them as LLM hints. */
export async function describeIndexes(name: CollectionName): Promise<string> {
  const col = await getCollection(name);
  const indexes = await col.indexes();
  const lines = indexes
    .filter((ix) => ix.name !== "_id_")
    .map((ix) => {
      const keys = Object.entries(ix.key)
        .map(([f, dir]) => `${f}: ${dir === 1 ? "asc" : dir === -1 ? "desc" : dir}`)
        .join(", ");
      return `  (${keys})${ix.unique ? " [unique]" : ""}`;
    });
  return lines.length ? `${name} indexes:\n${lines.join("\n")}` : `${name} indexes: none`;
}

/**
 * Builds the schema context injected into the synthesis prompt: each collection's
 * shape (discovered by sampling the data) followed by its live index hints.
 */
export async function buildSchemaContext(): Promise<string> {
  const names = Object.keys(COLLECTIONS) as CollectionName[];
  const schemas = (
    await Promise.all(names.map(async (n) => `${n}:\n  ${renderNode(await discoverSchema(n))}`))
  ).join("\n\n");
  const indexes = (await Promise.all(names.map(describeIndexes))).join("\n\n");
  return `# Collections (discovered from sampled documents)\n\n${schemas}\n\n# Indexes (prefer these fields in filters/sorts)\n\n${indexes}`;
}
