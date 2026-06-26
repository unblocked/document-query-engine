import type { IngestProgress } from "../github/ingest.js";

// A dependency-free, TTY-aware progress reporter for the ingestion CLI.
// On a terminal it animates a braille spinner with a live counter per phase;
// when piped to a file/CI it degrades to plain one-line-per-phase output.

const isTTY = Boolean(process.stdout.isTTY);
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** ANSI color wrapper — a no-op when not attached to a terminal. */
const paint = (code: number) => (s: string | number) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);
const gray = paint(90);

const CLEAR_LINE = "\x1b[2K\r"; // erase the current line, return to column 0

function fmtElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Pretty terminal reporter implementing the ingestion's IngestProgress hooks. */
export class Reporter implements IngestProgress {
  private frame = 0;
  private count = 0;
  private label = "";
  private hint = "";
  private phaseStart = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Prints the header banner for an ingestion run. */
  start(slug: string): void {
    const t = new Date().toISOString().slice(11, 19);
    process.stdout.write(`\n${cyan("◆")} ${bold("Ingesting")} ${bold(cyan(slug))} ${gray(`· ${t} UTC`)}\n\n`);
  }

  phase(label: string, hint = ""): void {
    this.endPhase(); // close any open phase first
    this.label = label;
    this.hint = hint;
    this.count = 0;
    this.phaseStart = Date.now();
    if (isTTY) {
      this.render();
      this.timer = setInterval(() => this.render(), 80);
    } else {
      process.stdout.write(`→ ${label}${hint ? ` ${dim(`(${hint}`)})` : ""}\n`);
    }
  }

  tick(n = 1): void {
    this.count += n;
    if (isTTY && !this.timer) this.render(); // keep the line fresh between spinner frames
  }

  /** A one-off informational line, printed above the active phase. */
  info(msg: string): void {
    if (isTTY) process.stdout.write(`${CLEAR_LINE}${gray("·")} ${dim(msg)}\n`);
    else process.stdout.write(`· ${msg}\n`);
    if (isTTY && this.timer) this.render();
  }

  endPhase(): void {
    if (!this.label) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const elapsed = fmtElapsed(Date.now() - this.phaseStart);
    const line = `${green("✓")} ${bold(this.label.padEnd(16))} ${green(String(this.count).padStart(5))} ${gray(`· ${elapsed}`)}`;
    process.stdout.write(isTTY ? `${CLEAR_LINE}${line}\n` : `✓ ${this.label}: ${this.count} (${elapsed})\n`);
    this.label = "";
  }

  /** Renders the live spinner line (TTY only). */
  private render(): void {
    const spin = cyan(FRAMES[this.frame++ % FRAMES.length]!);
    const hint = this.hint ? `  ${dim(this.hint)}` : "";
    const elapsed = gray(`· ${fmtElapsed(Date.now() - this.phaseStart)}`);
    process.stdout.write(`${CLEAR_LINE}${spin} ${bold(this.label.padEnd(16))} ${cyan(String(this.count).padStart(5))}${hint}  ${elapsed}`);
  }

  /** Prints the final summary box. Pads raw strings (ANSI codes have width 0). */
  finish(counts: Record<string, number>, totalMs: number): void {
    this.endPhase();
    const rows: [string, string][] = [
      ...Object.entries(counts).map(([k, v]) => [k, String(v)] as [string, string]),
      ["elapsed", fmtElapsed(totalMs)],
    ];
    const title = "Ingestion complete";
    const kw = Math.max(...rows.map(([k]) => k.length));
    const vw = Math.max(...rows.map(([, v]) => v.length));
    const inner = Math.max(kw + vw + 6, title.length + 4); // "  k  v  " or "─ title ─…"

    const top = `╭─ ${bold(title)} ${"─".repeat(inner - title.length - 3)}╮`;
    const bottom = `╰${"─".repeat(inner)}╯`;
    process.stdout.write(`\n${green(top)}\n`);
    for (const [k, v] of rows) {
      const label = dim(k.padEnd(kw));
      const value = (k === "elapsed" ? yellow : green)(v.padStart(vw));
      process.stdout.write(`${green("│")}  ${label}  ${value}${" ".repeat(inner - kw - vw - 4)}${green("│")}\n`);
    }
    process.stdout.write(`${green(bottom)}\n\n`);
  }

  /** Tears down the spinner and prints a failure line (on error). */
  fail(msg: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write(`${isTTY ? CLEAR_LINE : ""}${red("✗")} ${red(msg)}\n`);
  }
}
