#!/usr/bin/env node
// Free search adapters only: no API keys, model calls, browser launches or daemon.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const ENDPOINTS = { parallel: 'https://search.parallel.ai/mcp', exa: 'https://mcp.exa.ai/mcp' };
const PROVIDERS = ['tavily', 'parallel', 'exa'];
const OPTIONS = {
  search: ['provider', 'n', 'max-chars', 'timeout-ms'],
  fetch: ['provider', 'max-chars', 'timeout-ms'],
  github: ['n', 'timeout-ms'],
  wechat: ['n', 'full', 'pages', 'since', 'timeout-ms'],
};
const HELP = `websearch — 免费实时检索，零依赖；既有浏览器仍可独立使用。
  websearch search "关键词/检索目标" [--provider tavily|parallel|exa] [--n 5]
  websearch fetch URL [URL ...] [--provider tavily|parallel|exa] [--max-chars 12000]
  websearch github "仓库关键词" [--n 5]
  websearch wechat "关键词" [--n 8] [--full 0] [--pages 3] [--since YYYY-MM-DD]

默认 Tavily keyless；Parallel/Exa 为匿名 MCP，无需注册、Key 或本地服务。
仅 search/fetch，不启用 Research/Agent。限流会报错，不自动付费或换源。
GitHub 自动添加近 1 年 pushed 筛选；微信自动限制近 3 个自然月，--since 只能收紧。
fetch 返回公开页面内容，不是浏览器登录态；登录页面用现有 Thorium browser 工具。
通用调用超时默认 20 秒；微信默认 28 秒，--timeout-ms 可调整（1–120 秒）。
预计超过 30 秒的调用按全局规则隐藏后台运行并保留日志。
输出 JSON；stderr 记录失败、空结果、筛选和截断原因。

检索方向：官方版本文档/更新日志；GitHub Issue/PR/Release/源码；
技术论坛与中文社区；Reddit/Hacker News；学术论文；Hugging Face；新闻/博客/RSS。
命令 github 只搜仓库，Issue/PR/源码及 RSS 内容仍由原站/浏览器按需读取。
同题复用已有结果；全面调研再用其他 provider 补充，不机械全源轮询。
`;

