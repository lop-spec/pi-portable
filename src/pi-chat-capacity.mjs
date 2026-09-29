// Physical gate for scheduled tasks that run on the ChatGPT web models (lop, 2026-09-25:
// start only while fewer than 4 conversations are running on them; otherwise check again
// every 5 minutes). Since 2026-09-27 those models run inside pi-web; the separate pi-chat
// instance (30241) is retired. A conversation is counted once, whichever surface runs it:
//   - pi-web sessions running on a web model            (30140 /api/agent/running + get_state)
//   - transport-bridge webpage responses in flight      (8894 /health activeSessions; CLI tasks)
// A source that cannot be read is logged every time and counts as zero.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_CHAT_PROVIDER = 'pi-chatgpt-web';
export const isPiChatProvider = provider => provider === PI_CHAT_PROVIDER;

async function json(url, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw Error(`HTTP ${r.status}`);
  return r.json();
}

/** Resolve the bridge token from the provider instance config reached through pi-web's
 * extension link. dataRoot is the provider's own source of truth and survives different
 * project/data layouts on the two machines. */
export function bridgeTokenFile({ env = process.env, moduleDir = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const agents = [env.PI_CODING_AGENT_DIR, env.PI_PORTABLE_HOME && path.join(env.PI_PORTABLE_HOME, 'data', '.pi', 'agent'),
    path.join(moduleDir, '..', 'data', '.pi', 'agent'), path.join(env.LOCALAPPDATA || '', 'pi-web', 'portable', 'data', '.pi', 'agent')].filter(Boolean);
  for (const agent of agents) {
    try {
      const linked = fs.realpathSync(path.join(agent, 'extensions', 'pi-chatgpt-web'));
      for (const projectRoot of [linked, path.dirname(linked)]) {
        const instanceFile = path.join(projectRoot, '.local', 'instance.json');
        if (!fs.existsSync(instanceFile)) continue;
        const instance = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
        if (typeof instance.dataRoot === 'string' && path.isAbsolute(instance.dataRoot)) return path.join(instance.dataRoot, 'local-token');
      }
      const legacy = path.resolve(linked, '..', 'data', 'local-token');
      if (fs.existsSync(legacy)) return legacy;
    } catch {}
  }
  return null;
}

export async function piChatConversations({ piWeb = 'http://127.0.0.1:30140', bridge = 'http://127.0.0.1:8894', tokenFile = bridgeTokenFile() } = {}) {
  const ids = new Set(), errors = [], bySource = { piWeb: 0, bridge: 0 };
  try {
    for (const id of (await json(`${piWeb}/api/agent/running`)).runningSessionIds || []) {
      try {
        const state = await json(`${piWeb}/api/agent/${encodeURIComponent(id)}`, { method: 'POST', body: { type: 'get_state' } });
        if (isPiChatProvider(state.data?.model?.provider)) { ids.add(id); bySource.piWeb++; }
      } catch (e) { errors.push(`pi-web ${id.slice(0, 8)}: ${e.message}`); }
    }
  } catch (e) { errors.push(`pi-web: ${e.message}`); }
  try {
    if (!tokenFile) throw Error('token not found: no pi-chatgpt-web extension link under the pi-web agent directory');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    for (const id of (await json(`${bridge}/health`, { headers: { 'x-pi-bridge': token } })).activeSessions || []) { ids.add(id); bySource.bridge++; }
  } catch (e) { errors.push(`bridge: ${e.message}`); }
  return { count: ids.size, ids: [...ids], bySource, errors };
}

/** Wait until fewer than `limit` conversations run on pi-chat, re-checking every `intervalMs`. */
export async function waitForPiChatCapacity({ log = () => {}, task = '', limit = 4, intervalMs = 5 * 60_000, probe = piChatConversations, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let checks = 1; ; checks++) {
    const c = await probe();
    if (c.errors.length) log('pi-chat-capacity-probe-partial', { task, errors: c.errors });
    if (c.count < limit) { log('pi-chat-capacity-ok', { task, running: c.count, limit, checks, bySource: c.bySource }); return c; }
    log('pi-chat-busy-wait', { task, running: c.count, limit, checks, sessions: c.ids.map(id => id.slice(0, 8)), bySource: c.bySource, retryInMinutes: intervalMs / 60_000 });
    await sleep(intervalMs);
  }
}
