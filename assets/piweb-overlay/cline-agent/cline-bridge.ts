// One Cline CLI process per agent run, driven over a loopback OpenAI-compatible endpoint.
//
// Cline keeps its own prompt, loop and tools; the model call, transcript and UI stay with
// Pi. Cline's request is therefore answered from Pi's stream: text is relayed as it
// arrives, and a tool call is handed to Cline only when Pi executes it. Nothing in
// Cline's request except its system prompt, tool list and tool results is used.
// The process starts in the background while the model is already working (see
// ClineTurn.create), and a run that never calls a tool stops it unused.
// No Pi imports: this file runs under plain Node for its protocol test.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export type ClineToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ClineTurnOptions = {
  bin: string;
  /** Arguments placed before Cline's own, for a binary started through a wrapper. */
  binArgs?: string[];
  cwd: string;
  /** Cline state and settings for this server; never the user's own ~/.cline. */
  homeDir: string;
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type Settle<T> = { resolve: (value: T) => void; reject: (error: Error) => void };
type QueuedCall = Settle<string> & { id: string; name: string; args: unknown };
type Endpoint = { port: number; turns: Map<string, ClineTurn> };
type ChatRequest = {
  model?: unknown;
  messages?: Array<{ role?: string; content?: unknown; tool_call_id?: unknown }>;
  tools?: Array<{ function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
};

const ENDPOINT = Symbol.for("pi-web.cline-bridge.endpoint");
const PLATFORM: Record<string, string> = { win32: "windows", darwin: "darwin", linux: "linux" };
// The model reads Pi's transcript, so Cline's copy of the prompt is never sent anywhere.
// Cline takes a single bare word for a mistyped subcommand, hence the sentence.
const PROMPT = "Continue the pi-web conversation.";
const KEEP_ALIVE_MS = 15_000;
const EXIT_GRACE_MS = 5_000;
const SESSION_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
/** The reason a turn we stopped ourselves reports; anything else that ends a turn is a failure. */
export const CLINE_STOPPED = "Cline 已停止";

/** `<agentDir>/cline-agent` holds the pinned CLI (`cli/`) and its state (`home/`). */
export function resolveClineBinary(clineDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.PI_WEB_CLINE_BIN?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const platform = PLATFORM[process.platform];
  if (!platform) return undefined;
  const bin = join(clineDir, "cli", "node_modules", "@cline", `cli-${platform}-${process.arch}`, "bin", process.platform === "win32" ? "cline.exe" : "cline");
  return existsSync(bin) ? bin : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

function getEndpoint(): Promise<Endpoint> {
  const holder = globalThis as unknown as Record<symbol, Promise<Endpoint> | undefined>;
  holder[ENDPOINT] ??= new Promise<Endpoint>((resolve, reject) => {
    const turns = new Map<string, ClineTurn>();
    const server = http.createServer((req, res) => {
      void route(turns, req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      });
    });
    server.once("error", reject);
    // Loopback only, random port: reachable by the Cline child and nothing off this machine.
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ port: (server.address() as AddressInfo).port, turns });
    });
  }).catch((error) => {
    // A failed bind must not stay cached: the next turn tries again.
    holder[ENDPOINT] = undefined;
    throw error;
  });
  return holder[ENDPOINT];
}

async function route(turns: Map<string, ClineTurn>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reject = (status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  };
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) return reject(404, "not found");
  req.setEncoding("utf8");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw) as ChatRequest;
  const turn = turns.get(String(body.model));
  if (!turn) return reject(404, "unknown Cline turn");
  turn.accept(body, res);
}

function writeProviderSettings(homeDir: string, port: number): void {
  const file = join(homeDir, "data", "settings", "providers.json");
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const settings = {
    version: 1,
    lastUsedProvider: "openai-compatible",
    modes: {},
    providers: {
      "openai-compatible": {
        settings: { provider: "openai-compatible", apiKey: "pi-web", model: "pi-web", baseUrl },
        updatedAt: new Date(0).toISOString(),
        tokenSource: "manual",
      },
    },
  };
  const next = JSON.stringify(settings, null, 2);
  if (existsSync(file) && readFileSync(file, "utf8") === next) return;
  mkdirSync(join(homeDir, "data", "settings"), { recursive: true });
  mkdirSync(join(homeDir, "config"), { recursive: true });
  writeFileSync(file, next);
}

