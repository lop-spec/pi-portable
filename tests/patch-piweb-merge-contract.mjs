import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrate } from '../tools/patch-piweb-source.mjs';
import { integrateMerge } from '../tools/patch-piweb-merge.mjs';

// 界面合并步骤（tools/patch-piweb-merge.mjs）的合同：接在固定版本的上游源码上，所有锚点各出现一次，
// 输出里有标签栏 / 看板 / 继续任务 / 纸白主题 / 摘要 / 中文加粗的接入点，样式只用 token；锚点漂移时整体拒绝。
const repo = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.PIWEB_SOURCE ?? path.join(repo, 'upstream');
const available = fs.existsSync(path.join(source, 'package.json'));
const read = name => fs.readFileSync(path.join(source, name), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;

test('merge step wires every view into the integrated sources', { skip: !available }, () => {
  const files = integrate(read);
  const shell = files.get('components/AppShell.tsx');
  assert.equal(count(shell, '<SessionTabs />'), 1);
  assert.equal(count(shell, '<SessionBoard />'), 1);
  assert.equal(count(shell, 'publishPortableSessions('), 1);
  assert.match(shell, /useWindowEvent<CustomEvent<\{ id: string \}>>\(OPEN_SESSION_EVENT/);
  assert.match(shell, /useWindowEvent\(NEW_SESSION_EVENT/);
  assert.ok(shell.indexOf('<SessionTabs />') > shell.indexOf('className="pw-topbar-wrap"'), 'tabs sit inside the top bar wrapper');
  assert.ok(shell.indexOf('<SessionBoard />') < shell.indexOf('<ChatWindow'), 'the board mounts next to the chat, never replaces it');
  assert.equal(count(files.get('components/ChatWindow.tsx'), '<WelcomeResume />'), 1);
  const markdown = files.get('lib/markdown.ts');
  assert.equal(count(markdown, 'portableCjkEmphasis]'), 2, 'both remark plugin lists carry the CJK-friendly bold fix');
  assert.match(files.get('app/layout.tsx'), /import "\.\/craft-transcript\.css";\nimport "\.\/merge\.css";/);
  assert.match(files.get('components/PortableProcessTimeline.tsx'), /timelineBreakdown\(activities,props\.startedAt,end\?\.at\)/);
  assert.match(files.get('components/PortableProcessTimeline.tsx'), /summary\|\|breakdown\?'':'已完成'/);
  assert.match(files.get('components/CraftSessions.tsx'), /pw-craft-time' \+ \(props\.running\.has\(session\.id\) \? ' is-running' : ''\)/);
  for (const name of ['lib/portable-session-store.ts', 'lib/portable-session-board.mjs', 'lib/portable-timeline-summary.mjs', 'lib/portable-cjk-emphasis.mjs', 'components/SessionTabs.tsx', 'components/SessionBoard.tsx', 'components/WelcomeResume.tsx', 'app/merge.css']) {
    assert.ok(files.has(name), `${name} is shipped`);
  }
});

test('the paper theme is selectable, labelled in every language and drawn from tokens', { skip: !available }, () => {
  const files = integrate(read);
  assert.match(files.get('lib/theme.ts'), /\{ id: "paper", label: "settings\.themePaper" \}/);
  for (const locale of ['en', 'zh-CN', 'zh-TW']) assert.equal(count(files.get(`lib/i18n/messages/${locale}.ts`), '"settings.themePaper"'), 1, locale);
  assert.match(files.get('components/ThemeIcon.tsx'), /preference === "paper"/);
  assert.match(files.get('components/SettingsPanel.tsx'), /data-theme-choice=\{option\.id\}/);
  const css = files.get('app/merge.css');
  assert.match(css, /:root\[data-theme="paper"\]\s*\{[^}]*color-scheme: light;/);
  // 文字色必须在 token 里补齐，否则会在纸白下回落成浅色主题的冷灰
  for (const token of ['--bg', '--bg-panel', '--bg-elevated', '--bg-hover', '--bg-selected', '--border', '--border-strong', '--text', '--text-secondary', '--text-muted', '--text-dim', '--accent', '--accent-soft', '--success', '--warning', '--danger', '--user-bg', '--code-bg', '--shadow-pop']) {
    assert.match(css, new RegExp(`:root\\[data-theme="paper"\\]\\s*\\{[^}]*\\s${token}:`), `paper defines ${token}`);
  }
});

test('merge.css keeps colour literals inside the theme block and the swatches, and every radius within 8px', { skip: !available }, () => {
  const css = integrate(read).get('app/merge.css');
  const withoutAllowed = css
    .replace(/:root\[data-theme="paper"\]\s*\{[^}]*\}/u, '')
    .replace(/\.settings-theme-option\[data-theme-choice="[a-z]+"\]\s*\{[^}]*\}/gu, '');
  assert.deepEqual(withoutAllowed.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/gu) ?? [], [], 'only tokens outside the theme block and swatches');
  for (const [, value] of css.matchAll(/border-radius:\s*([^;]+);/gu)) {
    const radii = value.split(/\s+/u).filter(item => item !== 'inherit');
    for (const radius of radii) assert.ok(radius === '50%' || radius.startsWith('var(--r-') || Number.parseFloat(radius) <= 8, `radius ${radius}`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('sidebar uses status navigation and the search index is warmed outside typing', { skip: !available }, () => {
  const files = integrate(read);
  const tree = files.get('components/ProjectTree.tsx');
  assert.match(tree, /data-pi-status-navigation/);
  assert.match(tree, /pi-web:set-archive-view/);
  assert.doesNotMatch(tree, /control\.click\(\)|button\[data-pi-session-archive-control\]/);
  assert.match(files.get('app/api/sessions/search/route.ts'), /await warmSessionSearch\(sessions\)/);
  assert.match(files.get('components/SessionSearch.tsx'), /search\?warm=1/);
  assert.match(files.get('lib/session-search.ts'), /const CACHE_BYTES = 96 \* 1024 \* 1024/);
  const injected = fs.readFileSync(path.join(repo, 'src/piweb-archive-ui.js'), 'utf8');
  assert.match(injected, /pi-web:set-archive-view/);
  assert.match(injected, /if \(!document.querySelector\('\[data-pi-status-navigation\]'\)\)/);
  assert.match(injected, /pw-goal-board-btn/);
  assert.match(injected, /width="28" height="21" viewBox="0 0 32 24"/);
  assert.match(files.get('app/redesign-sidebar.css'), /min-height:44px/);
});

/** 与 integrate() 里一致的最小助手：锚点必须恰好出现 expected 次，否则抛错（整套叠加因此零写入）。 */
function harness(initial) {
  const files = new Map(initial);
  const set = (name, value) => files.set(name, value);
  const get = name => files.has(name) ? files.get(name) : read(name).replaceAll('\r\n', '\n');
  const change = (name, old, next, expected = 1) => {
    const text = get(name), actual = text.split(old).length - 1;
    if (actual !== expected) throw new Error(`${name}: anchor ${JSON.stringify(old.slice(0, 75))} matched ${actual}, expected ${expected}; zero writes`);
    set(name, text.replaceAll(old, next));
  };
  const directive = '"use client";\n';
  const prepend = (name, addition) => { const text = get(name); set(name, text.startsWith(directive) ? directive + addition + text.slice(directive.length) : addition + text); };
  const template = name => fs.readFileSync(path.join(repo, 'assets/piweb-overlay', name), 'utf8').replaceAll('\r\n', '\n');
  return { files, get, set, change, prepend, template };
}

test('the merge step is a pure function of the state before it, and refuses when an anchor drifts', { skip: !available }, () => {
  const before = integrate(read, { withoutMerge: true });
  const full = integrate(read);
  const applied = harness(before);
  integrateMerge(applied);
  assert.equal(applied.files.size, full.size, 'same set of files as the full integration');
  for (const [name, content] of full) assert.equal(applied.files.get(name), content, `${name} is identical`);
  const withEdit = (name, from, to) => {
    const seeded = new Map(before);
    const current = seeded.has(name) ? seeded.get(name) : read(name).replaceAll('\r\n', '\n');
    assert.ok(current.includes(from), `state before the merge contains ${from}`);
    seeded.set(name, current.replaceAll(from, to));
    return harness(seeded);
  };
  assert.throws(() => integrateMerge(withEdit('components/AppShell.tsx', '{isMobile && renderProjectTrustWarning(true)}', '{isMobile && renderTrustBanner(true)}')), /AppShell\.tsx: anchor .* matched 0, expected 1; zero writes/u);
  assert.throws(() => integrateMerge(withEdit('lib/markdown.ts', 'const chatRemarkPlugins: PluginList = [[remarkGfm, remarkGfmOptions], remarkMath];', 'const chatRemarkPlugins: PluginList = [];')), /markdown\.ts: anchor .* zero writes/u);
  assert.throws(() => integrateMerge(withEdit('components/PortableProcessTimeline.tsx', 'const active=activities.find(a=>a.id===selected);', 'const active=undefined;')), /PortableProcessTimeline\.tsx: anchor .* zero writes/u);
  assert.throws(() => integrateMerge(withEdit('components/ChatWindow.tsx', '<ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />', '<ExtensionStatusBar />')), /ChatWindow\.tsx: anchor .* zero writes/u);
  assert.throws(() => integrateMerge(withEdit('components/CraftSessions.tsx', "{props.running.has(session.id) ? '运行中' : formatSessionTime(session.modified, new Date())}", "{'运行中'}")), /CraftSessions\.tsx: anchor .* zero writes/u);
  assert.throws(() => integrateMerge(withEdit('lib/theme.ts', '  { id: "dark", label: "settings.themeDark" },', '')), /theme\.ts: anchor .* zero writes/u);
});
