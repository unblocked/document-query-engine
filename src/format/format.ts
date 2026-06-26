import type { Outcome } from "../engine/run.js";

/** A row that looks like an ingested PR/Issue doc, for citation rendering. */
interface DocRow {
  number: number;
  title: string;
  state?: string;
  user?: { login?: string };
  html_url: string;
}

function isDocRow(row: Record<string, unknown>): row is DocRow & Record<string, unknown> {
  return typeof row.number === "number" && typeof row.title === "string" && typeof row.html_url === "string";
}

/** Renders a single PR/Issue row with a citation. */
function formatDocRow(row: DocRow): string {
  const state = row.state ? ` [${row.state}]` : "";
  const author = row.user?.login ? ` by @${row.user.login}` : "";
  return `#${row.number} ${row.title}${state}${author}\n  ${row.html_url}`;
}

/** Renders an aggregation row (e.g. {_id: "open", count: 5}) as compact key=value pairs. */
function formatAggRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

/** Formats an engine outcome into human-readable text with citations. */
export function formatOutcome(outcome: Outcome): string {
  switch (outcome.type) {
    case "Success": {
      const lines = outcome.rows.map((row) => (isDocRow(row) ? formatDocRow(row) : formatAggRow(row)));
      return `${outcome.rows.length} result(s):\n\n${lines.join("\n\n")}`;
    }
    case "NoResults":
      return "No matching documents.";
    case "MaxAttemptsExceeded":
      return `Could not produce a valid query after ${outcome.attempts} attempts:\n- ${outcome.errors.join("\n- ")}`;
    case "ResolutionFailed":
      return `The model did not produce a query: ${outcome.reason}`;
    case "NotImplemented":
      return outcome.message;
  }
}
