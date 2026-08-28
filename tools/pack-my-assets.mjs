// 私有构建层:把 lop 的全部敏感资产打成加密块,并可直接写入 GitHub Secret(供 CI 注入 exe)。
// 用法:node pack-my-assets.mjs [--upload]   口令自动生成高熵值并只打印一次。
// 注意:本脚本读取本机私有路径,不入公开仓(.gitignore)。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { packAssets } from "../src/assets-crypto.mjs";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", "assets.enc");
const REPO = "lop-spec/pi-portable";

// 布局键 → 本机源路径(键名即解密后在数据根的相对路径,见 launcher 布局契约)
const ENTRIES = {
  "auth.json": "C:/Users/lop/Documents/claude/vscodium/homes/acct2/auth.json",
  ".pi/agent/models.json": "C:/Users/lop/.pi/agent/models.json",
  ".pi/agent/settings.json": "C:/Users/lop/.pi/agent/settings.json",
  ".pi/agent/AGENTS.md": "C:/Users/lop/.pi/agent/AGENTS.md",
  ".pi/agent/extensions/lop-chain.ts": "C:/Users/lop/.pi/agent/extensions/lop-chain.ts",
  "rules-pretool.mjs": "C:/Users/lop/.claude/hooks/rule-enforcer/rules-pretool.mjs",
  "rules.jsonl": "C:/Users/lop/Documents/claude/decision-replay-engine/data/rules-corpus.jsonl",
  "anchors.jsonl": "C:/Users/lop/Documents/claude/decision-replay-engine/data/entities.jsonl",
};
const EXTRA_PORTS = [57905, 18799];

const tmpPorts = path.join(path.dirname(OUT), "egress-extra-ports.json");
fs.writeFileSync(tmpPorts, JSON.stringify(EXTRA_PORTS));
const password = process.env.PI_ASSETS_PASSWORD || crypto.randomBytes(24).toString("base64url");

const { blob, count, plainBytes } = packAssets({ ...ENTRIES, "egress-extra-ports.json": tmpPorts }, password);
fs.rmSync(tmpPorts, { force: true });
fs.writeFileSync(OUT, blob);
console.log(`packed ${count} assets, plain ${(plainBytes / 1024).toFixed(0)}KB -> ${OUT} (${(blob.length / 1024).toFixed(0)}KB)`);
if (!process.env.PI_ASSETS_PASSWORD) {
  console.log("\n=== 口令(只显示这一次,请立刻存进密码管理器)===");
  console.log(password);
  console.log("===============================================\n");
}

