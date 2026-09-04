import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FOLLOWUP_STATE_TYPE = "lop-followup-state-v1";
export const FOLLOWUP_STATUS_KEY = "lop-followup";
export const MAX_AUTOMATIC_FOLLOWUPS = 8;

export type FollowupMode = "thorough" | "target" | "root-cause" | "root-fix" | "plan";
export type FollowupPhase = "off" | "armed" | "active" | "paused";

export interface FollowupProfile {
  label: string;
  prompt: string;
  terminalLine: string;
  handoff?: string;
}

export interface FollowupState {
  version: 1;
  mode: FollowupMode | null;
  phase: FollowupPhase;
  sent: number;
  reason?: string;
  updatedAt: string;
}

export const FOLLOWUP_PROFILES: Record<FollowupMode, FollowupProfile> = {
  thorough: {
    label: "目标 · 彻底",
    prompt: "不够彻底；确认彻底后，请将“已确认彻底”作为最后一行。",
    terminalLine: "已确认彻底",
  },
  target: {
    label: "目标 · 达标",
    prompt: "未达标；确认达标后，请将“已确认达标”作为最后一行。",
    terminalLine: "已确认达标",
  },
  "root-cause": {
    label: "目标 · 根因",
    prompt: "非根因；确认根因后，请将“已确认根因”作为最后一行。",
    terminalLine: "已确认根因",
  },
  "root-fix": {
    label: "目标 · 根治",
    prompt: "未根治；确认根治后，请将“已确认根治”作为最后一行。",
    terminalLine: "已确认根治",
  },
  plan: {
    label: "计划",
    prompt: "不符合用户习惯、目标或方向；方案确认后，请将“方案已确认”作为最后一行。",
    terminalLine: "方案已确认",
    handoff: "符合用户习惯、目标和方向，按照方案立即执行。",
  },
};

const MODE_ALIASES: Record<string, FollowupMode> = {
  thorough: "thorough",
  target: "target",
  "root-cause": "root-cause",
  "root-fix": "root-fix",
  plan: "plan",
};

function nowIso(): string {
  return new Date().toISOString();
}

export function createOffState(reason?: string): FollowupState {
  return { version: 1, mode: null, phase: "off", sent: 0, reason, updatedAt: nowIso() };
}

export function isFollowupState(value: unknown): value is FollowupState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FollowupState>;
  return candidate.version === 1
    && (candidate.mode === null || (typeof candidate.mode === "string" && Object.hasOwn(FOLLOWUP_PROFILES, candidate.mode)))
    && ["off", "armed", "active", "paused"].includes(String(candidate.phase))
    && Number.isInteger(candidate.sent)
    && Number(candidate.sent) >= 0
    && typeof candidate.updatedAt === "string";
}

export function assistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant") return null;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

/**
 * Returns only the last non-empty standalone line. A line inside an unfinished
 * Markdown fence is deliberately rejected so quoted completion examples cannot
 * terminate a loop.
 */
