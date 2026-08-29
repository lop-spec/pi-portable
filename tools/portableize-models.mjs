// 把 models.json 里指向本机绝对路径的 apiKey/headers 凭证命令改写为便携版
// (从 PI_PORTABLE_DATA/auth.json 取 token),供 SSH 资产推送前预处理。
// 用法:node portableize-models.mjs <models.json 路径>
import fs from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: node portableize-models.mjs <models.json>"); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
let changed = 0;
const portable = (token) =>
  `!node -p "JSON.parse(require('fs').readFileSync(require('path').join(process.env.PI_PORTABLE_DATA,'auth.json'),'utf8')).tokens.${token}"`;

for (const provider of Object.values(doc.providers || {})) {
  for (const [holder, key] of [[provider, "apiKey"], ...Object.keys(provider.headers || {}).map((h) => [provider.headers, h])]) {
    const value = holder[key];
    if (typeof value !== "string" || !value.startsWith("!")) continue;
    const m = value.match(/\.tokens\.(\w+)/);
    if (!m) continue;
    const next = portable(m[1]);
    if (value !== next) { holder[key] = next; changed++; }
  }
}
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
console.log(`portableized ${changed} credential refs in ${file}`);
