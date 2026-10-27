import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { integrate } from '../tools/patch-piweb-source.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.PIWEB_SOURCE ?? path.join(repo, 'upstream');
const stateFile = path.join(source, '.pi-portable-overlay.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const original = name => {
  const record = state?.files[name];
  if (record && !record.backup) throw new Error('No upstream file: ' + name);
  return fs.readFileSync(record?.backup ?? path.join(source, name), 'utf8');
};
const files = integrate(original);

test('all conversation representations use the shared menu and session identity', () => {
  const menu = files.get('components/PortableFileContextMenu.tsx');
  assert.match(menu, />Open file</);
  assert.match(menu, />Open path</);
  assert.match(menu, /sessionId/);
  assert.match(menu, /onPreviewFile\?\.\(state\.path\)/);
  assert.match(menu, /role="alert"/);
  assert.match(files.get('components/TurnWrittenFiles.tsx'), /onContextMenu=.*fileMenu\.open/);
  const md = files.get('components/MarkdownBody.tsx');
  assert.equal((md.match(/onContextMenu=/g) ?? []).length, 3, 'link, image and inline path');
  assert.match(files.get('components/MessageView.tsx'), /PortableFileSession\.Provider value=\{sessionId\}/);
  const desktop = files.get('components/desktop-transcript/host.tsx');
  assert.match(desktop, /usePortableFileMenu\(host.cwd,host.sessionId,host.onOpenFile\)/);
  assert.match(desktop, /DesktopMarkdownLink/);
  assert.match(desktop, /DesktopMarkdownCode/);
  assert.equal(files.get('public/licenses/pi-desktop/source/host.tsx.txt'), desktop);
  const row = files.get('components/desktop-transcript/ToolRow.tsx');
  assert.match(row, /onContextMenu=\{previewTarget\?\.kind===\"file\"\?event=>fileMenu\.open\(event,path\)/);
  assert.equal(files.get('public/licenses/pi-desktop/source/ToolRow.tsx.txt'), row);
});

test('opening is same-origin, authorized, shell-free and reports errors', () => {
  const route = files.get('app/api/open-local-file/route.ts');
  for (const re of [/isApiRequestAllowed\(request\)/, /headers\.get\("origin"\)/, /hasJsonContentType\(request\)/, /isFilePathAllowed\(filePath, roots\)/, /isExistingFilePathAllowed\(filePath, roots\)/, /isFilePathReferencedBySession\(filePath, sessionId\)/, /path\.dirname\(filePath\)/, /PIWEB_LOCAL_OPEN_TARGET: target/, /windowsHide: true/, /status: 404/]) assert.match(route, re);
  assert.doesNotMatch(route, /shell:\s*true|cmd\.exe|execSync\(/);
});

test('Open path activates the exact Explorer window without altering normal file opens', () => {
  const route = files.get('app/api/open-local-file/route.ts');
  assert.match(route, /foregroundFolder \? windowsFolderFocusScript/);
  assert.match(route, /body\.action === "path" \|\| fileStat\.isDirectory\(\)/);
  assert.match(route, /PIWEB_EXPLORER_NOT_FOREGROUND/);
  const focus = fs.readFileSync(path.join(repo, 'assets/piweb-overlay/file-context/windows-folder-focus.ps1'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(files.get('lib/portable-windows-folder-focus.ts'), `export const windowsFolderFocusScript = ${JSON.stringify(focus)};\n`);
  for (const re of [/Find-FolderWindow/, /Folder\.Self\.Path/, /AttachThreadInput/, /finally\s*\{[\s\S]*?AttachThreadInput\(\$currentThread,\$foregroundThread,\$false\)/, /GetForegroundWindow\(\) -ne \$hwnd/, /PIWEB_EXPLORER_NOT_FOREGROUND/]) assert.match(focus, re);
  assert.ok(focus.indexOf('$hwnd=Find-FolderWindow') < focus.indexOf('[System.Diagnostics.Process]::Start($launch)'), 'reuse an existing folder before opening another');
  assert.doesNotMatch(focus, /SendKeys|SystemParametersInfo|SetForegroundWindow\([^$]/);
});

test('Windows absolute links survive sanitization, external links remain external', {skip: !fs.existsSync(path.join(source, 'node_modules', 'react'))}, async () => {
  const require = createRequire(path.join(source, 'package.json'));
  const { createJiti } = require('jiti');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const jiti = createJiti(path.join(source, 'components/MarkdownBody.test.mjs'), { jsx: { runtime: 'automatic' }, tsconfigPaths: true });
  // Run against the actual integrated checkout, not just the overlay templates.
  const { MarkdownBody } = await jiti.import(path.join(source, 'components/MarkdownBody.tsx'));
  const { localFilePathFromImageApi, localFilePathFromInlineCode } = await jiti.import(path.join(source, 'components/PortableFileContextMenu.tsx'));
  assert.equal(localFilePathFromInlineCode('C:/Users/me/project/a b.txt', 'C:/Users/me/project'), 'C:/Users/me/project/a b.txt');
  assert.equal(localFilePathFromInlineCode('not a path', 'C:/Users/me/project'), null);
  assert.equal(localFilePathFromImageApi('/api/files/C%3A/Users/me/%E5%9B%BE%E7%89%87.png?type=read'), 'C:/Users/me/图片.png');
  assert.equal(localFilePathFromImageApi('/api/files/%2F%2Fserver/share/a.png?type=read'), '//server/share/a.png');
  assert.equal(localFilePathFromImageApi('https://example.com/a.png'), null);
  const { I18nProvider } = await jiti.import(path.join(source, 'hooks/useI18n.tsx'));
  const render = text => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(MarkdownBody, { cwd: 'C:/Users/me/project', onOpenFile() {} }, text)));
  const html = render('[输出](C:/Users/me/project/%E6%96%87%E4%BB%B6.txt) [web](https://example.com/a) [bad](javascript:alert%281%29)');
  assert.match(html, /href="file:\/\/\/C:\/Users\/me\/project\/%E6%96%87%E4%BB%B6\.txt"/);
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.doesNotMatch(html, /href="javascript:/i);
});
