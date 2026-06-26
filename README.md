# Beyond RAG: Structured Query Synthesis for Engineering Context

Workshop project. Build a structured query engine that turns natural language into
validated MongoDB aggregation pipelines over GitHub PR and Issue data.

Semantic RAG finds similar documents — but it can't reason about time, traverse
relationships, or apply precise filters. Agents need more than similarity search:
they need structured, queryable access to the data behind their workflows.

## How the workshop works

You start with the **whole app already built** — a web UI with a query playground
and a chat agent — but the **query engine is a stub**: every query comes back
*"not implemented yet."* Across the steps you build the engine and watch the UI come
alive. See [PLAN.md](./PLAN.md).

- **Step 0 (this branch):** set up MongoDB, ingest a repo, boot the web app.
- **Steps 1–6:** schema discovery → identity resolution → synthesis → validation →
  retry → full-text search.

## Stack

- [Bun](https://bun.sh) — runtime, package manager, and TypeScript runner
- MongoDB (local via Docker, an existing instance, or Atlas)
- `mongodb`, `@octokit/rest`, `express`, `zod`, and an LLM SDK (`@anthropic-ai/sdk` or `openai`)

## Prerequisites

- **Bun** — install from [bun.sh](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`
  or `brew install oven-sh/bun/bun`); check with `bun --version`. Bun runs the TypeScript
  directly and auto-loads `.env`.
- **GitHub CLI** *(optional, but strongly recommended)* — install
  [`gh`](https://cli.github.com/) and run `gh auth login`; the ingest script picks up its
  token automatically (leave `GITHUB_TOKEN` blank). Easiest path by far.
- **A GitHub token** — only if you skip the CLI: set a
  [personal access token](https://github.com/settings/tokens) in `GITHUB_TOKEN`
  (`public_repo`, or `repo` for private).
- **An LLM API key** — either [Anthropic](https://console.anthropic.com/) (`sk-ant-…`) or
  [OpenAI](https://platform.openai.com/api-keys) (`sk-…`). If both are set, OpenAI is used.
- **MongoDB** — the engine queries a MongoDB instance, so you need one. Easiest is
  **Docker** (`docker compose up -d` spins up `mongo:7` locally); or use an existing
  instance, or a free [Atlas](https://www.mongodb.com/cloud/atlas/register) cluster.
  Details in step 3 below.
- **Docker** — needed only for the easy MongoDB route above (so `docker compose up -d`
  works). Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or
  Engine + Compose). Skip if you bring your own MongoDB or use Atlas.

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure secrets

```bash
cp .env.example .env        # then edit it — see "Your .env" below
```

### 3. Get a MongoDB (pick one)

**A — Docker (simplest):**
```bash
docker compose up -d        # mongo:7 on localhost:27017
```
The default `MONGO_URI=mongodb://localhost:27017` already points at it.

**B — You already run MongoDB** (locally or in a container): skip Docker. Point
`MONGO_URI` at your instance and use a dedicated DB name so you don't clash with
existing data:
```ini
MONGO_URI=mongodb://localhost:27017   # or your host/container
MONGO_DB=dqe_workshop
```

**C — No Docker, no MongoDB:** install
[MongoDB Community](https://www.mongodb.com/docs/manual/administration/install-community/),
or create a free [Atlas](https://www.mongodb.com/cloud/atlas/register) cluster and set
`MONGO_URI` to its connection string.

> Already have a Mongo container on 27017? Use option B, or change the published port
> in `docker-compose.yml` and match `MONGO_URI`.

### 4. Initialize and ingest

```bash
bun run db:init                  # create indexes; prints which Mongo it connected to
bun run ingest -- owner/repo     # e.g. bun run ingest -- facebook/react
```

### 5. Boot the app

```bash
bun run serve                    # opens http://localhost:3000 — Query / Chat tabs
```

The app runs and the data browses — but the **engine is stubbed**, so a query (or a
chat question) returns *"not implemented yet."* Building it is the workshop.

## Your `.env`

```ini
# GitHub: leave blank to use the `gh` CLI token, or paste a PAT.
GITHUB_TOKEN=

# LLM: set ONE. If OPENAI_API_KEY is present the engine uses OpenAI, else Anthropic.
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=

# MongoDB
MONGO_URI=mongodb://localhost:27017
MONGO_DB=workshop

# Your GitHub login — treated as "me" / "my" in natural-language queries.
CALLER_LOGIN=your-github-login
```
