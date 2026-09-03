// lop-swarm pi 扩展:契约式子代理分工的工具面。
// 主链只拿到确定性表格与产物路径;子代理对话永不注入主链。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import {
  SWARM_VERSION, validatePlan, createRun, runSwarm, readStatus, renderTable, applyRun, renderApply,
  swarmDataRoot, detectPiCli, listRuns, resolveRunDir,
} from "./runtime.mjs";

const VerifySchema = Type.Object({
  cmd: Type.String({ minLength: 1, maxLength: 2000, description: "Shell command the HOST runs in the task's working directory after the worker finishes; exit 0 = pass. Required: a sub-task without a mechanical verify command is rejected." }),
  expect: Type.Optional(Type.String({ maxLength: 500, description: "Optional regex that the verify output must match" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 900000, description: "Verify timeout, default 120000" })),
}, { additionalProperties: false });

const TaskSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,39}$", description: "Short unique id, lowercase" }),
  goal: Type.String({ minLength: 8, maxLength: 4000, description: "What the worker must achieve, self-contained" }),
  deliverable: Type.String({ minLength: 1, maxLength: 500, description: "The concrete artifact expected, e.g. a file path" }),
  verify: VerifySchema,
  inputs: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20, description: "Paths or facts the worker should read first" })),
  protected: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50, description: "Files the worker must not modify (verify script files are protected automatically)" })),
  hints: Type.Optional(Type.String({ maxLength: 4000 })),
  role: Type.Optional(StringEnum(["worker"] as const)),
}, { additionalProperties: false });

const runOptionFields = {
  workers: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Parallel worker slots (each claims tasks from the queue), default 2" })),
  verifier: Type.Optional(StringEnum(["pi", "none"] as const, { description: "Independent verifier: pi (separate sub-agent, sees only artifacts) or none. Default pi" })),
  model: Type.Optional(Type.String({ maxLength: 120, description: "Model pattern for workers, e.g. provider/id" })),
  verifierModel: Type.Optional(Type.String({ maxLength: 120, description: "Model pattern for the verifier (defaults to model)" })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high"] as const)),
  taskTimeoutMs: Type.Optional(Type.Integer({ minimum: 30000, maximum: 3600000 })),
  verifierTimeoutMs: Type.Optional(Type.Integer({ minimum: 30000, maximum: 1800000 })),
  keepWorktrees: Type.Optional(Type.Boolean({ description: "Keep per-task git worktrees for inspection" })),
};

const PlanParams = Type.Object({ tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false });
const RunParams = Type.Object({
  runId: Type.Optional(Type.String({ maxLength: 64, description: "Run created by swarm_plan; omit when passing tasks inline" })),
  tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 16, description: "Inline plan (validated and created before running)" })),
  ...runOptionFields,
}, { additionalProperties: false });
const StatusParams = Type.Object({ runId: Type.String({ maxLength: 64 }) }, { additionalProperties: false });
const ApplyParams = Type.Object({
  runId: Type.String({ maxLength: 64 }),
  ids: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 16, description: "Task ids to apply; default all done tasks" })),
}, { additionalProperties: false });

const GUIDELINES = [
  "Use swarm_plan/swarm_run only for work that splits into sub-tasks each provable by a mechanical verify command; otherwise do the work directly.",
  "Never restate or summarize sub-agent conversations: the swarm tools return a deterministic table plus artifact paths, and that table is the only evidence. Read result.json/verify.txt/patch.diff files when details are needed.",
  "Tasks without verify.cmd are rejected by design; write the verify command before the goal.",
];

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

