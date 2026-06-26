# Build Plan

The app is built **UX-first**: Step 0 ships the full web app (query playground +
chat agent) with the query engine **stubbed** — every query returns
`NotImplemented`. Step 0 also freezes the engine's public interface (`runQuery` →
`Outcome`), so the UX never changes again. Each step fills in engine internals
until the UI comes alive.

| Step | Branch | Builds |
|------|--------|--------|
| 0 — Foundation + UX (stubbed engine) | `main` | data models, MongoDB, ingestion (with display names), full web app (Query + Chat), chat agent, and `runQuery()` stub returning `NotImplemented` |
| 1 — Schema description | `step-1-schema` | `describe.ts`: zod → compact schema text + live index hints (what the LLM is told it can query) |
| 2 — Identity resolution | `step-2-identity` | `resolver.ts`: resolve a name/login (and "me") to GitHub logins via the users directory |
| 3 — Synthesis | `step-3-synthesis` | the tool + prompt + `synthesize()`; wire `runQuery` to synthesize → execute → format. **The engine now returns real results.** |
| 4 — Validation | `step-4-validation` | `validate.ts`: stage/operator whitelist, field-existence, blocked fields; reject bad plans before executing |
| 5 — Retry loop | `step-5-retry` | feed validation/runtime errors back to the model so it self-corrects (`Success | NoResults | MaxAttemptsExceeded`) |
| 6 — Full-text search | `step-6-fulltext` | MongoDB `$text` index + allow `$text` in the validator + prompt guidance for topic/keyword questions |

## Arc

- **Step 0** — get set up: Mongo, ingest, boot the app (engine says "not implemented")
- **Steps 1–3** — make it work: describe the schema, resolve people, synthesize and run a query
- **Steps 4–5** — make it robust: validate the generated query, and let it self-correct
- **Step 6** — make it richer: full-text topic search
