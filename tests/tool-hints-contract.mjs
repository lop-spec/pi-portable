// lop-tool-hints：非法正则改字面量、rg 合法写法不动；路径不存在附相近项；非错误/非路径错误不介入。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tool-hints-"));
process.env.PI_TOOL_HINTS_LOG = path.join(temp, "hints.log");
const { default: register, isInvalidRegex, missingPathHint } = await import("../src/extensions/lop-tool-hints.ts");

const handlers = {}; let tool;
// 假 TypeBox 与假原生 read：只验证覆盖逻辑，不依赖 Pi 安装位置
const Type = { Object: p => ({ type: "object", properties: p }), Optional: x => ({ ...x, optional: true }), Array: (i, o) => ({ type: "array", items: i, ...o }), String: () => ({ type: "string" }) };
const reads = [];
const createReadToolDefinition = cwd => ({ name: "read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }),
  async execute(id, input) { reads.push({ cwd, id, input }); const file = path.resolve(cwd, input.path); if (!fs.existsSync(file)) throw Error("ENOENT: no such file or directory, access '" + file + "'"); return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }], details: { file } }; } });
await register({ on: (name, fn) => { handlers[name] = fn; }, registerTool: t => { tool = t; } }, { Type, createReadToolDefinition });

// 正则判定
assert.equal(isInvalidRegex("listen("), true);
assert.equal(isInvalidRegex("foo|bar\\(x\\)"), false);
assert.equal(isInvalidRegex("(?i)select\\s+\\*"), false);
assert.equal(isInvalidRegex("\\p{Han}+"), false);

// tool_call：只改非法正则的 grep
const bad = { toolName: "grep", toolCallId: "c1", input: { pattern: "listen(" } };
handlers.tool_call(bad);
assert.equal(bad.input.literal, true);
const good = { toolName: "grep", toolCallId: "c2", input: { pattern: "a|b" } };
handlers.tool_call(good);
assert.equal(good.input.literal, undefined);
const bash = { toolName: "bash", toolCallId: "c3", input: { command: "grep listen(" } };
handlers.tool_call(bash);
assert.deepEqual(bash.input, { command: "grep listen(" });

// 路径提示
const out = path.join(temp, "out");
fs.mkdirSync(out);
for (const name of ["2026-09-26.json", "2026-09-28.json", "readme.md"]) fs.writeFileSync(path.join(out, name), "x");
const hint = missingPathHint(path.join(out, "2026-09-27.json"), temp);
assert.match(hint, /最近存在的目录：.*\/out（共 3 项）/);
assert.ok(hint.indexOf("2026-09-28.json") < hint.indexOf("readme.md"), hint);
// 多级不存在：退到最近存在的祖先，并以第一级缺失目录名比对
const deep = missingPathHint(path.join(temp, "outs", "x", "y.txt"), temp);
assert.match(deep, /与「outs」最相近：out\//);

const enoent = (toolName, p) => ({ toolName, isError: true, input: { path: p }, content: [{ type: "text", text: `ENOENT: no such file or directory, access '${p}'` }] });
const r = handlers.tool_result(enoent("read", path.join(out, "2026-09-27.json")), { cwd: temp });
assert.equal(r.content.length, 2);
assert.match(r.content[1].text, /lop-tool-hints/);
assert.equal(handlers.tool_result({ ...enoent("read", "x"), isError: false }, { cwd: temp }), undefined);
assert.equal(handlers.tool_result(enoent("bash", "x"), { cwd: temp }), undefined);
assert.equal(handlers.tool_result({ toolName: "grep", isError: true, input: { path: out }, content: [{ type: "text", text: "rg: regex parse error" }] }, { cwd: temp }), undefined);
// 相对路径按 cwd 解析
const rel = handlers.tool_result({ toolName: "grep", isError: true, input: { path: "out/nope.json" }, content: [{ type: "text", text: "Path not found: out/nope.json" }] }, { cwd: temp });
assert.match(rel.content[1].text, /\/out（共 3 项）/);

// read 覆盖：不传 paths 原样交给原生；传 paths 同一次返回多个文件，失败的逐个附提示，不影响其他文件
assert.equal(tool.name, "read");
assert.ok(tool.parameters.properties.paths && tool.description.includes("paths"));
fs.writeFileSync(path.join(temp, "a.txt"), "AAA"); fs.writeFileSync(path.join(temp, "b.txt"), "BBB");
const ctx = { cwd: temp };
const single = await tool.execute("r1", { path: "a.txt", offset: 2 }, undefined, undefined, ctx);
assert.deepEqual(reads.at(-1).input, { path: "a.txt", offset: 2 });
assert.equal(single.content[0].text, "AAA");
const multi = await tool.execute("r2", { path: "a.txt", offset: 1, paths: ["b.txt", "out/missing.json", "a.txt"] }, undefined, undefined, ctx);
const text = multi.content.map(c => c.text).join("\n");
assert.match(text, /=== a\.txt ===\nAAA\n=== b\.txt ===\nBBB\n=== out\/missing\.json ===\n\[读取失败\] ENOENT/);
assert.match(text, /最近存在的目录：.*\/out（共 3 项）/);
assert.equal((text.match(/=== a\.txt ===/g) || []).length, 1, "duplicate of path is dropped");
assert.deepEqual(reads.slice(-3).map(r => r.input), [{ path: "a.txt", offset: 1 }, { path: "b.txt" }, { path: "out/missing.json" }]);
assert.equal(multi.details.file, path.join(temp, "a.txt"));
await assert.rejects(tool.execute("r3", { path: "x1", paths: ["x2"] }, undefined, undefined, ctx), /x1[\s\S]*x2/);
assert.equal(handlers.tool_result({ ...enoent("read", "x1"), input: { path: "x1", paths: ["x2"] } }, ctx), undefined);
// 依赖加载失败时保留原生 read 并记日志
let registered = false;
await register({ on() {}, registerTool() { registered = true; } }, { Type: null, createReadToolDefinition });
assert.equal(registered, false);

const logText = fs.readFileSync(process.env.PI_TOOL_HINTS_LOG, "utf8");
assert.match(logText, /grep-literal/);
assert.match(logText, /path-hint tool=read/);
assert.match(logText, /multi-read call=r2 files=3 failed=1 skipped=0/);
assert.match(logText, /FAIL_OPEN multi-read native-read-kept/);
fs.rmSync(temp, { recursive: true, force: true });
console.log("tool-hints-contract: ok");
