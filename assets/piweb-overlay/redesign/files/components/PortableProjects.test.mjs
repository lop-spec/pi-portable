import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { hiddenProjectList, visibleProjectList } = await jiti.import("./PortableProjects.tsx");
const read = async (name) => (await readFile(new URL(name, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const actionsSource = await read("./PortableContextActions.tsx");
const switcherSource = await read("./sidebar/ProjectSwitcher.tsx");

const KEY = "c:\\users\\demo\\projects\\renamed-demo";
const ROOT = "C:\\Users\\demo\\Projects\\renamed-demo";

test("regression: a hidden project with no sessions shows its remembered original-case root, not the lowercase registry key", () => {
  const registry = { projects: [], hidden: [KEY] };
  // 旧实现：注册表 remove 之后只剩小写 key，最近活动里也没有它 → root 退化成 key（QA F11：删除框显示全小写路径）
  assert.equal(hiddenProjectList([], registry, new Map())[0].root, KEY, "without any memory the key is the only thing left");
  const remembered = new Map([[KEY, ROOT]]);
  assert.deepEqual(hiddenProjectList([], registry, remembered), [{ key: KEY, root: ROOT, name: undefined }]);
});

test("regression: a root from recent activity or the registry beats the remembered one, and the remembered one beats the key", () => {
  const remembered = new Map([[KEY, "C:\\stale\\Root"]]);
  const fromSessions = hiddenProjectList([{ key: KEY, root: ROOT }], { projects: [], hidden: [KEY] }, remembered);
  assert.equal(fromSessions[0].root, ROOT);
  const fromRegistry = hiddenProjectList([], { projects: [{ key: KEY, root: ROOT, name: "QA" }], hidden: [KEY] }, remembered);
  assert.deepEqual(fromRegistry[0], { key: KEY, root: ROOT, name: "QA" });
  assert.equal(hiddenProjectList([], { projects: [], hidden: [KEY] }, remembered)[0].root, "C:\\stale\\Root");
});

test("regression: visible projects keep the registry root untouched (case preserved)", () => {
  const list = visibleProjectList([], { projects: [{ key: KEY, root: ROOT }], hidden: [] });
  assert.equal(list[0].root, ROOT);
});

test("regression: hide remembers the original root, restore and delete forget it, and the delete dialog compares whole paths case-insensitively", () => {
  assert.match(actionsSource, /export async function setProjectHidden\(project: NamedProject, hidden: boolean\): Promise<ProjectRegistry> \{\n  const registry = await projectRequest\('\/api\/projects', \{ action: hidden \? 'remove' : 'add', cwd: project\.root \}\);\n  \/\/[^\n]*\n  if \(hidden\) rememberProjectRoot\(project\.key, project\.root\);\n  else forgetProjectRoot\(project\.key\);\n  return registry;\n\}/);
  assert.match(actionsSource, /\(kind === 'delete' \? !projectPathConfirmed\(value, project\.root\) : !value\.trim\(\)\)/);
  assert.doesNotMatch(actionsSource, /value !== project\.root/);
  // 服务端按精确字符串比 confirmPath：发送项目自己的 root（原生写法），不是用户键入的大小写变体
  assert.match(actionsSource, /const target = kind === 'delete' \? confirmPathFor\(project\.root\) : project\.root;/);
  assert.match(actionsSource, /action: kind, cwd: target, name: value, confirmPath: kind === 'delete' \? target : undefined/);
  assert.match(actionsSource, /forgetProjectRoot\(project\.key\);\n      onClose\(\);/);
  // ProjectSwitcher 仍用 root 选择/展示，只拿 key 做身份比较
  assert.match(switcherSource, /const checked = project\.key === current\?\.key;/);
});