export function finalStandaloneLine(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 0) return null;

  let fence: { marker: "`" | "~"; size: number } | null = null;
  for (let index = 0; index < last; index += 1) {
    const match = lines[index].match(/^\s*(`{3,}|~{3,})/);
    if (!match) continue;
    const marker = match[1][0] as "`" | "~";
    const size = match[1].length;
    if (!fence) fence = { marker, size };
    else if (fence.marker === marker && size >= fence.size) fence = null;
  }
  if (fence) return null;
  return lines[last].trim();
}

export function parseFollowupMode(args: string): FollowupMode | "off" | "status" | null {
  const action = args.trim().toLowerCase();
  if (action === "off" || action === "stop") return "off";
  if (action === "status") return "status";
  return MODE_ALIASES[action] ?? null;
}

function statusText(state: FollowupState): string | undefined {
  if (!state.mode || state.phase === "off") return undefined;
  const label = FOLLOWUP_PROFILES[state.mode].label;
  if (state.phase === "armed") return `自动追问 · ${label} · 待发送`;
  if (state.phase === "paused") return `自动追问 · ${label} · 已暂停`;
  return `自动追问 · ${label} · ${state.sent}/${MAX_AUTOMATIC_FOLLOWUPS}`;
}

export default function lopFollowupExtension(pi: ExtensionAPI): void {
  let state = createOffState("startup");
  let assistantSequence = 0;
  let lastHandledAssistantSequence = 0;
  let latestAssistant: { sequence: number; text: string; stopReason?: string } | null = null;

  const log = (message: string) => console.info(`[lop-followup] ${message}`);
  const logFailure = (message: string) => console.error(`[lop-followup] ${message}`);

  const updateStatus = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
    ctx.ui.setStatus(FOLLOWUP_STATUS_KEY, statusText(state));
  };

  const persist = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => {
    state = { ...state, updatedAt: nowIso() };
    pi.appendEntry(FOLLOWUP_STATE_TYPE, state);
    updateStatus(ctx);
  };

  const pause = (
    ctx: {
      ui: {
        setStatus: (key: string, text: string | undefined) => void;
        notify: (message: string, type?: "info" | "warning" | "error") => void;
      };
    },
    reason: string,
    notice: string,
  ) => {
    state = { ...state, phase: "paused", reason, updatedAt: nowIso() };
    persist(ctx);
    ctx.ui.notify(notice, "warning");
    logFailure(`paused reason=${reason} mode=${state.mode ?? "none"} sent=${state.sent}`);
  };

  pi.registerCommand("lop-followup", {
    description: "开启或停止目标/计划自动追问",
    handler: async (args, ctx) => {
      const action = parseFollowupMode(args);
      if (action === "status") {
        ctx.ui.notify(statusText(state) ?? "自动追问未开启", "info");
        return;
      }
      if (action === "off") {
        state = createOffState("manual-stop");
        lastHandledAssistantSequence = assistantSequence;
        persist(ctx);
        ctx.ui.notify("自动追问已停止", "info");
        log("stopped reason=manual-stop");
        return;
      }
      if (!action) {
        ctx.ui.notify("用法：/lop-followup thorough|target|root-cause|root-fix|plan|off", "warning");
        logFailure(`command rejected reason=invalid-argument value=${JSON.stringify(args.trim())}`);
        return;
      }

      state = {
        version: 1,
        mode: action,
        phase: "armed",
        sent: 0,
        reason: undefined,
        updatedAt: nowIso(),
      };
      lastHandledAssistantSequence = assistantSequence;
      persist(ctx);
      ctx.ui.notify(`${FOLLOWUP_PROFILES[action].label}自动追问已开启`, "info");
      log(`activated mode=${action}`);
    },
  });

  pi.on("session_start", (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    let restored: FollowupState | null = null;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== FOLLOWUP_STATE_TYPE) continue;
      if (isFollowupState(entry.data)) restored = entry.data;
      else logFailure("restore ignored reason=invalid-state");
      break;
    }

    state = restored ? { ...restored } : createOffState("no-state");
    assistantSequence = 0;
    lastHandledAssistantSequence = 0;
    latestAssistant = null;

    if (state.mode && (state.phase === "armed" || state.phase === "active")) {
      state = { ...state, phase: "paused", reason: `session-${event.reason}`, updatedAt: nowIso() };
      persist(ctx);
      ctx.ui.notify("自动追问已恢复为暂停状态；重新选择模式即可继续", "warning");
      logFailure(`restored-paused reason=session-${event.reason} mode=${state.mode}`);
      return;
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(FOLLOWUP_STATUS_KEY, undefined);
  });

  pi.on("input", (event, ctx) => {
    if (!state.mode || state.phase === "off" || state.phase === "paused") return;
    if (event.source === "extension") return;

    if (state.phase === "armed") {
      state = { ...state, phase: "active", reason: undefined, updatedAt: nowIso() };
      persist(ctx);
      log(`started mode=${state.mode}`);
      return;
    }

    pause(ctx, "manual-input", "检测到手动消息，自动追问已暂停");
  });

  pi.on("message_end", (event) => {
    const text = assistantText(event.message);
    if (text === null) return;
    assistantSequence += 1;
    const message = event.message as { stopReason?: unknown };
    latestAssistant = {
      sequence: assistantSequence,
      text,
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!state.mode || state.phase !== "active") return;
    if (!latestAssistant || latestAssistant.sequence <= lastHandledAssistantSequence) return;
    lastHandledAssistantSequence = latestAssistant.sequence;

    if (latestAssistant.stopReason === "error" || latestAssistant.stopReason === "aborted") {
      pause(ctx, `assistant-${latestAssistant.stopReason}`, "模型本轮异常结束，自动追问已暂停");
      return;
    }
    if (!latestAssistant.text.trim()) {
      pause(ctx, "empty-assistant", "未读取到模型最终文本，自动追问已暂停");
      return;
    }

    const profile = FOLLOWUP_PROFILES[state.mode];
    const terminalLine = finalStandaloneLine(latestAssistant.text);
    if (terminalLine === profile.terminalLine) {
      const completedMode = state.mode;
      const handoff = profile.handoff;
      state = createOffState("terminal-line");
      persist(ctx);
      log(`completed mode=${completedMode} terminal=${JSON.stringify(terminalLine)}`);

      if (!handoff) {
        ctx.ui.notify(`${profile.label}已确认，自动追问已停止`, "info");
        return;
      }
      if (!ctx.isIdle()) {
        state = {
          version: 1,
          mode: completedMode,
          phase: "paused",
          sent: state.sent,
          reason: "handoff-not-idle",
          updatedAt: nowIso(),
        };
        persist(ctx);
        ctx.ui.notify("方案已确认，但会话不空闲；执行交接未发送", "warning");
        logFailure(`handoff skipped reason=not-idle mode=${completedMode}`);
        return;
      }
      try {
        pi.sendUserMessage(handoff);
        ctx.ui.notify("方案已确认，已转入执行", "info");
        log(`handoff sent mode=${completedMode}`);
      } catch (error) {
        state = {
          version: 1,
          mode: completedMode,
          phase: "paused",
          sent: 0,
          reason: "handoff-send-failed",
          updatedAt: nowIso(),
        };
        persist(ctx);
        ctx.ui.notify("方案执行交接发送失败，自动追问已暂停", "error");
        logFailure(`handoff failed error=${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    if (state.sent >= MAX_AUTOMATIC_FOLLOWUPS) {
      pause(ctx, "automatic-limit", `已达到 ${MAX_AUTOMATIC_FOLLOWUPS} 轮上限，自动追问已暂停`);
      return;
    }
    if (!ctx.isIdle()) {
      pause(ctx, "settled-not-idle", "会话仍有其它运行，自动追问已暂停");
      return;
    }

    state = { ...state, sent: state.sent + 1, reason: undefined, updatedAt: nowIso() };
    persist(ctx);
    try {
      pi.sendUserMessage(profile.prompt);
      log(`follow-up sent mode=${state.mode} turn=${state.sent}/${MAX_AUTOMATIC_FOLLOWUPS}`);
    } catch (error) {
      pause(ctx, "followup-send-failed", "自动追问发送失败，模式已暂停");
      logFailure(`follow-up failed error=${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
