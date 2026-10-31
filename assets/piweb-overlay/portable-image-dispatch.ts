import path from "node:path";
import { realpathSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "@/lib/pi-types";

type ImageInput = { type: "image"; data: string; mimeType: string };
type InputHandler = (event: {
  type: "input";
  source: "rpc";
  text: string;
  images?: ImageInput[];
  codexImageMode: true;
}, context: unknown) => Promise<unknown>;
type BoundExtension = {
  resolvedPath?: string;
  tools?: Map<string, unknown>;
  handlers?: Map<string, InputHandler[]>;
};
type BoundRunner = { extensions?: BoundExtension[]; createContext?: () => unknown };

/** Fail closed: inspect the runner bound to this session, not a loader snapshot. */
export async function dispatchPortableImage(session: AgentSessionLike, message: unknown, images: unknown) {
  if (typeof message !== "string" || !message.trim()) throw new Error("请输入图片描述");
  const runner = session.extensionRunner as unknown as BoundRunner;
  if (!Array.isArray(runner.extensions) || typeof runner.createContext !== "function") {
    throw new Error("当前运行器不支持安全生图");
  }
  const candidates = runner.extensions.filter((extension) => extension.tools instanceof Map && extension.tools.has("codex_imagegen"));
  if (candidates.length !== 1) throw new Error("生图插件缺失或存在冲突");
  let expected: string;
  let actual: string;
  try {
    expected = realpathSync(path.join(getAgentDir(), "extensions", "codex-imagegen", "index.ts"));
    actual = realpathSync(candidates[0].resolvedPath ?? "");
  } catch {
    throw new Error("无法验证生图插件来源");
  }
  if (actual !== expected) throw new Error("生图插件来源不匹配");
  const handlers = candidates[0].handlers?.get("input");
  if (!Array.isArray(handlers) || handlers.length !== 1 || typeof handlers[0] !== "function") {
    throw new Error("生图插件处理器缺失或存在冲突");
  }
  const result = await handlers[0]({
    type: "input",
    source: "rpc",
    text: `/image ${message}`,
    ...(Array.isArray(images) && images.length ? { images: images as ImageInput[] } : {}),
    codexImageMode: true,
  }, runner.createContext());
  if (!result || typeof result !== "object" || (result as { action?: unknown }).action !== "handled" || typeof (result as { imageSuccess?: unknown }).imageSuccess !== "boolean") {
    throw new Error("生图插件未确认结果，请检查新对话，勿重复发送");
  }
  return { imageSuccess: (result as { imageSuccess: boolean }).imageSuccess };
}