export function monthsAgo(months, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - months, 1);
  d.setDate(Math.min(now.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
export function dateFloor(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid date: ${value}`);
  const [y, m, d] = value.split('-').map(Number), date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new Error(`invalid date: ${value}`);
  return date.getTime();
}
export function filterRecent(rows, getTime, lower, now = new Date()) {
  return rows.filter(row => { const t = getTime(row); return Number.isFinite(t) && t >= lower && t <= now.getTime(); });
}
export function parseArgs(args) {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) return { command: 'help' };
  const command = args[0];
  if (!OPTIONS[command]) throw new Error(`unknown command: ${command}; use websearch help`);
  const o = { command, provider: 'tavily', n: command === 'wechat' ? 8 : 5, full: 0, pages: 3, maxChars: 12000, timeoutMs: command === 'wechat' ? 28000 : 20000, words: [] };
  const names = { 'max-chars': 'maxChars', 'timeout-ms': 'timeoutMs' };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') continue;
    if (!arg.startsWith('--')) { o.words.push(arg); continue; }
    const key = arg.slice(2);
    if (!OPTIONS[command].includes(key) || i + 1 >= args.length) throw new Error(`invalid option for ${command}: ${arg}`);
    o[names[key] || key] = ['provider', 'since'].includes(key) ? args[++i] : Number(args[++i]);
  }
  if (!o.words.length) throw new Error(`${command} requires a query or URL`);
  if (!PROVIDERS.includes(o.provider)) throw new Error(`unknown provider: ${o.provider}`);
  for (const [key, min, max] of [['n', 1, 20], ['full', 0, 20], ['pages', 1, 10], ['maxChars', 1000, 100000], ['timeoutMs', 1000, 120000]]) {
    if (!Number.isInteger(o[key]) || o[key] < min || o[key] > max) throw new Error(`${key} must be ${min}..${max}`);
  }
  if (o.since) dateFloor(o.since);
  o.query = o.words.join(' ');
  return o;
}

export function parseRpc(text, id) {
  const messages = [];
  try { messages.push(JSON.parse(text)); } catch {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) { try { messages.push(JSON.parse(data)); } catch { /* A later event may contain the response. */ } }
    }
  }
  const response = messages.flat().find(message => message?.id === id);
  if (!response) throw new Error('missing MCP response (JSON/SSE)');
  if (response.error) throw new Error(`MCP ${response.error.code}: ${response.error.message}`);
  if (!('result' in response)) throw new Error('MCP response has no result');
  return response.result;
}

export function resolveWechatScript({ agentDir = process.env.PI_CODING_AGENT_DIR, userHome = os.userInfo().homedir, exists = fs.existsSync } = {}) {
  const candidates = [agentDir && path.join(agentDir, 'skills', 'wechat-search', 'search.mjs'), path.join(userHome, '.claude', 'skills', 'wechat-search', 'search.mjs')].filter(Boolean);
  const found = candidates.find(candidate => exists(candidate));
  if (!found) throw new Error('wechat script missing from agent skills and native user profile');
  return found;
}

export function createSearch({ fetchImpl = fetch, execImpl = promisify(execFile), now = new Date(), log = message => console.error(`[websearch] ${message}`), wechatScript } = {}) {
  async function http(url, { method = 'POST', headers = {}, body, signal } = {}) {
    const response = await fetchImpl(url, { method, headers: { 'User-Agent': 'pi-web-free-search/1.0', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    return { response, text };
  }
  async function mcp(provider, name, args, o, signal) {
    const url = ENDPOINTS[provider];
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const init = await http(url, { headers, signal, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pi-web-free-search', version: '1.0.0' } } } });
    const result = parseRpc(init.text, 1);
    const session = init.response.headers.get('mcp-session-id');
    if (session) headers['mcp-session-id'] = session;
    headers['MCP-Protocol-Version'] = result.protocolVersion;
    await http(url, { headers, signal, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    const call = await http(url, { headers, signal, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } } });
    const data = parseRpc(call.text, 2);
    const text = data.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || (data.structuredContent ? JSON.stringify(data.structuredContent) : '');
    if (data.isError) throw new Error(`${provider} ${name}: ${text.slice(0, 400)}`);
    if (!text.trim()) throw new Error(`${provider} returned no readable content`);
    const truncated = text.length > o.maxChars;
    if (truncated) log(`${provider}: output truncated ${text.length} -> ${o.maxChars} chars; use --max-chars to read more`);
    return { text: text.slice(0, o.maxChars), truncated, original_chars: text.length };
  }
  function clipResults(rows, maxChars) {
    return rows.map(row => {
      const out = { ...row };
      for (const key of ['content', 'raw_content']) if (typeof out[key] === 'string' && out[key].length > maxChars) {
        log(`content truncated for ${out.url || out.title}: ${out[key].length} -> ${maxChars} chars`);
        out[`${key}_original_chars`] = out[key].length; out[`${key}_truncated`] = true; out[key] = out[key].slice(0, maxChars);
      }
      return out;
    });
  }
  async function execute(o) {
    const operation = o.command, provider = ['github', 'wechat'].includes(operation) ? operation : o.provider;
    const base = { ok: true, provider, operation, retrieved_at: new Date().toISOString() };
    const signal = AbortSignal.timeout(o.timeoutMs);
    if (operation === 'github') {
      const since = monthsAgo(12, now);
      const query = `${o.query} pushed:>=${since}`;
      const url = new URL('https://api.github.com/search/repositories');
      url.search = new URLSearchParams({ q: query, per_page: String(o.n) }).toString();
      const { text } = await http(url.href, { method: 'GET', signal });
      const data = JSON.parse(text);
      if (!Array.isArray(data.items)) throw new Error('GitHub response has no items');
      const rows = filterRecent(data.items, row => Date.parse(row.pushed_at), dateFloor(since), now);
      if (rows.length < data.items.length) log(`github: excluded ${data.items.length - rows.length} repositories with old/unknown/future pushed_at`);
      if (!rows.length) log('github: no results within one-year update window');
      if (data.incomplete_results) log('github: upstream reports incomplete_results=true');
      return { ...base, query, since, total_count: data.total_count, incomplete_results: data.incomplete_results || false, count: rows.length, results: rows.map(row => ({ name: row.full_name, url: row.html_url, description: row.description, stars: row.stargazers_count, pushed_at: row.pushed_at, archived: row.archived, language: row.language })) };
    }
    if (operation === 'wechat') {
      const limit = monthsAgo(3, now), since = o.since && o.since > limit ? o.since : limit;
      if (o.since && o.since < limit) log(`wechat: --since ${o.since} clamped to ${limit}`);
      const args = [wechatScript || resolveWechatScript(), o.query, '--n', String(o.n), '--pages', String(o.pages), '--sort', 'time', '--since', since, '--full', String(o.full), '--json'];
      let child;
      try { child = await execImpl(process.execPath, args, { windowsHide: true, timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024 }); }
      catch (error) { if (error.stderr) log(String(error.stderr).trim()); throw new Error(`wechat script failed: ${error.killed ? 'timeout' : error.code ?? error.message}`); }
      if (child.stderr?.trim()) log(child.stderr.trim());
      const data = JSON.parse(child.stdout);
      if (!Array.isArray(data.results)) throw new Error('wechat response has no results');
      const rows = filterRecent(data.results, row => Number(row.ts) > 0 ? Number(row.ts) * 1000 : NaN, dateFloor(since), now).sort((a, b) => b.ts - a.ts);
      if (rows.length < data.results.length) log(`wechat: excluded ${data.results.length - rows.length} old/unknown/future articles`);
      if (!rows.length) log('wechat: no results within the requested three-month window');
      for (const row of rows) if (row.resolveNote || row.contentNote) log(`wechat ${row.title}: ${row.resolveNote || row.contentNote}`);
      return { ...base, query: o.query, since, pages: data.pages, count: rows.length, results: rows.map(({ sogouLink, ...row }) => row) };
    }
    const urls = operation === 'fetch' ? o.words.map(value => {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('fetch requires public HTTP(S) URLs without credentials');
      return u.href;
    }) : [];
    if (urls.length > 5) throw new Error('fetch supports at most 5 URLs per call');
    if (provider === 'tavily') {
      const endpoint = operation === 'search' ? 'search' : 'extract';
      const body = operation === 'search' ? { query: o.query, max_results: o.n, search_depth: 'basic', include_answer: false } : { urls };
      const { text } = await http(`https://api.tavily.com/${endpoint}`, { headers: { 'Content-Type': 'application/json', 'X-Tavily-Access-Mode': 'keyless' }, body, signal });
      const data = JSON.parse(text);
      if (!Array.isArray(data.results)) throw new Error(`Tavily response has no results: ${JSON.stringify(data).slice(0, 300)}`);
      for (const fail of data.failed_results || []) log(`tavily extract failed: ${fail.url}: ${fail.error || 'unknown reason'}`);
      if (!data.results.length) {
        log(`tavily ${operation}: no results`);
        if (operation === 'fetch') throw new Error('no pages extracted');
      }
      return { ...base, ...(operation === 'search' ? { query: o.query } : {}), count: data.results.length, results: clipResults(data.results, o.maxChars), failed_results: data.failed_results || [] };
    }
    let name, args;
    if (provider === 'parallel') {
      name = operation === 'search' ? 'web_search' : 'web_fetch';
      args = operation === 'search' ? { objective: o.query, search_queries: [o.query] } : { urls, full_content: true };
      // Stable, non-credential identifier; do not rotate it to evade free-tier limits.
      if (process.env.PI_SESSION_ID) args.session_id = createHash('sha256').update(process.env.PI_SESSION_ID).digest('hex');
      if (operation === 'search' && o.n !== 5) log('parallel: --n cannot be enforced by the anonymous MCP; result count is server-managed');
    } else {
      name = operation === 'search' ? 'web_search_exa' : 'web_fetch_exa';
      args = operation === 'search' ? { query: o.query, numResults: o.n } : { urls, maxCharacters: o.maxChars };
    }
    return { ...base, ...(operation === 'search' ? { query: o.query } : {}), ...await mcp(provider, name, args, o, signal) };
  }
  return { execute };
}

export async function runCli(args, { out = console.log, log = message => console.error(`[websearch] ${message}`), ...deps } = {}) {
  try {
    const options = parseArgs(args);
    if (options.command === 'help') { out(HELP); return 0; }
    const result = await createSearch({ ...deps, log }).execute(options);
    out(JSON.stringify(result, null, 2)); return 0;
  } catch (error) {
    const cause = error.cause?.code ? ` (${error.cause.code})` : '';
    const reason = `${error.message}${cause}`;
    log(reason); out(JSON.stringify({ ok: false, error: reason })); return 1;
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await runCli(process.argv.slice(2));
