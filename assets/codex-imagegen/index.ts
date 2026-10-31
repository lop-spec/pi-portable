// Pi adapter for the OpenAI Codex image-generation protocol.
// Based on https://github.com/openai/codex/tree/main/codex-rs/ext/image-generation
// and codex-rs/codex-api/src/endpoint/images.rs (Apache-2.0). Adapted for Pi.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

const host = "chatgpt.com";
const base = "/backend-api/codex/images/";
const maxImageBytes = 10 * 1024 * 1024;
const maxResponseBytes = 32 * 1024 * 1024;
const sizes = ["auto", "1024x1024", "1024x1536", "1536x1024"] as const;
const qualities = ["auto", "low", "medium", "high"] as const;
// These are requestable model names, not a claim about the model the Codex backend runs.
// The backend does not return a model ID and has accepted even unknown IDs in testing.
const models = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5"] as const;
const defaultModel = models[0];

async function poolIdentity(ctx: ExtensionContext): Promise<{ token: string; account: string }> {
  // Consult the running bridge's current or explicitly pinned identity, without changing it.
  let health: any;
  try {
    const response = await fetch("http://127.0.0.1:8794/health", { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error();
    health = await response.json();
  } catch { throw new Error("Codex 桥不可用，无法确定当前账号。"); }

  const member = health.accounts?.find((a: any) => a.pinned) || health.accounts?.find((a: any) => a.active);
  if (member && Number(member.cooldownMinLeft) > 0) throw new Error("当前 Codex 账号正在冷却，请等待账号池恢复。");
  let token: string | undefined;
  let account = "";
  if (health.authMode === "account-pool" && member && member.identity !== "downstream") {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(member.id) || typeof health.accountHomes !== "string") {
      throw new Error("Codex 账号池状态无效。");
    }
    const slot = path.join(health.accountHomes, member.id);
    let authPath = path.join(slot, "auth.json");
    try {
      // External slots keep their original credentials in place; no copies or refreshes.
      try {
        const marker = JSON.parse(await readFile(path.join(slot, ".pi-external-codex.json"), "utf8"));
        if (marker.version !== 1 || !path.isAbsolute(marker.sourcePath)) throw new Error();
        authPath = marker.sourcePath;
      } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
      const auth = JSON.parse(await readFile(authPath, "utf8"));
      token = auth.tokens?.access_token;
      account = auth.tokens?.account_id || auth.account_id || "";
    } catch { throw new Error("无法读取当前 Codex 账号池身份。"); }
  } else if (health.authMode !== "account-pool" || member?.identity === "downstream") {
    token = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
  } else {
    throw new Error("Codex 账号池没有当前可用身份。");
  }
  if (!token || /\s/.test(token)) throw new Error("当前 Codex 身份不可用。");
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) * 1000 <= Date.now()) throw new Error("expired");
    account ||= payload["https://api.openai.com/auth"]?.chatgpt_account_id || "";
  } catch { throw new Error("当前 Codex 身份无效或已过期。"); }
  if (!account || /\s/.test(account)) throw new Error("当前 Codex 身份缺少账号标识。");
  return { token, account };
}

function proxyAgent(signal?: AbortSignal): https.Agent {
  // The registered local system proxy is 10808. Override explicitly if this machine changes it;
  // no automatic direct connection or proxy-node switching is performed.
  const configured = process.env.PI_CODEX_IMAGE_PROXY || "http://127.0.0.1:10808";
  const agent = new https.Agent({ keepAlive: false });
  if (configured === "direct") return agent;
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error("图片代理地址无效。"); }
  if (url.protocol !== "http:" || url.username || url.password || !url.port || url.pathname !== "/") {
    throw new Error("图片代理只支持不带凭据的 HTTP CONNECT 地址。");
  }
  agent.createConnection = (_options: any, callback: any) => {
    let settled = false;
    const done = (err?: Error | null, socket?: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      callback(err || null, socket);
    };
    const connect = http.request({ hostname: url.hostname, port: Number(url.port), method: "CONNECT", path: `${host}:443`, headers: { Host: `${host}:443` }, signal });
    connect.setTimeout(15000, () => connect.destroy(new Error("proxy-timeout")));
    connect.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); done(new Error(`proxy-http-${response.statusCode}`)); return; }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
      secure.setTimeout(15000, () => secure.destroy(new Error("tls-timeout")));
      secure.once("secureConnect", () => { secure.setTimeout(0); done(null, secure); });
      secure.once("error", (error) => done(error));
    });
    connect.once("error", (error) => done(error));
    connect.end();
  };
  return agent;
}

