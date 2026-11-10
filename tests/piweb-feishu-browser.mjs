// Generate a self-contained check for the daily-browser Extension (never launches another browser).
// node tests/piweb-feishu-browser.mjs <integrated-source> <output.js>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('integrated source and output JS required');
const require = createRequire(path.join(source, 'package.json'));
const ts = require('typescript');
let code = ts.transpileModule(fs.readFileSync(path.join(source, 'lib/clipboard.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
code = code.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const start = code.indexOf('const markdownProcessor ='), end = code.indexOf('/** HTML is for Feishu/Docs;');
if (start < 0 || end < start) throw new Error('clipboard processor boundary drift');
code = code.slice(0, start) + code.slice(end);
const check = `
const checks = [];
const assert = (pass, name) => { if (!pass) throw new Error(name); checks.push(name); };
const previous = window.getSelection();
const oldRanges = previous ? Array.from({length:previous.rangeCount},(_,i)=>previous.getRangeAt(i).cloneRange()) : [];
const fixture = document.createElement('section');
fixture.style.cssText='position:fixed;left:-20000px;top:0';
fixture.innerHTML='<div class="markdown-body"><h2>标题</h2><p><strong>中文加粗</strong>和<a href="https://www.feishu.cn/">链接</a></p><button>不应复制按钮</button></div><pre class="file-source-view"><span class="file-source-line"><span class="react-syntax-highlighter-line-number">1</span><span>  SELECT * FROM a_b;</span></span><span class="file-source-line"><span aria-hidden="true">2</span><span>  -- 第二行</span></span></pre><textarea>输入原文</textarea>';
document.body.append(fixture);
const stop = installSelectionCopy();
const select = element => { const range=document.createRange();range.selectNodeContents(element);const s=window.getSelection();s.removeAllRanges();s.addRange(range); };
const copy = element => {const data=new DataTransfer();const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});element.dispatchEvent(event);return {text:data.getData('text/plain'),html:data.getData('text/html'),handled:event.defaultPrevented};};
try {
 const markdown=fixture.querySelector('.markdown-body');select(markdown);let result=copy(markdown);
 assert(result.handled && /<strong[^>]*>中文加粗/.test(result.html),'rendered selection keeps bold');
 assert(result.html.includes('href="https://www.feishu.cn/"'),'rendered selection keeps links');
 assert(!result.html.includes('不应复制按钮'),'selected copy excludes buttons');
 const file=fixture.querySelector('.file-source-view');select(file);result=copy(file);
 assert(result.text === '  SELECT * FROM a_b;\\n  -- 第二行','source selection keeps indentation/newlines without line numbers');
 assert(result.html.includes('<pre') && !result.html.includes('aria-hidden'),'source selection produces a code block');
 const textarea=fixture.querySelector('textarea');result=copy(textarea);
 assert(!result.handled,'input and textarea retain native copy');
 const s=window.getSelection();s.removeAllRanges();result=copy(markdown);assert(!result.handled,'empty selection is not overridden');
 return {ok:true,checks,secure:isSecureContext};
} finally {stop();fixture.remove();const s=window.getSelection();s.removeAllRanges();for(const range of oldRanges)if(range.startContainer.isConnected && range.endContainer.isConnected)s.addRange(range);}
`;
fs.writeFileSync(output, '(() => {\n' + code + '\n' + check + '\n})()');
console.log(output);
