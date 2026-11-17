// Cline's system prompt and tool list can only be read from the first request of a Cline
// process, and the process needs about a second to load before it makes one. They hardly
// change, so they are kept per working directory and Cline build: a run then calls the
// model at once and the process comes up meanwhile.
// No Pi imports: this file runs under plain Node for its test.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClineToolSpec } from "./cline-bridge";

export type ClinePrompt = { system: string; tools: ClineToolSpec[] };

const MAX_ENTRIES = 24;
// How Cline writes today's date into its prompt, e.g. "2. Date: 2026/11/17".
const DATE_LINE = /(\bDate: )\d{4}\/\d{2}\/\d{2}/;

const pad = (value: number) => String(value).padStart(2, "0");
const isoDay = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/** A prompt captured on an earlier day, with today's date in place; undefined when its date line is not one we can read. */
export function promptForDay(system: string, now: Date): string | undefined {
  if (!/\bDate:/.test(system)) return system;
  if (!DATE_LINE.test(system)) return undefined;
  const today = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  return system.replace(DATE_LINE, (_line, label: string) => label + today);
}

/** One entry per working directory and Cline build, so an updated binary never reuses an old prompt. */
export function promptCacheKey(bin: string, cwd: string): string {
  const { size, mtimeMs } = statSync(bin);
  return [bin, size, Math.round(mtimeMs), cwd].join("|");
}

const entryFile = (dir: string, key: string) => join(dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);

const isTool = (value: unknown): value is ClineToolSpec => {
  const tool = value as Partial<ClineToolSpec> | null;
  return typeof tool?.name === "string" && typeof tool.description === "string" && typeof tool.parameters === "object" && tool.parameters !== null;
};

/** The saved prompt for `key`, dated today; undefined when there is none or it cannot be trusted. */
export function readPrompt(dir: string, key: string, now = new Date()): ClinePrompt | undefined {
  try {
    const entry = JSON.parse(readFileSync(entryFile(dir, key), "utf8")) as { key?: unknown; day?: unknown; system?: unknown; tools?: unknown };
    if (entry.key !== key || typeof entry.system !== "string" || !entry.system || !Array.isArray(entry.tools) || entry.tools.length === 0 || !entry.tools.every(isTool)) return undefined;
    const system = entry.day === isoDay(now) ? entry.system : promptForDay(entry.system, now);
    return system === undefined ? undefined : { system, tools: entry.tools };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[pi-web] Cline prompt cache unreadable:", error);
    return undefined;
  }
}

export function writePrompt(dir: string, key: string, prompt: ClinePrompt, now = new Date()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = entryFile(dir, key);
    const next = JSON.stringify({ key, day: isoDay(now), system: prompt.system, tools: prompt.tools });
    if (existsSync(file) && readFileSync(file, "utf8") === next) return;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, next);
    renameSync(temp, file);
    prune(dir);
  } catch (error) {
    console.error("[pi-web] Cline prompt cache not saved:", error);
  }
}

/** Keep the most recently written entries; one that is still in use is rewritten at least daily. */
function prune(dir: string): void {
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { path } of entries.slice(MAX_ENTRIES)) rmSync(path, { force: true });
}