export default function lopSwarmExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "swarm_plan",
    label: "Swarm Plan",
    description: "Create a contract-based sub-agent run: validates tasks (verify.cmd required, ids unique), auto-protects verify script files, writes the claim queue. Returns runId. Execute with swarm_run.",
    promptSnippet: "Plan verifiable sub-tasks for parallel isolated sub-agents",
    promptGuidelines: GUIDELINES,
    parameters: PlanParams,
    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      const plan = validatePlan(params.tasks, { cwd });
      if (!plan.ok) return { ...text(`swarm_plan rejected (no files written):\n- ${plan.errors.join("\n- ")}`), details: { ok: false, errors: plan.errors }, isError: true };
      const { runId, runDir } = createRun({ cwd, tasks: plan.tasks });
      const rows = plan.tasks.map((t) => `| ${t.id} | ${t.deliverable} | ${t.verify.cmd} | ${t.protected.join(", ") || "-"} |`);
      return {
        ...text([`swarm run created: ${runId} (cwd=${cwd}, tasks=${plan.tasks.length})`, "| id | deliverable | verify | protected |", "|---|---|---|---|", ...rows, `next: swarm_run {"runId":"${runId}"}`].join("\n")),
        details: { ok: true, runId, runDir, tasks: plan.tasks.map((t) => t.id) },
      };
    },
  });

  pi.registerTool({
    name: "swarm_run",
    label: "Swarm Run",
    description: "Run a swarm: worker slots claim tasks from the queue (atomic), each task executes in its own git worktree as an isolated pi sub-process, the host runs verify.cmd, an independent verifier judges only the artifacts, and results are collected as files. Returns a deterministic status table (no sub-agent chat).",
    promptSnippet: "Execute verifiable sub-tasks with isolated sub-agents and independent verification",
    promptGuidelines: GUIDELINES,
    parameters: RunParams,
    async execute(_id, params, signal, onUpdate, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      let runDir: string | null = null;
      let runId = params.runId || "";
      if (params.tasks && params.tasks.length) {
        const plan = validatePlan(params.tasks, { cwd });
        if (!plan.ok) return { ...text(`swarm_run rejected (no files written):\n- ${plan.errors.join("\n- ")}`), details: { ok: false, errors: plan.errors }, isError: true };
        const created = createRun({ cwd, tasks: plan.tasks });
        runDir = created.runDir;
        runId = created.runId;
      } else if (runId) {
        runDir = resolveRunDir(runId);
      }
      if (!runDir) return { ...text("swarm_run: 需要 runId(来自 swarm_plan)或 tasks"), details: { ok: false }, isError: true };
      const progress: string[] = [];
      const summary = await runSwarm({
        runDir, workers: params.workers, verifier: params.verifier, model: params.model, verifierModel: params.verifierModel,
        thinking: params.thinking, taskTimeoutMs: params.taskTimeoutMs, verifierTimeoutMs: params.verifierTimeoutMs,
        keepWorktrees: params.keepWorktrees, signal,
        onProgress: (line: string) => {
          progress.push(line);
          onUpdate?.({ content: [{ type: "text", text: progress.slice(-8).join("\n") }], details: { runId } });
        },
      });
      return { ...text(renderTable(summary)), details: { ok: true, runId, runDir, counts: summary.counts, wallMs: summary.wallMs, tasks: summary.tasks.map((t: any) => ({ id: t.id, status: t.status, reason: t.reason })) } };
    },
  });

  pi.registerTool({
    name: "swarm_status",
    label: "Swarm Status",
    description: "Show the deterministic status table of a swarm run (from status.json files).",
    parameters: StatusParams,
    async execute(_id, params) {
      const runDir = resolveRunDir(params.runId);
      if (!runDir) return { ...text(`run 不存在: ${params.runId}`), isError: true };
      return text(renderTable(readStatus(runDir)));
    },
  });

  pi.registerTool({
    name: "swarm_apply",
    label: "Swarm Apply",
    description: "Apply the patches of done tasks to the main working directory in order (git apply --check first) and re-run each verify command there.",
    parameters: ApplyParams,
    async execute(_id, params) {
      const runDir = resolveRunDir(params.runId);
      if (!runDir) return { ...text(`run 不存在: ${params.runId}`), isError: true };
      const result = await applyRun({ runDir, ids: params.ids });
      return { ...text(renderApply(result)), details: result };
    },
  });

  pi.registerCommand("swarm-status", {
    description: "Show lop-swarm runtime status (cli path, data root, recent runs)",
    handler: async (_args, ctx) => {
      const runs = listRuns();
      const cli = detectPiCli();
      ctx.ui.notify(`lop-swarm ${SWARM_VERSION} cli=${cli ? "ok" : "missing"} data=${swarmDataRoot()} runs=${runs.length} last=${runs[0]?.runId ?? "-"}`, cli ? "info" : "warning");
    },
  });
}