const pruned = new Set<string>();
/** Cline writes a transcript per process and nothing reads one back; drop old ones once per server start. */
function pruneSessions(homeDir: string): void {
  if (pruned.has(homeDir)) return;
  pruned.add(homeDir);
  const dir = join(homeDir, "data", "sessions");
  const cutoff = Date.now() - SESSION_KEEP_MS;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("[pi-web] Cline transcript cleanup failed:", error);
  }
}

export class ClineTurn {
  readonly token = `pi-web-${randomUUID()}`;
  /** Cline's own system prompt and tool list, read from its first request. */
  system = "";
  tools: ClineToolSpec[] = [];

  private child: ChildProcess | null = null;
  private open: ServerResponse | null = null;
  private ended: string | null = null;
  private finished = false;
  /** Cline has made its first request, so it is up and its prompt and tools are known. */
  private seen = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private queued: QueuedCall[] = [];
  private pending = new Map<string, QueuedCall>();
  private openWaiters: Array<Settle<void> & { timer: ReturnType<typeof setTimeout> }> = [];
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private output: string[] = [];
  private requestTimeoutMs = 120_000;
  private release: () => void = () => {};

  /**
   * Start Cline and return at once. About a second goes to loading the program before it
   * does anything, so nothing here waits for it: a call made before its first request
   * queues up behind it, and `whenOpen` says when it is ready.
   */
  static create(options: ClineTurnOptions): ClineTurn {
    const turn = new ClineTurn();
    turn.requestTimeoutMs = options.requestTimeoutMs ?? turn.requestTimeoutMs;
    void turn.launch(options);
    return turn;
  }

