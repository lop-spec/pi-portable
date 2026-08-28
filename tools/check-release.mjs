// S4 验收:确认 Release 资产存在、可匿名下载、SHA256 匹配。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO = "lop-spec/pi-portable";
const TAG = process.argv[2] || "v0.0.1-rc2";
const DEST = process.argv[3] || "C:/Users/lop/Documents/claude/scratchpad/pi-bridge-test-20260828/release-dl";

const rel = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-portable" },
})).json();
if (!rel.assets?.length) { console.error("无 Release 资产: " + JSON.stringify(rel).slice(0, 200)); process.exit(1); }
console.log(`Release ${rel.tag_name} 资产 ${rel.assets.length} 个:`);
for (const a of rel.assets) console.log(`  ${a.name} ${(a.size / 1024 / 1024).toFixed(1)}MB downloads=${a.download_count}`);

fs.mkdirSync(DEST, { recursive: true });
const exe = rel.assets.find((a) => a.name.endsWith(".exe"));
const sha = rel.assets.find((a) => a.name.endsWith(".sha256"));
if (!exe) { console.error("未找到 exe 资产"); process.exit(1); }

console.log(`\n匿名下载 ${exe.name} …`);
const t0 = Date.now();
const buf = Buffer.from(await (await fetch(exe.browser_download_url, { redirect: "follow" })).arrayBuffer());
const exePath = path.join(DEST, exe.name);
fs.writeFileSync(exePath, buf);
console.log(`下载完成 ${(buf.length / 1024 / 1024).toFixed(1)}MB ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${exePath}`);

const actual = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
let ok = true;
if (sha) {
  const expected = (await (await fetch(sha.browser_download_url, { redirect: "follow" })).text()).trim().toUpperCase();
  ok = actual === expected;
  console.log(`SHA256 ${ok ? "匹配" : "不匹配"}: ${actual.slice(0, 16)}… vs ${expected.slice(0, 16)}…`);
}
// exe 头必须是 MZ(PE 可执行)
const isPE = buf[0] === 0x4d && buf[1] === 0x5a;
console.log(`PE 可执行头: ${isPE ? "OK (MZ)" : "FAIL"}`);
console.log(`\nS4 Release 验收: ${ok && isPE ? "PASS" : "FAIL"}`);
process.exit(ok && isPE ? 0 : 1);
