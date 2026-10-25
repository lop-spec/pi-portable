// Routing is a post-reply side effect, never an extra model/tool iteration.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function projectRouter(pi: ExtensionAPI) {
  let pending: { id: string; name: string; title: string; preserveCwd: boolean } | null = null;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) return;
  const script = path.resolve(fs.realpathSync(agentDir), '../../../tools/pi-project.mjs');
  const assigned = (id: string) => {
    const file = path.join(agentDir, 'session-projects.json');
    return fs.existsSync(file) && Boolean(JSON.parse(fs.readFileSync(file, 'utf8'))[id]);
  };
  pi.on('before_agent_start', (event, ctx) => {
    try {
      const registryFile = path.join(agentDir, 'web-projects.json');
      if (!assigned(ctx.sessionManager.getSessionId()) && fs.existsSync(registryFile)) {
        const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
        event.systemPromptOptions.sections.pi_projects = registry.projects.map((p: any) => p.name ?? path.basename(p.root)).join('、');
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
      if (!fs.existsSync(script)) throw new Error('Missing project router: ' + script);
      const logs = path.join(agentDir, 'project-routing-queue'); fs.mkdirSync(logs, { recursive: true });
      const log = fs.openSync(path.join(logs, 'router.log'), 'a');
      try {
        const child = spawn(process.execPath, [script, 'move', '--session', request.id, '--project', request.name, '--title', request.title, '--defer', ...(request.preserveCwd ? ['--preserve-cwd'] : [])], {
          windowsHide: true, detached: true, shell: false, stdio: ['ignore', log, log], env: process.env,
        });
        child.on('error', error => console.error('[pi-project] launch failed', error.message)); child.unref();
      } finally { fs.closeSync(log); }
    } catch (error) { console.error('[pi-project] deferred routing failed', error); }
  });
}
