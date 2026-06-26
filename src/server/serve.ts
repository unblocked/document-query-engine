import { spawn } from "node:child_process";
import { createApp } from "./app.js";
import { closeDb } from "../db.js";

const PORT = Number(process.env.PORT) || 3000;

/** Opens the default browser at `url` (best-effort, cross-platform). Set NO_OPEN=1 to skip. */
function openBrowser(url: string): void {
  if (process.env.NO_OPEN) return;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true })
      .on("error", () => {}) // browser missing / headless — ignore
      .unref();
  } catch {
    // best-effort only
  }
}

function main(): void {
  const url = `http://localhost:${PORT}`;
  const server = createApp().listen(PORT, () => {
    console.log(`document-query-engine running at ${url}`);
    openBrowser(url);
  });
  const shutdown = () => server.close(() => closeDb().then(() => process.exit(0)));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
