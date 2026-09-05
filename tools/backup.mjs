// 一条命令完成"精确物理备份 + 校验"：复制到就近的 _历史版本/ 目录，读回大小与 SHA256，一行一个结果。
// 用法：node backup.mjs <文件...> [--label <标签>]
//   目标：文件所在目录或其上级中最近的 _历史版本/（~/.pi/agent、仓库根都有）；都没有就在文件旁新建 _历史版本/
//   命名：<原名>.bak-<yyyymmdd-HHMMSS>[-标签]；绝不放进 extensions/（pi 会把子目录当扩展装载）
// 退出码：任一文件失败为 1。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const labelAt = args.indexOf("--label");
const label = labelAt >= 0 ? String(args[labelAt + 1] || "").replace(/[^\w.-]+/g, "-") : "";
const files = args.filter((a, i) => a !== "--label" && i !== labelAt + 1);
if (!files.length) { console.error("用法：node backup.mjs <文件...> [--label <标签>]"); process.exit(2); }

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function historyDirFor(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "_历史版本");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const local = path.join(path.dirname(file), "_历史版本");
  fs.mkdirSync(local, { recursive: true });
  return local;
}

let failed = 0;
for (const input of files) {
  const file = path.resolve(input);
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("不是文件或不存在");
    const dest = path.join(historyDirFor(file), `${path.basename(file)}.bak-${stamp}${label ? `-${label}` : ""}`);
    if (fs.existsSync(dest)) throw new Error(`目标已存在：${dest}`);
    fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    const a = sha(file), b = sha(dest);
    if (a !== b) throw new Error("读回哈希不一致");
    console.log(`OK ${file} -> ${dest} ${fs.statSync(dest).size}B sha=${a.slice(0, 12)}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${file}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
