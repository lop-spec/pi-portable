import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(process.env.PIWEB_SOURCE || 'upstream');
const require = createRequire(path.join(root, 'package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createJiti } = require('jiti');
const jiti = createJiti(path.join(root, 'image-output-test.mjs'), { jsx: { runtime: 'automatic' }, alias: { '@': root } });
const { MarkdownBody } = await jiti.import(path.join(root, 'components/MarkdownBody.tsx'));
const { I18nProvider } = await jiti.import('@/hooks/useI18n');
function render(text, props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MarkdownBody, { cwd: 'C:/project', ...props }, text)));
}
for (const [name, url] of [
  ['Windows absolute', 'C:/project/chart.png'],
  ['file URL', 'file:///C:/project/chart.png'],
  ['relative', './chart.png'],
]) {
  test(`${name} image survives sanitization without an onOpenFile callback`, () => {
    const html = render(`![chart](${url})`);
    assert.match(html, /src="\/api\/files\/C%3A\/project\/chart.png\?type=read"/);
    assert.match(html, /aria-haspopup="dialog"/);
  });
}
test('encoded Chinese, space and hash names survive resolution', () => {
  const html = render('![chart](file:///C:/project/%E5%9B%BE%20%231.png)');
  assert.match(html, /%E5%9B%BE%20%231.png\?type=read/);
});
test('remote images, normal text, fenced code and safe links remain intact', () => {
  const html = render('hello **world**\n\n![remote](https://example.com/a.png)\n\n[docs](https://example.com)\n\n```text\n![literal](C:/project/chart.png)\n```');
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal((html.match(/<img /g) || []).length, 1);
});
test('unsafe protocols are never promoted to image URLs or executable markup', () => {
  for (const url of ['javascript:alert%281%29', 'vbscript:evil', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const html = render(`![bad](${url})`);
    assert.doesNotMatch(html, /<img /);
    assert.doesNotMatch(html, /href="(?:javascript|vbscript|data):/);
  }
  assert.doesNotMatch(render('<img src="javascript:evil" onerror="alert(1)">'), /onerror=|src="javascript:/);
});
test('relative traversal is not rewritten to a file API request', () => {
  assert.doesNotMatch(render('![outside](../../private.png)'), /src="\/api\/files/);
});
test('file links remain inert without an app handler', () => {
  assert.match(render('[file](file:///C:/project/a.txt)'), /href=""/);
});
