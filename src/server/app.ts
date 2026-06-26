import express, { type Express, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getCollection } from "../db.js";
import { COLLECTIONS, type CollectionName } from "../models/index.js";
import { runQuery } from "../engine/run.js";
import { runAgent } from "../agent/chat.js";
import type { LlmMessage } from "../llm/provider.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Builds the Express app: static frontend + JSON API (stats + query) + SSE chat. */
export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Document counts per collection — shown as a status line in the header.
  app.get("/api/stats", async (_req, res) => {
    const names = Object.keys(COLLECTIONS) as CollectionName[];
    const counts = await Promise.all(
      names.map(async (n) => [n, await (await getCollection(n)).countDocuments()] as const),
    );
    res.json(Object.fromEntries(counts));
  });

  // Query playground: natural language -> generated plan + raw results.
  app.post("/api/query", async (req: Request, res: Response) => {
    const question = String(req.body?.question ?? "").trim();
    if (!question) {
      res.status(400).json({ error: "question required" });
      return;
    }
    const outcome = await runQuery(question);
    res.json(outcome);
  });

  // Chat agent: streams the agent loop's events as Server-Sent Events.
  app.post("/api/chat", async (req: Request, res: Response) => {
    const messages = req.body?.messages as LlmMessage[] | undefined;
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: "messages array required" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    for await (const event of runAgent(messages)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });

  return app;
}