async function imageRequest(body: unknown, edit: boolean, identity: {token: string; account: string}, signal?: AbortSignal): Promise<any> {
  const data = Buffer.from(JSON.stringify(body));
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const agent = proxyAgent(combined);
  try {
    const result: { status: number; body: Buffer } = await new Promise((resolve, reject) => {
      const request = https.request({ hostname: host, path: base + (edit ? "edits" : "generations"), method: "POST", agent, signal: combined,
        headers: { authorization: `Bearer ${identity.token}`, "chatgpt-account-id": identity.account,
          "content-type": "application/json", "content-length": data.length, originator: "codex_cli_rs", "x-codex-image-turn-id": randomUUID() },
      }, response => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxResponseBytes) request.destroy(new Error("response-too-large"));
          else chunks.push(chunk);
        });
        response.once("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks) }));
        response.once("error", reject);
      });
      request.once("error", reject);
      request.end(data);
    });
    let json: any;
    try { json = JSON.parse(result.body.toString("utf8")); } catch { throw new Error(`图片服务返回非 JSON（HTTP ${result.status}）。`); }
    if (result.status !== 200) {
      const code = String(json.error?.code || json.error?.type || "");
      const suffix = /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? `，${code}` : "";
      throw new Error(`图片服务请求失败（HTTP ${result.status}${suffix}）。`);
    }
    return json;
  } finally { agent.destroy(); }
}

function imageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new Error("参考图必须是 PNG、JPEG 或 WebP。");
}

type InputImage = { type: "image"; data: string; mimeType: string };

async function references(paths: string[], useLast: boolean, ctx: ExtensionContext, inputImages: InputImage[] = []): Promise<{image_url: string}[]> {
  const images: {image_url: string}[] = [];
  for (const name of paths) {
    const filename = path.resolve(ctx.cwd, name);
    const info = await stat(filename);
    if (!info.isFile() || info.size > maxImageBytes) throw new Error("参考图不是文件或超过 10MB。");
    const bytes = await readFile(filename);
    if (bytes.length > maxImageBytes) throw new Error("参考图超过 10MB。");
    images.push({ image_url: `data:${imageMime(bytes)};base64,${bytes.toString("base64")}` });
  }
  let lastImages: InputImage[] = [];
  if (useLast) {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((e: any) => {
      const content = e.type === "message" && e.message?.role === "user" ? e.message.content
        : e.type === "custom_message" && e.customType === "codex-imagegen-input" ? e.content : undefined;
      return Array.isArray(content) && content.some((c: any) => c.type === "image");
    }) as any;
    if (!entry) throw new Error("本会话没有可用的用户附件图像。");
    lastImages = (entry.type === "message" ? entry.message.content : entry.content).filter((item: any) => item.type === "image");
  }
  if (images.length + lastImages.length + inputImages.length > 5) throw new Error("参考图最多 5 张。");
  for (const item of [...lastImages, ...inputImages]) {
    if (typeof item.data !== "string" || item.data.length > Math.ceil(maxImageBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) {
      throw new Error("用户附件图像超过 10MB 或无效。");
    }
    const bytes = Buffer.from(item.data, "base64");
    if (bytes.length > maxImageBytes) throw new Error("用户附件图像超过 10MB 或无效。");
    images.push({ image_url: `data:${imageMime(bytes)};base64,${bytes.toString("base64")}` });
  }
  return images;
}

type ImageParams = { prompt: string; model?: string; reference_paths?: string[]; use_last_user_images?: boolean; size?: string; quality?: string; output_path?: string };

async function generate(params: ImageParams, signal: AbortSignal | undefined, ctx: ExtensionContext, inputImages: InputImage[] = []) {
  if (!params.prompt.trim()) throw new Error("图片提示词不能为空。");
  const requestedModel = params.model || defaultModel;
  if (!(models as readonly string[]).includes(requestedModel)) throw new Error(`不支持的请求模型，可选：${models.join("、")}。`);
  if (params.output_path && path.extname(params.output_path).toLowerCase() !== ".png") throw new Error("输出文件必须以 .png 结尾。");
  const images = await references(params.reference_paths || [], params.use_last_user_images === true, ctx, inputImages);
  const body: any = { model: requestedModel, prompt: params.prompt, size: params.size || "auto", quality: params.quality || "auto" };
  if (images.length) body.images = images;
  const identity = await poolIdentity(ctx);
  const response = await imageRequest(body, images.length > 0, identity, signal);
  const base64 = response.data?.[0]?.b64_json;
  if (typeof base64 !== "string") throw new Error("图片服务没有返回图像数据。");
  const bytes = Buffer.from(base64, "base64");
  if (imageMime(bytes) !== "image/png") throw new Error("图片服务返回了非 PNG 图像。");
  const session = ctx.sessionManager.getSessionId().replace(/[^a-z0-9_-]/gi, "");
  const filename = params.output_path ? path.resolve(ctx.cwd, params.output_path) : path.join(ctx.cwd, "generated-images", session, `image-${randomUUID()}.png`);
  if (path.extname(filename).toLowerCase() !== ".png") throw new Error("输出文件必须以 .png 结尾。");
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, bytes, { flag: "wx" });
  return { content: [ { type: "text" as const, text: `图片已保存：${filename}\n请求模型：${requestedModel}（Codex 服务未返回实际模型）` }, { type: "image" as const, data: base64, mimeType: "image/png" } ], details: { path: filename, requestedModel, actualModel: null, edited: images.length > 0, size: response.size, quality: response.quality } };
}

