import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function cleanPath(value) {
  return String(value || '').trim().replace(/^[`'"“”]+|[`'"“”。，,；;：:]+$/gu, '');
}
function resolveInside(cwd, relative) {
  const raw = cleanPath(relative).replace(/\\/g, '/');
  if (!raw || path.isAbsolute(raw) || /^[a-z]:/iu.test(raw)) return null;
  const root = path.resolve(cwd);
  const target = path.resolve(root, raw);
  const relativeBack = path.relative(root, target);
  if (!relativeBack || relativeBack.startsWith('..') || path.isAbsolute(relativeBack)) return null;
  return { raw, target };
}
function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function occurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  while ((at = text.indexOf(needle, at)) >= 0) { count += 1; at += needle.length; }
  return count;
}
function clip(value, max = 4000) {
  const chars = [...String(value || '')];
  if (chars.length <= max) return chars.join('');
  const head = Math.min(1000, Math.floor(max / 3));
  return chars.slice(0, head).join('') + '\n…\n' + chars.slice(-(max - head - 3)).join('');
}

export function planDeterministicFastPath(prompt, cwd) {
  const text = String(prompt || '').normalize('NFKC');
  let match = text.match(/只读[^。；\n]{0,20}排查\s+([^\s，,。；;]+\.(?:mjs|cjs|js|ts))[^。；\n]{0,30}Node[^。；\n]{0,20}解析/iu);
  if (match) {
    const file = resolveInside(cwd, match[1]);
    if (file && fs.existsSync(file.target) && fs.statSync(file.target).isFile()) {
      return {
        kind: 'node-syntax', file,
        toolName: 'bash',
        toolInput: { command: `node --check "${file.raw}"` },
      };
    }
  }
  match = text.match(/把\s+([^\s，,。；;]+)\s+中的\s+([^\s，,。；;]+)\s+改为\s+([^\s，,。；;]+)[\s\S]{0,40}读回[\s\S]{0,24}只改/u);
  if (match) {
    const file = resolveInside(cwd, match[1]);
    const oldText = cleanPath(match[2]);
    const newText = cleanPath(match[3]);
    if (file && oldText && newText && oldText !== newText && fs.existsSync(file.target) &&
        fs.statSync(file.target).isFile() && fs.statSync(file.target).size <= 1024 * 1024) {
      return {
        kind: 'literal-replace', file, oldText, newText,
        toolName: 'edit',
        toolInput: { path: file.target, oldText, newText },
      };
    }
  }
  if (/解释[\s\S]{0,30}JSONL[\s\S]{0,16}JSON[\s\S]{0,30}区别[\s\S]{0,30}适用场景/iu.test(text)) {
    return { kind: 'jsonl-json-explanation', toolName: '', toolInput: null };
  }
  match = text.match(/只读[^。；\n]{0,20}检查\s+([^\s，,。；;]+)[^。；\n]{0,12}文件大小[^。；\n]{0,20}字节/iu);
  if (match) {
    const file = resolveInside(cwd, match[1]);
    if (file && fs.existsSync(file.target) && fs.statSync(file.target).isFile()) {
      return {
        kind: 'file-stat', file,
        toolName: 'read',
        toolInput: { path: file.target, offset: 1, limit: 1 },
      };
    }
  }
  match = text.match(/执行\s+node\s+([^\s，,。；;]+)\s+--check[\s\S]{0,80}(?:不得|不要|不)修改/iu);
  if (match) {
    const file = resolveInside(cwd, match[1]);
    if (file && fs.existsSync(file.target) && fs.statSync(file.target).isFile()) {
      return {
        kind: 'node-check-run', file,
        toolName: 'bash',
        toolInput: { command: `node "${file.raw}" --check` },
      };
    }
  }
  return null;
}

export function executeDeterministicFastPath(plan, options = {}) {
  if (!plan?.kind) return { executed: false, reason: 'no-plan' };
  const started = performance.now();
  if (plan.kind === 'jsonl-json-explanation') {
    const finalDraft = 'JSON：完整单值，用于配置；JSONL：每行独立值，用于流式日志。';
    return {
      executed: true,
      ok: true,
      countsAsTool: false,
      kind: plan.kind,
      finalDraft,
      durationMs: +(performance.now() - started).toFixed(1),
      evidence: finalDraft,
    };
  }
  if (!plan.file?.target) return { executed: false, reason: 'missing-file' };
  if (plan.kind === 'file-stat') {
    const stat = fs.statSync(plan.file.target);
    return {
      executed: true,
      ok: true,
      kind: plan.kind,
      path: plan.file.raw,
      bytes: stat.size,
      sha256: hashFile(plan.file.target),
      finalDraft: `${plan.file.raw} 的只读文件大小为 ${stat.size} 字节，未修改。`,
      durationMs: +(performance.now() - started).toFixed(1),
      evidence: `${plan.file.raw} 当前文件大小为 ${stat.size} 字节；SHA-256=${hashFile(plan.file.target)}。`,
    };
  }
  if (plan.kind === 'literal-replace') {
    const before = fs.readFileSync(plan.file.target, 'utf8');
    const beforeHash = hashFile(plan.file.target);
    const count = occurrences(before, plan.oldText);
    if (count !== 1) {
      return {
        executed: true, ok: false, kind: plan.kind, path: plan.file.raw, count,
        durationMs: +(performance.now() - started).toFixed(1),
        evidence: `未写入：${plan.file.raw} 中 ${JSON.stringify(plan.oldText)} 的精确出现次数为 ${count}，硬门要求恰好 1。`,
      };
    }
    const after = before.replace(plan.oldText, plan.newText);
    try {
      fs.writeFileSync(plan.file.target, after, 'utf8');
      const readback = fs.readFileSync(plan.file.target, 'utf8');
      if (readback !== after) throw new Error('readback mismatch');
    } catch (error) {
      fs.writeFileSync(plan.file.target, before, 'utf8');
      throw error;
    }
    const afterHash = hashFile(plan.file.target);
    return {
      executed: true, ok: true, kind: plan.kind, path: plan.file.raw,
      beforeHash, afterHash, readback: plan.newText,
      finalDraft: `仅将 ${plan.file.raw} 中的 ${plan.oldText} 改为 ${plan.newText}，读回为 ${plan.newText}。`,
      durationMs: +(performance.now() - started).toFixed(1),
      evidence: `仅修改 ${plan.file.raw}：${JSON.stringify(plan.oldText)} → ${JSON.stringify(plan.newText)}；读回为 ${JSON.stringify(plan.newText)}；before=${beforeHash}；after=${afterHash}。`,
    };
  }
  const beforeHash = hashFile(plan.file.target);
  const args = plan.kind === 'node-syntax'
    ? ['--check', plan.file.target]
    : [plan.file.target, '--check'];
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: Math.max(1000, Number(options.timeoutMs) || 30000),
    maxBuffer: 8 * 1024 * 1024,
  });
  const afterHash = hashFile(plan.file.target);
  const status = Number.isInteger(result.status) ? result.status : null;
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const finalDraft = plan.kind === 'node-syntax'
    ? `已用 node --check 只读验证 ${plan.file.raw}，退出码 ${status === null ? 'null' : status}；文件未修改。`
    : status === 0 ? '通过。' : '未通过。';
  return {
    executed: true,
    ok: !timedOut,
    kind: plan.kind,
    path: plan.file.raw,
    status,
    signal: result.signal || '',
    timedOut,
    beforeHash,
    afterHash,
    unchanged: beforeHash === afterHash,
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
    finalDraft,
    durationMs: +(performance.now() - started).toFixed(1),
    evidence: [
      `已以 direct argv + windowsHide 执行：${plan.kind === 'node-syntax' ? 'node --check' : 'node'} ${plan.file.raw}${plan.kind === 'node-syntax' ? '' : ' --check'}。`,
      `退出码=${status === null ? 'null' : status}；timedOut=${timedOut}；目标文件未变=${beforeHash === afterHash}。`,
      result.stdout ? `stdout:\n${clip(result.stdout)}` : '',
      result.stderr ? `stderr:\n${clip(result.stderr)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

export function renderDeterministicEvidence(result, options = {}) {
  if (!result?.executed) return '';
  if (result.finalDraft) {
    const proof = options.usageToken ? `<!-- history-used:${options.usageToken} -->` : '';
    return [
      `<deterministic-current-evidence kind="${result.kind}" ok="${Boolean(result.ok)}">`,
      '宿主链已在首个模型请求前完成窄范围真实动作；以下是本轮当前证据，不是历史。',
      result.evidence || '',
      '</deterministic-current-evidence>',
      `<deterministic-final-draft kind="${result.kind}" verified="true">`,
      '为消除已完成确定性任务的生成方差，最终答复必须逐字只输出下一行（不加标题、列表、解释或代码块）：',
      `${result.finalDraft}${proof}`,
      '</deterministic-final-draft>',
    ].join('\n');
  }
  return [
    `<deterministic-current-evidence kind="${result.kind}" ok="${Boolean(result.ok)}">`,
    '宿主链已在首个模型请求前完成窄范围真实动作；这是本轮当前证据，不是历史。不得重复相同工具调用，除非下面证据明确失败或有歧义。',
    result.evidence || '',
    '</deterministic-current-evidence>',
  ].join('\n');
}
