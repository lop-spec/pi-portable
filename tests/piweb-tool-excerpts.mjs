import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractChineseSource, toolChineseExcerpts, newToolChineseExcerpts } from '../assets/piweb-overlay/tool-excerpts/tool-chinese-excerpts.mjs';
import { integrateToolExcerpts } from '../tools/patch-piweb-tool-excerpts.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = text => ({ role: 'toolResult', toolCallId: 'call', content: [{ type: 'text', text }] });
test('Chinese is a selection condition, not a split point: preserve punctuation, identifiers and numbers', () => {
  const text = '已检查 index.ts 的 3 个分支，API 返回 502；下一步检查 retry=2。';
  assert.deepEqual(toolChineseExcerpts(result(text)), [text]);
  assert.deepEqual(toolChineseExcerpts(result('四个汉字')), []);
});
test('JSON keys/quotes delimit complete values, including escaped quotes and newlines', () => {
  const message = '已检查 API 的 3 个分支，结果为“正常”。\n下一行保留 index.ts 和 502。';
  assert.deepEqual(extractChineseSource(JSON.stringify({ message, status: 'success', nested: { text: '继续核对 foo.ts：耗时 12 ms。' } })), [message, '继续核对 foo.ts：耗时 12 ms。']);
});
test('code string literals and browser accessibility quotes drop wrappers, never evaluate templates', () => {
  assert.deepEqual(extractChineseSource('console.log("已检查 index.ts，耗时 3 ms。");'), ['已检查 index.ts，耗时 3 ms。']);
  assert.deepEqual(extractChineseSource('  - button "当前项目：综合工作台（3）" [ref=f1e19] [cursor=pointer]:'), ['当前项目：综合工作台（3）']);
  assert.deepEqual(extractChineseSource("const label = '检查结果已经通过：API=200。';"), ['检查结果已经通过：API=200。']);
  assert.deepEqual(extractChineseSource('const label = `检查结果已经通过：${notEvaluated}。`;'), ['检查结果已经通过：${notEvaluated}。']);
});
test('plain paragraphs keep their own newlines, quotes, punctuation and full English context', () => {
  assert.deepEqual(extractChineseSource('正在核对 API（502）。\n下一行仍属于同一段。\n\n另一个完整段落：文件是 foo.ts。'), ['正在核对 API（502）。\n下一行仍属于同一段。', '另一个完整段落：文件是 foo.ts。']);
  assert.deepEqual(extractChineseSource('他说“检查结果已经通过”，但 API 仍返回 502。'), ['他说“检查结果已经通过”，但 API 仍返回 502。']);
});
test('fenced JSON and JSONL preserve complete string values and omit structural scaffolding', () => {
  assert.deepEqual(extractChineseSource('### Result\n```json\n{"message":"检查结果已经通过：API=200。"}\n```'), ['检查结果已经通过：API=200。']);
  assert.deepEqual(extractChineseSource('{"message":"第一条中文摘录：API=200。"}\n{"message":"第二条中文摘录：API=502。"}'), ['第一条中文摘录：API=200。', '第二条中文摘录：API=502。']);
});
test('deduplicate entire source units, not repeated substrings inside a sentence', () => {
  const seen = new Set();
  assert.deepEqual(newToolChineseExcerpts(result('第一条中文摘录。\n\n第一条中文摘录。'), seen), ['第一条中文摘录。']);
  assert.deepEqual(newToolChineseExcerpts(result('第一条中文摘录。\n\n第二条中文摘录。'), seen), ['第二条中文摘录。']);
  assert.deepEqual(newToolChineseExcerpts(result('第一条中文摘录。'), new Set()), ['第一条中文摘录。']);
  assert.deepEqual(extractChineseSource('检查结果已经通过；检查结果已经通过。'), ['检查结果已经通过；检查结果已经通过。']);
});
test('never reads assistant reasoning, tool arguments, images or private metadata', () => {
  assert.deepEqual(toolChineseExcerpts({ role: 'assistant', content: [{ type: 'thinking', thinking: '这段内容不可提取' }] }), []);
  assert.deepEqual(toolChineseExcerpts({ ...result(''), content: [{ type: 'image', text: '这是图像里的文字' }], thinking: '这段内容不可提取', arguments: { text: '这段内容不可提取' } }), []);
});
test('sensitive lines are excluded; other lines stay verbatim', () => {
  assert.deepEqual(toolChineseExcerpts(result('密码说明不要展示\n检查结果已经通过\nAuthorization: 这段内容不可展示\n密钥检查不要展示')), ['检查结果已经通过']);
});
test('full-result extraction survives the shortened history preview', () => {
  const raw = result('x'.repeat(3000) + '\n末尾检查结果已经通过');
  const slim = { ...raw, content: [{ type: 'text', text: 'x'.repeat(500) }], chatView: { chineseExcerpts: toolChineseExcerpts(raw) } };
  assert.deepEqual(toolChineseExcerpts(slim), ['末尾检查结果已经通过']);
});
test('untrusted saved values cannot inject markup or non-Chinese tokens', () => {
  assert.deepEqual(toolChineseExcerpts({ ...result(''), chatView: { chineseExcerpts: ['检查结果已经通过：API=200。', '<img src=x>', '短语', '五个中文字', null] } }), ['检查结果已经通过：API=200。', '五个中文字']);
});
test('nested reasoning and credential fields are excluded even in structured tool payloads', () => {
  assert.deepEqual(extractChineseSource(JSON.stringify({ thinking: '不应读取内部推理', analysis: '不应读取内部推理', encrypted_content: '不应读取内部推理', password: '不应显示任何密码', message: '检查结果已经通过：API=200。', content: [{ type: 'thinking', text: '不应读取内部推理' }] })), ['检查结果已经通过：API=200。']);
});
test('cache is read-only and replacement streaming results get new excerpts', () => {
  const raw = result('检查结果已经通过'), snapshot = JSON.stringify(raw);
  assert.equal(toolChineseExcerpts(raw), toolChineseExcerpts(raw));
  assert.equal(JSON.stringify(raw), snapshot);
  assert.deepEqual(toolChineseExcerpts({ ...raw, content: [{ type: 'text', text: '新增第二条检查结果' }] }), ['新增第二条检查结果']);
});
function integratedFixture() {
  const files = new Map([
    ['components/PortableProcessTimeline.tsx', fs.readFileSync(path.join(root, 'assets/piweb-overlay/redesign/files/components/PortableProcessTimeline.tsx'), 'utf8').replaceAll('\r\n', '\n').replace('portableLoadThinkingContent(sessionId, entryId, blockIndex)', 'portableLoadThinkingContent(sessionId, entryId, blockIndex, block.entryQuery)')],
    ['lib/session-reader.ts', 'chatView: { bytes: number; images: number; truncated: boolean }\nchatView: { bytes, images, truncated: text.length > CHAT_VIEW_PREVIEW_CHARS || images > 0 },'],
  ]);
  integrateToolExcerpts({
    get: name => files.get(name), set: (name, text) => files.set(name, text),
    prepend: (name, text) => { const s = files.get(name); files.set(name, s.startsWith('"use client";\n') ? s.replace('"use client";\n', '"use client";\n' + text) : text + s); },
    change: (name, old, text) => { const s = files.get(name); assert.equal(s.split(old).length - 1, 1, name + ': unique anchor'); files.set(name, s.replace(old, text)); },
    template: name => name === 'tool-excerpts/manifest.json' ? '{"files":{}}' : fs.readFileSync(path.join(root, 'assets/piweb-overlay', name), 'utf8').replaceAll('\r\n', '\n'),
  });
  return files;
}
test('history and live views share the labelled renderer, memo observes new tool results', () => {
  const files = integratedFixture(), timeline = files.get('components/PortableProcessTimeline.tsx');
  assert.match(timeline, /toolName=\{item.toolName\}/);
  assert.match(timeline, /replyActive=\{Boolean\(live\)\}/);
  assert.match(timeline, /modelNames, toolResults\), \[entries, searchBlock, modelNames, toolResults\]/);
  assert.match(files.get('lib/session-reader.ts'), /chineseExcerpts: toolChineseExcerpts\(result\)/);
  assert.doesNotMatch(files.get('components/ToolChineseExcerpt.tsx'), /innerHTML|MarkdownBody|fetch\(/);
});
const source = [process.env.PIWEB_SOURCE, path.join(root, 'upstream')].find(p => p && fs.existsSync(path.join(p, 'node_modules/typescript')));
function loadTs(text, imports, filename) {
  const require = createRequire(path.join(source, 'package.json'));
  const ts = require('typescript');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: id => imports[id] ?? require(id), console, setInterval, clearInterval, setTimeout, clearTimeout }, { filename });
  return exports;
}
test('timeline emits excerpts for hidden tool calls, not narration/thinking; live replacements update', { skip: !source }, () => {
  const display = loadTs(fs.readFileSync(path.join(root, 'assets/piweb-overlay/redesign/files/lib/message-display.ts'), 'utf8'), {}, 'message-display.ts');
  const component = loadTs(integratedFixture().get('components/PortableProcessTimeline.tsx'), {
    './MessageView': { getModelDisplayName: () => 'Model' },
    './ToolChineseExcerpt': {}, './conversation/ErrorNotice': {}, './conversation/icons': {},
    '@/lib/tool-chinese-excerpts.mjs': { newToolChineseExcerpts }, '@/lib/message-display': display,
    '@/lib/apply-patch': {}, '@/lib/tool-names': {},
  }, 'PortableProcessTimeline.tsx');
  const entries = [{ kind: 'assistant', key: 'a', entryId: 'a', message: { role: 'assistant', content: [{ type: 'toolCall', toolCallId: 'call', toolName: 'read' }] } }];
  assert.equal(component.buildTimelineItems(entries).length, 0);
  const results = new Map([['call', result('检查结果已经通过')]]);
  let items = component.buildTimelineItems(entries, () => false, undefined, results);
  assert.equal(items.length, 1); assert.equal(items[0].type, 'tool-excerpt');
  assert.deepEqual([...items[0].phrases], ['检查结果已经通过']);
  assert.equal(component.summarizeTimelineItems(items).thinking, 0);
  assert.equal(component.summarizeTimelineItems(items).narration, 0);
  results.set('call', result('新增第二条检查结果'));
  items = component.buildTimelineItems(entries, () => false, undefined, results);
  assert.deepEqual([...items[0].phrases], ['新增第二条检查结果']);
});
test('manual expansion survives tool updates, resets once on reply completion, and can reopen afterwards', { skip: !source }, () => {
  const values = []; let cursor = 0, dirty = false;
  const react = { memo: fn => fn, useState(initial) {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], value => { const next = typeof value === 'function' ? value(values[index]) : value; if (next !== values[index]) { values[index] = next; dirty = true; } }];
  } };
  const jsx = (type, props) => ({ type, props });
  const { ToolChineseExcerpt } = loadTs(integratedFixture().get('components/ToolChineseExcerpt.tsx'), { react, 'react/jsx-runtime': { jsx, jsxs: jsx } }, 'ToolChineseExcerpt.tsx');
  const phrases = Array.from({ length: 9 }, (_, i) => `检查结果已经通过${i}`);
  const render = replyActive => { let tree; do { cursor = 0; dirty = false; tree = ToolChineseExcerpt({ phrases, toolName: 'read', replyActive }); } while (dirty); return tree; };
  const button = tree => tree.props.children[1];
  let tree = render(true); assert.equal(button(tree).props['aria-expanded'], false);
  button(tree).props.onClick(); tree = render(true); assert.equal(button(tree).props['aria-expanded'], true);
  tree = render(true); assert.equal(button(tree).props['aria-expanded'], true);
  tree = render(false); assert.equal(button(tree).props['aria-expanded'], false);
  button(tree).props.onClick(); tree = render(false); assert.equal(button(tree).props['aria-expanded'], true);
  tree = render(false); assert.equal(button(tree).props['aria-expanded'], true);
  tree = render(true); tree = render(false); assert.equal(button(tree).props['aria-expanded'], false);
});
test('real React shows complete paragraphs without repeated visible source labels; provenance is hover-only', { skip: !source }, () => {
  const require = createRequire(path.join(source, 'package.json'));
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const { ToolChineseExcerpt } = loadTs(integratedFixture().get('components/ToolChineseExcerpt.tsx'), {}, 'ToolChineseExcerpt.tsx');
  const phrases = Array.from({ length: 10 }, (_, i) => '检查结果已经通过' + String.fromCharCode(0x4e00 + i));
  const html = renderToStaticMarkup(React.createElement(ToolChineseExcerpt, { phrases, toolName: 'read' }));
  assert.doesNotMatch(html, /工具中文摘录/); assert.match(html, /展开其余 4 段/);
  assert.match(html, /title="来源：read 工具输出"/);
  assert.equal((html.match(/<p /gu) ?? []).length, 6);
  assert.ok(html.includes(phrases[5])); assert.ok(!html.includes(phrases[6]));
});