  private async launch(options: ClineTurnOptions): Promise<void> {
    try {
      const endpoint = await getEndpoint();
      if (this.ended !== null) return; // stopped before there was anything to stop
      writeProviderSettings(options.homeDir, endpoint.port);
      pruneSessions(options.homeDir);
      endpoint.turns.set(this.token, this);
      this.release = () => endpoint.turns.delete(this.token);
      const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
      const child = spawn(options.bin, [
        ...(options.binArgs ?? []),
        "--json", "--auto-approve", "true", "--compaction", "off",
        "--config", join(options.homeDir, "config"), "--data-dir", join(options.homeDir, "data"),
        "-c", options.cwd, "-P", "openai-compatible", "-m", this.token, PROMPT,
      ], {
        cwd: options.cwd,
        env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy, CLINE_NO_AUTO_UPDATE: "1", DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      const remember = (chunk: string) => {
        this.output.push(...chunk.split(/\r?\n/).filter(Boolean));
        this.output.splice(0, Math.max(0, this.output.length - 20));
      };
      child.stdout?.setEncoding("utf8").on("data", remember);
      child.stderr?.setEncoding("utf8").on("data", remember);
      child.once("error", (error) => this.end(`Cline 启动失败：${error.message}`));
      child.once("exit", (code) => this.end(`Cline 进程已退出（${code ?? "被终止"}）${this.output.length ? `：${this.output.slice(-3).join(" | ").slice(0, 600)}` : ""}`));
      const startMs = options.startTimeoutMs ?? 60_000;
      this.startTimer = setTimeout(() => this.stop(`Cline 在 ${Math.round(startMs / 1000)} 秒内没有发起请求`), startMs);
      this.startTimer.unref();
    } catch (error) {
      this.stop(`Cline 启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get alive(): boolean {
    return this.ended === null && !this.finished;
  }

  accept(body: ChatRequest, res: ServerResponse): void {
    this.seen = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!this.system) {
      this.system = contentText(messages.find((message) => message.role === "system")?.content);
      this.tools = (body.tools ?? []).flatMap((tool) => tool.function?.name
        ? [{ name: tool.function.name, description: tool.function.description ?? "", parameters: tool.function.parameters ?? { type: "object", properties: {} } }]
        : []);
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    this.open?.end();
    this.setOpen(res);
    res.once("close", () => { if (this.open === res) this.setOpen(null); });
    if (this.finished) return this.close("stop");

    for (const message of messages) {
      if (message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
      const call = this.pending.get(message.tool_call_id);
      if (!call) continue;
      this.pending.delete(message.tool_call_id);
      call.resolve(contentText(message.content));
    }
    // Every handed-over call is answered by the request that follows it, or never.
    this.rejectAll(this.pending, "Cline 没有返回这次工具调用的结果");
    for (const waiter of this.openWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(); }
  }

  /** Relay assistant text to the open response; text that has nowhere to go is dropped. */
  text(delta: string): void {
    if (delta) this.write({ role: "assistant", content: delta });
  }

  /** Hand one tool call to Cline and resolve with the result its next request carries. */
  callTool(id: string, name: string, args: unknown, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.ended) return reject(new Error(this.ended));
      if (signal?.aborted) return reject(new Error("Operation aborted"));
      const call: QueuedCall = { id, name, args, resolve, reject };
      // Cline cannot cancel one tool, and a stopped run must not leave its command running.
      signal?.addEventListener("abort", () => {
        reject(new Error("Operation aborted"));
        this.dispose();
      }, { once: true });
      this.queued.push(call);
      // Calls Pi starts in the same tick are one assistant message for Cline.
      if (this.queued.length === 1) setImmediate(() => void this.flush());
    });
  }

  private async flush(): Promise<void> {
    try {
      await this.whenOpen(this.requestTimeoutMs);
    } catch (error) {
      for (const call of this.queued.splice(0)) call.reject(error as Error);
      return;
    }
    const calls = this.queued.splice(0);
    if (calls.length === 0) return;
    for (const call of calls) this.pending.set(call.id, call);
    this.write({
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      })),
    });
    this.close("tool_calls");
  }

  /** Resolve once Cline has a request waiting for the next piece of the assistant turn. */
  whenOpen(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.open) return Promise.resolve();
    if (this.ended) return Promise.reject(new Error(this.ended));
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
    return new Promise<void>((resolve, reject) => {
      const abandon = (reason: string) => {
        this.openWaiters = this.openWaiters.filter((item) => item !== waiter);
        clearTimeout(waiter.timer);
        reject(new Error(reason));
      };
      const waiter = {
        resolve, reject,
        timer: setTimeout(() => abandon(`Cline 在 ${Math.round(timeoutMs / 1000)} 秒内没有发起请求`), timeoutMs),
      };
      signal?.addEventListener("abort", () => abandon("Operation aborted"), { once: true });
      this.openWaiters.push(waiter);
    });
  }

  /** The agent run is over: give Cline its final answer so it exits on its own. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    // A process that has not asked for anything was not needed this run: stop it rather than let it load.
    if (!this.seen) return this.dispose();
    if (this.open) this.close("stop");
    if (this.ended === null) this.exitTimer = setTimeout(() => this.dispose(), EXIT_GRACE_MS);
  }

  dispose(): void {
    this.stop(CLINE_STOPPED);
  }

  private stop(reason: string): void {
    const child = this.child;
    this.end(reason);
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      // Cline's tools are grandchildren; only a tree kill stops them too.
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    } else {
      child.kill("SIGTERM");
    }
  }

  private end(reason: string): void {
    if (this.ended !== null) return;
    this.ended = reason;
    this.release();
    if (this.exitTimer) clearTimeout(this.exitTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.open?.end();
    this.setOpen(null);
    const error = new Error(reason);
    for (const waiter of this.openWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    for (const call of this.queued.splice(0)) call.reject(error);
    this.rejectAll(this.pending, reason);
  }

  private rejectAll(calls: Map<string, QueuedCall>, reason: string): void {
    for (const call of calls.values()) call.reject(new Error(reason));
    calls.clear();
  }

  private setOpen(res: ServerResponse | null): void {
    this.open = res;
    if (this.keepAlive) clearInterval(this.keepAlive);
    // A reasoning model or a Pi-side tool can stay silent for minutes; an empty delta
    // keeps Cline's HTTP client from timing the response out.
    this.keepAlive = res ? setInterval(() => this.write({ content: "" }), KEEP_ALIVE_MS) : null;
    this.keepAlive?.unref();
  }

  private write(delta: Record<string, unknown>, finishReason: string | null = null): void {
    this.open?.write(`data: ${JSON.stringify({
      id: this.token, object: "chat.completion.chunk", created: 0, model: this.token,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } : {}),
    })}\n\n`);
  }

  private close(finishReason: "stop" | "tool_calls"): void {
    this.write({}, finishReason);
    this.open?.end("data: [DONE]\n\n");
    this.setOpen(null);
  }
}
