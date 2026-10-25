// Routing is a post-reply side effect, never an extra model/tool iteration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function projectRouter(pi: ExtensionAPI) {
  let pending: { id: string; name: string; title: string; preserveCwd: boolean } | null = null;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return;
  const roots = [process.env.PI_PORTABLE_HOME, path.resolve(fs.realpathSync(agentDir), '../../..'), os.hostname().toLowerCase() === 'yangyong' ? 'C:/Users/lop/Documents/claude/pi-portable' : 'D:/Downloads/pi-protable'].filter(Boolean) as string[];
  const script = roots.map(root => path.join(root, 'tools/pi-project.mjs')).find(file => fs.existsSync(file));
  const assigned = (id: string) => {
    const file = path.join(agentDir, 'session-projects.json');
    return fs.existsSync(file) && Boolean(JSON.parse(fs.readFileSync(file, 'utf8'))[id]);
  };
  pi.on('before_agent_start', (event, ctx) => {
    try {
      const resultFile = path.join(agentDir, 'project-routing-results', ctx.sessionManager.getSessionId() + '.json');
      if (fs.existsSync(resultFile)) event.systemPromptOptions.sections.pi_project_result = fs.readFileSync(resultFile, 'utf8');
      else delete event.systemPromptOptions.sections.pi_project_result;
      const registryFile = path.join(agentDir, 'web-projects.json');
      if (!assigned(ctx.sessionManager.getSessionId()) && fs.existsSync(registryFile)) {
        const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
        event.systemPromptOptions.sections.pi_projects = JSON.stringify({ projectCount: registry.projects.length, maxProjects: 8, maxNameLength: 7, projects: registry.projects.map((p: any) => ({ name: p.name ?? path.basename(p.root), root: p.root, sessionDirectory: path.join(p.root, month) })), newSessionDirectory: registry.inbox ? path.join(registry.inbox, month) : null, currentSessionFile: ctx.sessionManager.getSessionFile(), command: `"${process.execPath}" "${script}" move --session ${ctx.sessionManager.getSessionId()} --project "项目名" --title "对话名" --verify` });
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
      if (!assigned(id)) pending = { id, name: match[1].trim(), title: match[2].trim(), preserveCwd: ctx.cwd.replaceAll('\\', '/').toLowerCase().startsWith(agentDir.replaceAll('\\', '/').toLowerCase() + '/automations/') };
      last.text = last.text.slice(0, match.index).trimEnd();
      return { message: { ...message, content } };
    } catch (error) { console.error('[pi-project] capture failed', error); }
  });
  pi.on('agent_end', () => {
    if (!pending) return;
    const request = pending; pending = null;
    try {
      if (!script) throw new Error('Missing project router in registered roots');
      const logs = path.join(agentDir, 'project-routing-queue'); fs.mkdirSync(logs, { recursive: true });
      const log = fs.openSync(path.join(logs, 'router.log'), 'a');
      try {
        const child = spawn(process.execPath, [script, 'move', '--session', request.id, '--project', request.name, '--title', request.title, '--verify', '--defer', ...(request.preserveCwd ? ['--preserve-cwd'] : [])], {
          windowsHide: true, detached: true, shell: false, stdio: ['ignore', log, log], env: process.env,
        });
        child.on('error', error => console.error('[pi-project] launch failed', error.message)); child.unref();
      } finally { fs.closeSync(log); }
    } catch (error) { console.error('[pi-project] deferred routing failed', error); }
  });
}
