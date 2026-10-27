// Routing is a post-reply side effect, never an extra model/tool iteration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export function isAutomationCwd(cwd: string) {
  return /(?:^|\/)\.pi\/agent\/automations(?:\/|$)/i.test(cwd.replaceAll('\\', '/'));
}
export default function projectRouter(pi: ExtensionAPI) {
  let pending: { id: string; name: string; title: string; preserveCwd: boolean; plan?: Record<string, unknown> } | null = null;
  let automationId: string | null = null;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return;
  const roots = [process.env.PI_PORTABLE_HOME, path.resolve(fs.realpathSync(agentDir), '../../..'), os.hostname().toLowerCase() === 'yangyong' ? 'C:/Users/lop/Documents/claude/pi-portable' : 'D:/Downloads/pi-protable'].filter(Boolean) as string[];
  const script = roots.map(root => path.join(root, 'tools/pi-project.mjs')).find(file => fs.existsSync(file));
  const assigned = (id: string) => {
    const file = path.join(agentDir, 'session-projects.json');
    return fs.existsSync(file) && Boolean(JSON.parse(fs.readFileSync(file, 'utf8'))[id]);
  };
  pi.on('before_agent_start', async (event, ctx) => {
    try {
      automationId = isAutomationCwd(ctx.cwd) ? ctx.sessionManager.getSessionId() : null;
      if (automationId) {
        pending = null;
        delete event.systemPromptOptions.sections.pi_projects;
        delete event.systemPromptOptions.sections.pi_project_result;
        return;
      }
      const resultFile = path.join(agentDir, 'project-routing-results', ctx.sessionManager.getSessionId() + '.json');
      if (fs.existsSync(resultFile)) event.systemPromptOptions.sections.pi_project_result = fs.readFileSync(resultFile, 'utf8');
      else delete event.systemPromptOptions.sections.pi_project_result;
      const registryFile = path.join(agentDir, 'web-projects.json');
      if (!assigned(ctx.sessionManager.getSessionId()) && fs.existsSync(registryFile)) {
        const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
        let classification: Record<string, unknown> = {};
        if (registry.managed) {
          const response = await fetch('http://127.0.0.1:30140/api/sessions?force=1', { signal: AbortSignal.timeout(3000) });
          if (!response.ok) throw new Error('Session catalogue unavailable');
          const catalogue = await response.json() as any;
          const archiveFile = path.join(agentDir, 'session-archive.json'), archived = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')).sessions ?? {} : {};
          const active = catalogue.sessions.filter((s: any) => !archived[s.id] && s.relation?.kind !== 'subagent' && !isAutomationCwd(s.cwd));
          const counts = registry.projects.map((p: any) => ({ name: p.name ?? path.basename(p.root), count: active.filter((s: any) => s.projectKey === p.key).length }));
          const inboxKey = registry.inbox ? path.resolve(registry.inbox).toLowerCase() : '', currentId = ctx.sessionManager.getSessionId();
          const inInbox = (s: any) => inboxKey && path.resolve(s.projectRoot ?? s.cwd).toLowerCase() === inboxKey;
          const waiting = active.filter((s: any) => s.id !== currentId && inInbox(s));
          const requiresPlan = counts.some((p: any) => p.count < 5 || p.count > 10) || counts.length > 8 || !counts.length || waiting.length > 0;
          classification = { counts, requiresPlan, minConversations: 5, maxConversations: 10, ...(requiresPlan ? { classificationCandidates: active.filter((s: any) => s.id !== currentId && (registry.projects.some((p: any) => p.key === s.projectKey) || inInbox(s))).map((s: any) => ({ id: s.id, project: registry.projects.find((p: any) => p.key === s.projectKey)?.name ?? '未归属', title: s.name, firstMessage: s.firstMessage?.slice(0, 800), running: catalogue.runningSessionIds?.includes(s.id) ?? false })), planSchema: { renames: [{ from: '旧项目名', to: '新项目名' }], merges: [{ from: ['待合并项目名'], project: '已存在目标名' }], moves: [{ project: '目标项目名', ids: ['选定主对话ID'] }], splits: [{ from: '来源项目名', project: '新项目名', ids: ['选定主对话ID'] }] } } : {}) };
        }
        event.systemPromptOptions.sections.pi_projects = JSON.stringify({ ...classification, projectCount: registry.projects.length, maxProjects: 8, maxNameLength: 7, projects: registry.projects.map((p: any) => ({ name: p.name ?? path.basename(p.root), root: p.root, sessionDirectory: path.join(p.root, month) })),  newSessionDirectory: registry.inbox ? path.join(registry.inbox, month) : null, currentSessionFile: ctx.sessionManager.getSessionFile(), command: `"${process.execPath}" "${script}" move --session ${ctx.sessionManager.getSessionId()} --project "项目名" --title "对话名" --verify` });
      } else delete event.systemPromptOptions.sections.pi_projects;
    } catch (error) { console.error('[pi-project] catalogue unavailable', error); }
  });
  pi.on('message_end', (event, ctx) => {
    const message = event.message as any, id = ctx.sessionManager.getSessionId();
    if (message?.role !== 'assistant' || !Array.isArray(message.content) || message.stopReason === 'toolUse' || message.content.some((b: any) => b.type === 'toolCall')) return;
    const content = message.content.map((b: any) => b.type === 'text' ? { ...b } : b);
    const last = [...content].reverse().find((b: any) => b.type === 'text');
    const match = last?.text?.match(/(?:^|\n)<归属 项目="([^<>\n"]{1,40})">([^<>\n]{1,80})<\/归属>\s*$/u);
    if (!match) return;
    try {
      const before = last.text.slice(0, match.index).trimEnd(), planMatch = before.match(/(?:^|\n)<项目整理>([\s\S]+)<\/项目整理>\s*$/u);
      const plan = planMatch ? JSON.parse(planMatch[1]) : undefined;
      if (plan && (typeof plan !== 'object' || Array.isArray(plan))) throw new Error('项目整理参数必须是对象');
      if (!isAutomationCwd(ctx.cwd) && !assigned(id)) pending = { id, name: match[1].trim(), title: match[2].trim(), preserveCwd: false, ...(plan ? { plan } : {}) };
      last.text = planMatch ? before.slice(0, planMatch.index).trimEnd() : before;
      return { message: { ...message, content } };
    } catch (error) { console.error('[pi-project] capture failed', error); }
  });
  pi.on('agent_end', () => {
    if (!pending && !automationId) return;
    const request = pending, taskId = automationId; pending = null; automationId = null;
    try {
      const worker = taskId ? roots.map(root => path.join(root, 'tools/pi-task-results.mjs')).find(file => fs.existsSync(file)) : script;
      if (!worker) throw new Error('Missing session routing worker in registered roots');
      const args = taskId ? [worker, 'archive', '--session', taskId, '--defer'] : [worker, 'move', '--session', request!.id, '--project', request!.name, '--title', request!.title, '--verify', '--defer', ...(request!.preserveCwd ? ['--preserve-cwd'] : [])];
      if (!taskId && request?.plan) {
        const plans = path.join(agentDir, 'project-routing-plans'); fs.mkdirSync(plans, { recursive: true });
        const file = path.join(plans, request.id + '-' + Date.now() + '.json'); fs.writeFileSync(file, JSON.stringify(request.plan)); args.push('--plan-file', file);
      }
      const logs = path.join(agentDir, taskId ? 'automation-results' : 'project-routing-queue'); fs.mkdirSync(logs, { recursive: true });
      const log = fs.openSync(path.join(logs, 'router.log'), 'a');
      try {
        const child = spawn(process.execPath, args, {
          windowsHide: true, detached: true, shell: false, stdio: ['ignore', log, log], env: process.env,
        });
        child.on('error', error => console.error('[pi-project] launch failed', error.message)); child.unref();
      } finally { fs.closeSync(log); }
    } catch (error) { console.error('[pi-project] deferred routing failed', error); }
  });
}
