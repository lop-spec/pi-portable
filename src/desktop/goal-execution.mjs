import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const KEY = 'x-pi-goal-execution';
const pipePattern = /^\\\\\.\\pipe\\piweb-desktop-[a-f0-9]{48}$/u;
const tokenPattern = /^[a-f0-9]{64}$/u;
const fileAt = profile => path.join(profile, 'goal-execution-private', 'endpoint.json');

// Separate from the Electron renderer key. The current Windows user is the only
// non-admin identity allowed to read the endpoint file.
export function publishGoalEndpoint(profile, pipe, token) {
  const file = fileAt(profile), dir = path.dirname(file);
  if (!pipePattern.test(pipe) || !tokenPattern.test(token)) throw Error('Invalid desktop endpoint');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw Error('Invalid desktop endpoint directory');
  const system = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
  const opts = { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const sid = execFileSync(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], opts).match(/S-1-\d+(?:-\d+)+/u)?.[0];
  if (!sid) throw Error('Windows user SID missing');
  // Rebuild the DACL rather than retaining existing explicit entries.
  const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const acl = `$ErrorActionPreference='Stop'; $d=$env:PI_GOAL_ENDPOINT_DIR; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.SecurityIdentifier]$env:PI_GOAL_ENDPOINT_SID; $flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'; $acl.SetOwner($sid); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$flags,'None','Allow')); Set-Acl -LiteralPath $d -AclObject $acl`;
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(acl, 'utf16le').toString('base64')], { ...opts, env: { ...process.env, PI_GOAL_ENDPOINT_DIR: dir, PI_GOAL_ENDPOINT_SID: sid } });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.new`;
  try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, pipe, token }), { flag: 'wx', mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
  return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch { /* Runtime is already gone. */ } };
}

export function goalKeyMatches(supplied, token) {
  return typeof supplied === 'string' && tokenPattern.test(supplied) && tokenPattern.test(token || '') && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}
export const GOAL_KEY_HEADER = KEY;
const session = /^\/api\/agent\/[a-z0-9_-]{1,100}$/iu;
function knownRoute(route, method) {
  if (route === '/api/agent/running') return method === 'GET';
  if (route === '/api/agent/new') return method === 'POST';
  return session.test(route) && (method === 'GET' || method === 'POST');
}
function knownBody(route, value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const only = (...keys) => Object.keys(value).every(k => keys.includes(k));
  if (route === '/api/agent/new') return value.type === 'ensure_session' && typeof value.cwd === 'string' && path.win32.isAbsolute(value.cwd) && only('type', 'cwd', 'provider', 'modelId', 'thinkingLevel') && ['provider', 'modelId', 'thinkingLevel'].every(k => value[k] === undefined || typeof value[k] === 'string');
  if (value.type === 'get_state') return only('type');
  return typeof value.message === 'string' && !!value.message && (value.type === 'steer' && only('type', 'message') || value.type === 'prompt' && only('type', 'message', 'streamingBehavior') && value.streamingBehavior === 'steer');
}

export async function forwardGoalRequest(req, res, forward) {
  const fail = (status, code) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code, accepted: false })); };
  if (req.headers.origin || !knownRoute(req.url, req.method)) return fail(403, 'desktop-goal-route-denied');
  const signal = AbortSignal.timeout(30000);
  let body;
  if (req.method === 'POST') {
    const n = Number(req.headers['content-length']);
    if (req.headers['content-type'] !== 'application/json' || !Number.isSafeInteger(n) || n < 1 || req.headers['transfer-encoding']) return fail(400, 'desktop-goal-invalid-body');
    const chunks = []; let size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > n) return fail(400, 'desktop-goal-invalid-body'); chunks.push(chunk); }
      body = Buffer.concat(chunks);
      if (body.length !== n || !knownBody(req.url, JSON.parse(body.toString('utf8')))) return fail(400, 'desktop-goal-invalid-body');
    } catch { return fail(400, 'desktop-goal-invalid-body'); }
  }
  const result = await forward(`https://piweb.invalid${req.url}`, { method: req.method, body, signal, headers: body ? { 'content-type': 'application/json', origin: 'https://piweb.invalid' } : {} });
  const text = await result.text();
  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(text);
}

export async function requestDesktopGoal(profile, route, body, { timeout = 25000, readEndpoint, request = http.request } = {}) {
  const method = body === undefined ? 'GET' : 'POST';
  if (!knownRoute(route, method) || (body !== undefined && !knownBody(route, body))) throw Object.assign(Error('桌面端不接受这类请求'), { accepted: false });
  let x;
  try { x = (readEndpoint || (() => JSON.parse(fs.readFileSync(fileAt(profile), 'utf8'))))(); }
  catch { throw Object.assign(Error('Pi Web 桌面端执行接口未启动'), { accepted: false }); }
  if (x?.version !== 1 || !pipePattern.test(x.pipe) || !tokenPattern.test(x.token)) throw Object.assign(Error('Pi Web 桌面端执行接口信息无效'), { accepted: false });
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: x.pipe, path: route, method, signal: AbortSignal.timeout(timeout), headers: { [KEY]: x.token, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(Error('Desktop response too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (res.statusCode >= 400 || v.error || v.success === false || v.ok === false) {
          const e = Error(`Pi Web 桌面端 HTTP ${res.statusCode}: ${String(v.error || v.code || 'rejected').slice(0, 150)}`);
          if (typeof v.accepted === 'boolean') e.accepted = v.accepted;
          if (typeof v.code === 'string') e.code = v.code;
          throw e;
        }
        resolve(v);
      } catch (e) { reject(e); } });
    });
    req.on('error', error => { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) error.accepted = false; reject(error); });
    req.end(data);
  });
}