export default function (pi: ExtensionAPI) {
  const directInFlight = new Set<string>();
  const persistenceFailed = Symbol.for("pi.codex-imagegen.persistence-failed");

  function verifyWrittenBytes(file: string, expected: Buffer, offset: number) {
    const fd = openSync(file, "r");
    try {
      if (fstatSync(fd).size !== offset + expected.length) throw new Error("消息未写入磁盘");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expected.length));
      for (let at = 0; at < expected.length; at += chunk.length) {
        const count = Math.min(chunk.length, expected.length - at);
        const actual = readSync(fd, chunk, 0, count, offset + at);
        if (actual !== count || !chunk.subarray(0, count).equals(expected.subarray(at, at + count))) throw new Error("会话消息读回不一致");
      }
    } finally { closeSync(fd); }
  }

  function recordTitle(ctx: ExtensionContext, name: string) {
    const manager = ctx.sessionManager as any;
    try {
      const file = manager.getSessionFile();
      if (!manager.persist || !file) throw new Error("会话未持久化");
      const flushed = Boolean(manager.flushed);
      const beforeBytes = flushed ? statSync(file).size : 0;
      const beforeCount = manager.getEntries().length;
      const normalizedName = name.replace(/[\r\n]+/g, " ").trim();
      pi.setSessionName(normalizedName);
      const entry = manager.getEntries()[beforeCount];
      if (!entry || entry.type !== "session_info" || entry.name !== normalizedName) throw new Error("标题未写入会话");
      if (flushed) verifyWrittenBytes(file, Buffer.from(JSON.stringify(entry) + "\n"), beforeBytes);
    } catch {
      manager[persistenceFailed] = true;
      throw new Error("会话标题保存失败，未发送生图请求；请保留原提示词和原图，勿继续当前会话，另开新会话。");
    }
  }

  // Pi normally defers the first session write until an assistant message. A command-only
  // image session has none, so persist the same header and entries once without fabricating one.
  function persistCommandOnlySession(ctx: ExtensionContext) {
    const manager = ctx.sessionManager as any;
    const file = manager.getSessionFile();
    if (!file || !manager.persist || manager.flushed) return;
    const entries = manager.getEntries();
    if (!entries.some((entry: any) => entry.type === "custom_message" && ["codex-imagegen-result", "codex-imagegen-input"].includes(entry.customType))) return;
    const header = manager.getHeader();
    if (!header) throw new Error("会话头不存在");
    mkdirSync(path.dirname(file), { recursive: true });
    const expected = Buffer.from([header, ...entries].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    writeFileSync(file, expected, { flag: "wx" });
    verifyWrittenBytes(file, expected, 0);
    manager.flushed = true;
  }

  // pi.sendMessage returns void and reports append errors asynchronously. Verify the
  // synchronous session write before making a potentially chargeable request.
  function recordMessage(ctx: ExtensionContext, customType: string, content: string | ({ type: "text"; text: string } | InputImage)[], details?: object, allowDeferred = false) {
    const manager = ctx.sessionManager as any;
    try {
      const file = manager.getSessionFile();
      if (!manager.persist || !file) throw new Error("会话未持久化");
      const flushed = Boolean(manager.flushed);
      const beforeBytes = flushed ? statSync(file).size : 0;
      const beforeCount = manager.getEntries().length;
      pi.sendMessage({ customType, display: true, content, ...(details ? { details } : {}) }, { triggerTurn: false });
      const entries = manager.getEntries();
      const entry = entries[beforeCount];
      if (!entry && allowDeferred) return;
      if (!entry || entry.type !== "custom_message" || entry.customType !== customType) throw new Error("消息未写入会话");
      persistCommandOnlySession(ctx);
      if (!manager.flushed) throw new Error("会话未持久化");
      const expected = Buffer.from(JSON.stringify(entry) + "\n");
      const offset = flushed ? beforeBytes : statSync(file).size - expected.length;
      if (offset < 0) throw new Error("消息未写入磁盘");
      verifyWrittenBytes(file, expected, offset);
    } catch (error) {
      // Pi may have advanced the in-memory leaf even when the append failed.
      // Do not generate again on that instance. The session may need recovery.
      manager[persistenceFailed] = true;
      throw error;
    }
  }

  function recordInput(ctx: ExtensionContext, command: string, images: InputImage[] = [], allowDeferred = false) {
    recordMessage(ctx, "codex-imagegen-input", [{ type: "text", text: `原命令：${command}${images.length ? "\n\n参考图：" : ""}` }, ...images], undefined, allowDeferred);
  }

  // Direct command: send the exact user prompt to the image model, without starting a chat-model turn.
  async function directImage(args: string, ctx: ExtensionContext, inputImages: InputImage[] = [], literalPrompt = false): Promise<boolean> {
    let rest = args.trim();
    let low = false;
    let model: string = defaultModel;
    const refs: string[] = [];
    if (!literalPrompt && rest === "--models") { ctx.ui.notify(`可请求模型：${models.join("、")}；默认 ${defaultModel}。实际模型由 Codex 服务决定，响应未确认。`, "info"); return false; }
    while (!literalPrompt) {
      const quality = /^--low(?:\s+|$)/i.exec(rest);
      if (quality) { low = true; rest = rest.slice(quality[0].length).trimStart(); continue; }
      const modelOption = /^--model(?:=|\s+)(\S+)(?:\s+|$)/i.exec(rest);
      if (modelOption) { model = modelOption[1]; rest = rest.slice(modelOption[0].length).trimStart(); continue; }
      const ref = /^--ref(?:=|\s+)(?:"([^"]+)"|'([^']+)'|((?!["'])\S+))(?:\s+|$)/i.exec(rest);
      if (ref) { refs.push(ref[1] || ref[2] || ref[3]); rest = rest.slice(ref[0].length).trimStart(); continue; }
      if (/^--(?:low|model|ref)(?:=|\s|$)/i.test(rest)) {
        ctx.ui.notify("图片参数无效：请检查 --low、--model 或 --ref 的参数和引号。", "warning");
        return false;
      }
      break;
    }
    const prompt = rest.trim();
    if (!prompt || (!literalPrompt && prompt === "--help")) { ctx.ui.notify("用法：/image [--low] [--model 模型名] [--ref \"图片路径\"] 提示词；/image --models 查看可请求模型。不调用聊天模型。", "info"); return false; }
    if (!pi.getSessionName() && !ctx.sessionManager.getBranch().some((entry: any) => entry.type === "message" && entry.message?.role === "user")) {
      recordTitle(ctx, `生图：${prompt.replace(/\s+/g, " ").slice(0, 40)}`);
    }
    if (!inputImages.length) {
      try { recordInput(ctx, `/image ${args}`); }
      catch { ctx.ui.notify("提示词会话记录保存失败，未发送生图请求；请保留原提示词，不要继续当前会话，另开新会话。", "warning"); return false; }
    }
    try {
      ctx.ui.notify("正在生成图片…", "info");
      const result = await generate({ prompt, model, ...(low ? { quality: "low" } : {}), reference_paths: refs }, undefined, ctx, inputImages);
      const content = [{ type: "text" as const, text: `提示词：${prompt}\n\n${result.content[0].text}` }, result.content[1]];
      try { recordMessage(ctx, "codex-imagegen-result", content, result.details); }
      catch { ctx.ui.notify(`图片已保存：${result.details.path}；但会话记录保存失败，请记录图片路径，不要继续当前会话，另开新会话。`, "warning"); return false; }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      try { recordMessage(ctx, "codex-imagegen-result", `提示词：${prompt}\n\n图片生成失败：${message}`); }
      catch { ctx.ui.notify(`图片生成失败：${message}；会话结果记录保存失败，请勿继续当前会话，另开新会话。`, "warning"); }
      return false;
    }
  }
  // Use the input hook rather than registerCommand: Pi dispatches registered commands
  // before input hooks and passes command handlers no images, silently dropping attachments.
  // Both normal and extension-injected input reach this hook before any model turn.
  pi.on("input", async (event, ctx) => {
    if (!/^\/image(?:\s|$)/i.test(event.text)) return;
    const directMode = (event as typeof event & { codexImageMode?: boolean }).codexImageMode === true;
    const handled = (imageSuccess = false) => directMode
      ? { action: "handled" as const, imageSuccess }
      : { action: "handled" as const };
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if ((ctx.sessionManager as any)[persistenceFailed]) {
        ctx.ui.notify("会话记录保存异常，请勿继续当前会话，另开新会话。", "warning");
        return handled();
      }
      if (directMode && (!ctx.isIdle() || directInFlight.has(sessionId))) {
        ctx.ui.notify("请等待当前回复或生图完成后，再发送图片请求。", "warning");
        return handled();
      }
      if (event.images?.length) {
        if (!pi.getSessionName() && !ctx.sessionManager.getBranch().some((entry: any) => entry.type === "message" && entry.message?.role === "user")) {
          const title = event.text.replace(/^\/image(?:\s+|$)/i, "").replace(/\s+/g, " ").trim().slice(0, 40);
          recordTitle(ctx, `生图：${title || "待处理附件"}`);
        }
        try { recordInput(ctx, event.text, event.images, !ctx.isIdle()); }
        catch {
          ctx.ui.notify("附件会话记录保存失败，未发送生图请求；请保留原图，不要继续当前会话，另开新会话。", "warning");
          return handled();
        }
      }
      if (!ctx.isIdle() || directInFlight.has(sessionId)) {
        ctx.ui.notify("请等待当前回复或生图完成后，再发送 /image。", "warning");
        return handled();
      }
      directInFlight.add(sessionId);
      try {
        return handled(await directImage(event.text.replace(/^\/image(?:\s+|$)/i, ""), ctx, event.images, directMode));
      } finally {
        directInFlight.delete(sessionId);
      }
    } catch (error) {
      try { ctx.ui.notify(`生图命令失败：${error instanceof Error ? error.message : String(error)}`, "error"); } catch { /* Never fall through to a chat-model turn. */ }
    }
    return handled();
  });
  // Streaming input is queued by Pi; after the current run settles, persist a command-only
  // session even when the run ended before its first assistant message.
  pi.on("agent_settled", async (_event, ctx) => {
    try { persistCommandOnlySession(ctx); }
    catch { (ctx.sessionManager as any)[persistenceFailed] = true; ctx.ui.notify("附件会话记录保存失败，请保留原图，不要继续当前会话，另开新会话。", "warning"); }
  });
  // Keep images in the transcript but do not re-send them in later model turns.
  pi.on("context", async event => ({
    messages: event.messages.map((message: any) => ["codex-imagegen-result", "codex-imagegen-input"].includes(message.customType) && Array.isArray(message.content)
      ? { ...message, content: message.content.filter((item: any) => item.type === "text") }
      : message),
  }));
  pi.registerTool({
    name: "codex_imagegen",
    label: "Codex 图像生成",
    description: "Generate or edit an image with the existing Codex account. The requested model defaults to gpt-image-2.5-sunburst, but the Codex backend does not identify or guarantee the actual model. For image editing, provide reference_paths or use_last_user_images; save and return the generated PNG.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "Describe the requested image or edit." }),
      model: Type.Optional(Type.Union(models.map(value => Type.Literal(value)), { description: "Requested image model; the Codex service does not confirm the actual model." })),
      reference_paths: Type.Optional(Type.Array(Type.String(), { maxItems: 5, description: "Local reference image paths for editing." })),
      use_last_user_images: Type.Optional(Type.Boolean({ description: "Use the latest user message that contains image attachments as edit references." })),
      size: Type.Optional(Type.Union(sizes.map(value => Type.Literal(value)))),
      quality: Type.Optional(Type.Union(qualities.map(value => Type.Literal(value)))),
      output_path: Type.Optional(Type.String({ description: "Optional destination PNG path. Existing files are not overwritten." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if ((ctx.sessionManager as any)[persistenceFailed]) throw new Error("会话记录保存异常，请勿继续当前会话，另开新会话。");
      return generate(params, signal, ctx);
    },
  });
}
