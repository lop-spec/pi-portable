import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.PIWEB_COPY_SOURCE || path.join(repo, 'upstream');
const { createClipboardPayload, copyText, fileCopyFormat, writeClipboard } = await import(pathToFileURL(path.join(source, 'lib/clipboard.ts')));

test('GFM becomes semantic rich HTML; plain source stays byte-for-byte intact', () => {
  const text = '# 结论\n\n**关键结论：**正常，*斜体*、~~删除~~、`db.table`。\n\n- 一级\n  - 二级\n\n3. 第三项\n\n> 引用\n\n[飞书](https://www.feishu.cn/)\n\n|对象|状态|\n|---|---|\n|中文|通过|\n\n```sql\nSELECT * FROM t WHERE x < 3;\n```';
  const result = createClipboardPayload(text, 'markdown');
  assert.equal(result.text, text);
  for (const tag of ['h1','strong','em','del','code','ul','ol','li','blockquote','a','table','th','td','pre']) assert.match(result.html, new RegExp('<' + tag + '(?:>| )'), tag);
  assert.match(result.html, /font-weight:bold/);
  assert.match(result.html, /start="3"/);
  assert.match(result.html, /href="https:\/\/www.feishu.cn\/"/);
  assert.match(result.html, /x &(?:lt|#x3C); 3/);
  assert.match(result.html, /<!--StartFragment-->/);
});

test('CJK emphasis next to punctuation uses the same plugin as the display', () => {
  assert.match(createClipboardPayload('**结论：**没有异常', 'markdown').html, /<strong[^>]*>结论：<\/strong>没有异常/);
});

test('code, paths, CRLF, indentation, quotes and terminal commands are never interpreted as Markdown', () => {
  const text = '  SELECT ** FROM a_b;\r\n\tC:\\temp\\a_b.md\r\n<x>&"\'\n';
  for (const format of ['plain','code']) {
    const result = createClipboardPayload(text, format);
    assert.equal(result.text, text);
    assert.doesNotMatch(result.html, /<strong|<em|<x>/);
    assert.match(result.html, /&lt;x&gt;&amp;&quot;&#39;/);
    assert.match(result.html, /white-space:pre-wrap/);
  }
  assert.match(createClipboardPayload(text, 'code').html, /<pre[^>]*><code/);
});

test('raw HTML is sanitized, scripts/events/private MIME are not exported', () => {
  const result = createClipboardPayload('<div><b>正文</b><script>alert(1)</script><a href="javascript:alert(2)" onclick="bad()">链接</a><iframe src="https://example.com"></iframe></div>', 'html');
  assert.match(result.html, /<b[^>]*>正文<\/b>/);
  assert.doesNotMatch(result.html, /script|alert\(|javascript:|onclick|iframe/);
  const external = createClipboardPayload('![说明](https://example.com/a.png)\n\n- [x] 完成\n- [ ] 待办', 'markdown');
  assert.doesNotMatch(external.html, /<img|<input/);
  assert.match(external.html, /\[说明\] \(https:\/\/example.com\/a.png\)/);
  assert.match(external.html, /☑/); assert.match(external.html, /☐/);
});

test('file format dispatch supports documents without changing code and data files', () => {
  for (const file of ['说明.MD','a.markdown','a.mdx']) assert.equal(fileCopyFormat(file), 'markdown');
  for (const file of ['a.htm','a.HTML']) assert.equal(fileCopyFormat(file), 'html');
  for (const file of ['a.txt','a.csv','a.log']) assert.equal(fileCopyFormat(file), 'plain');
  for (const file of ['a.sql','a.json','a.py','a.ts','a.yaml']) assert.equal(fileCopyFormat(file), 'code');
});

function globals(clipboard, command = () => false) {
  const old = new Map(['navigator','document','ClipboardItem'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const events = new EventTarget();
  const document = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), execCommand: name => command(name, events) };
  class Item { constructor(data) { this.data = data; } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: Item });
  return () => { for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
}

test('a single ClipboardItem contains HTML plus exact original text', async () => {
  let data;
  const restore = globals({ write: async items => { assert.equal(items.length, 1); data = items[0].data; } });
  try {
    await copyText('**正文**\n\n- 内容', 'markdown');
    assert.deepEqual(Object.keys(data).sort(), ['text/html','text/plain']);
    assert.equal(await data['text/plain'].text(), '**正文**\n\n- 内容');
    assert.match(await data['text/html'].text(), /<strong/);
  } finally { restore(); }
});

test('denied async API and insecure HTTP preserve both MIME types with copy-event fallback', async () => {
  for (const modern of [false, true]) {
    const data = new Map();
    const restore = globals(modern ? { write: async () => { throw new Error('NotAllowedError'); } } : undefined, (name, events) => {
      assert.equal(name, 'copy');
      const event = new Event('copy', { cancelable: true });
      event.clipboardData = { setData: (type, value) => data.set(type, value) };
      events.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      return true;
    });
    try {
      await copyText('原文\n下一行');
      assert.equal(data.get('text/plain'), '原文\n下一行');
      assert.match(data.get('text/html'), /white-space:pre-wrap/);
    } finally { restore(); }
  }
});

test('if rich clipboard is unavailable, plain fallback is exact and failures reject', async () => {
  let copied;
  let restore = globals({ writeText: async text => { copied = text; } });
  try { await copyText('原文'); assert.equal(copied, '原文'); } finally { restore(); }
  restore = globals({ writeText: async () => { throw new Error('blocked'); } });
  try { await assert.rejects(() => copyText('失败'), /blocked/); } finally { restore(); }
  restore = globals(undefined);
  try { await assert.rejects(() => writeClipboard(createClipboardPayload('失败')), /浏览器不允许/); } finally { restore(); }
});

test('all final UI copies use one writer; message, file, code and slash-copy formats are explicit', () => {
  const read = name => fs.readFileSync(path.join(source, name), 'utf8');
  const files = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else if (/\.(tsx?|mjs|js)$/.test(file) && !/\.test\./.test(file)) files.push(file); } };
  for (const dir of ['components','hooks']) walk(path.join(source, dir));
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /navigator\.clipboard\.(writeText|write)|document\.execCommand\(["']copy/, file);
  assert.match(read('components/MessageView.tsx'), /copyText\(textContent, "markdown"\)/);
  assert.match(read('components/PortableFilePreview.tsx'), /copyText\(await response.text\(\), fileCopyFormat\(path\)\)/);
  assert.match(read('components/MermaidBlock.tsx'), /copyText\(code, "code"\)/);
  assert.match(read('hooks/useAgentSession.ts'), /copyText\(textToCopy, "markdown"\)/);
  assert.match(read('app/layout.tsx'), /<ClipboardSelection \/>/);
  assert.match(read('lib/clipboard.ts'), /selection\.isCollapsed/);
  assert.match(read('lib/clipboard.ts'), /input,textarea,\[contenteditable\]/);
});
