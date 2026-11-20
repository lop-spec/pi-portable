import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { resolveVisibleModels } from "@/lib/model-scope";
import { invalidateModelsCache } from "@/lib/models-cache";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { readSessionDefaults, writeSessionDefaults } from "@/lib/session-defaults-store.mjs";

export const dynamic = "force-dynamic";

async function servicesFor(requested: unknown) {
  const agentDir = getAgentDir();
  if (requested != null && typeof requested !== "string") throw new Error("工作目录无效");
  const cwd = requested ? resolve(requested as string) : agentDir;
  if (requested && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("工作目录不可访问");
  if (!(await stat(cwd)).isDirectory()) throw new Error("工作目录不可访问");
  const trust = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({ cwd, agentDir, ...(trust ? { resourceLoaderReloadOptions: trust } : {}) });
  await services.modelRuntime.refresh({ allowNetwork: false });
  const scope = await resolveVisibleModels(services.modelRuntime, services.settingsManager.getEnabledModels());
  return { services, scope };
}

export async function GET(req: Request) {
  try {
    const {services,scope} = await servicesFor(new URL(req.url).searchParams.get("cwd"));
    const settings = services.settingsManager, global = settings.getGlobalSettings();
    const models = scope.visible.map(model => ({provider:model.provider,id:model.id,name:model.name}));
    const thinkingLevels = Object.fromEntries(scope.visible.map(model => [`${model.provider}:${model.id}`,getSupportedThinkingLevels(model)]));
    return NextResponse.json({models,thinkingLevels,defaultModel:global.defaultProvider && global.defaultModel ? {provider:global.defaultProvider,modelId:global.defaultModel}:null,defaultThinkingLevel:global.defaultThinkingLevel ?? null,applyExisting:readSessionDefaults(getAgentDir())?.applyExisting ?? true},{headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    console.error("[pi-web] read session defaults failed", error);
    return NextResponse.json({error:"默认设置读取失败，请重新打开"},{status:500});
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "请求来源不受信任" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "需要 JSON 请求" }, { status: 415 });
  try {
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.provider !== "string" || typeof body.modelId !== "string" || typeof body.thinkingLevel !== "string" || typeof body.applyExisting !== "boolean") {
      return NextResponse.json({ error: "请选择模型和推理强度" }, { status: 400 });
    }
    const {services,scope} = await servicesFor(body.cwd);
    const model = scope.visible.find(item => item.provider === body.provider && item.id === body.modelId);
    if (!model || !services.modelRuntime.hasConfiguredAuth(model.provider)) return NextResponse.json({ error: "模型不可用，请刷新模型列表" }, { status: 400 });
    const levels = getSupportedThinkingLevels(model);
    if (!levels.includes(body.thinkingLevel as ThinkingLevel)) return NextResponse.json({ error: "该模型不支持所选推理强度" }, { status: 400 });
    const pin = scope.scopedModels.find(item => item.model.provider === model.provider && item.model.id === model.id)?.thinkingLevel;
    if (pin && pin !== body.thinkingLevel) return NextResponse.json({ error: "模型范围已固定推理强度，请先修改模型范围" }, { status: 409 });
    const settings = services.settingsManager;
    settings.setDefaultModelAndProvider(model.provider, model.id);
    settings.setDefaultThinkingLevel(body.thinkingLevel as ThinkingLevel);
    settings.setModelThinkingLevel(model.provider, model.id, body.thinkingLevel as ThinkingLevel);
    await settings.flush();
    if (settings.drainErrors().length) throw new Error("写入设置失败");
    const saved=writeSessionDefaults(getAgentDir(),{provider:model.provider,modelId:model.id,thinkingLevel:body.thinkingLevel,applyExisting:body.applyExisting});
    invalidateModelsCache();
    return NextResponse.json({ provider: model.provider, modelId: model.id, thinkingLevel: body.thinkingLevel, applyExisting:saved.applyExisting });
  } catch (error) {
    console.error("[pi-web] save session defaults failed", error);
    return NextResponse.json({ error: "默认设置保存失败，请重试" }, { status: 500 });
  }
}
