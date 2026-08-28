// 加密资产层:把全部敏感资产打成单个加密块随 exe 分发,运行时毫秒级解密到数据根。
// 设计:AES-256-GCM(认证加密,篡改即失败)+ scrypt KDF(离线爆破成本)+ DPAPI 密钥缓存
//       (首启输一次口令,之后本机零输入)。解密后写入数据根,进程退出可选清除。
// 密文可公开分发:安全性 = 口令强度;GCM 认证标签保证内容未被篡改。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAGIC = Buffer.from("PIPORTA1"); // 8B 魔数+版本
const KDF = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, maxmem: 512 * 1024 * 1024 };

// ── 打包(本机,读源资产;源文件只读不改)────────────────────────────
export function packAssets(entries, password) {
  const manifest = {};
  for (const [name, srcPath] of Object.entries(entries)) {
    if (!fs.existsSync(srcPath)) continue;
    manifest[name] = fs.readFileSync(srcPath).toString("base64");
  }
  const plain = Buffer.from(JSON.stringify(manifest), "utf8");
  const salt = crypto.randomBytes(32);
  const key = crypto.scryptSync(password, salt, KDF.keyLen, KDF);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 布局:MAGIC(8) | salt(32) | iv(12) | tag(16) | ciphertext
  return { blob: Buffer.concat([MAGIC, salt, iv, tag, enc]), count: Object.keys(manifest).length, plainBytes: plain.length };
}

// ── 解密(运行时)────────────────────────────────────────────────
export function deriveKey(blob, password) {
  if (!blob.subarray(0, 8).equals(MAGIC)) throw new Error("资产块格式不识别");
  const salt = blob.subarray(8, 40);
  return crypto.scryptSync(password, salt, KDF.keyLen, KDF);
}
export function unpackWithKey(blob, key) {
  const iv = blob.subarray(40, 52);
  const tag = blob.subarray(52, 68);
  const enc = blob.subarray(68);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(enc), d.final()]); // 口令错/被篡改 → 抛错
  return JSON.parse(plain.toString("utf8"));
}
export function materialize(manifest, dataRoot, layout) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const written = [];
  for (const [name, b64] of Object.entries(manifest)) {
    const rel = layout?.[name] || name;
    const dest = path.join(dataRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(b64, "base64"));
    written.push(rel);
  }
  return written;
}

// ── DPAPI 密钥缓存(本机绑定:密钥密文只能被同一 Windows 用户解开)──────
function dpapi(mode, base64Input) {
  const script = mode === "protect"
    ? `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${base64Input}');` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`
    : `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${base64Input}');` +
      `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
}
export function cacheKey(dataRoot, key) {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "key.dpapi"), dpapi("protect", key.toString("base64")));
}
export function loadCachedKey(dataRoot) {
  const p = path.join(dataRoot, "key.dpapi");
  if (!fs.existsSync(p)) return null;
  try { return Buffer.from(dpapi("unprotect", fs.readFileSync(p, "utf8")), "base64"); } catch { return null; }
}

// ── 首启/日常统一入口 ───────────────────────────────────────────
// 返回 { source:"cached"|"password", ms, written }
export function openAssets(blobPath, dataRoot, { password, layout } = {}) {
  const blob = fs.readFileSync(blobPath);
  const t0 = Date.now();
  let key = loadCachedKey(dataRoot);
  let source = "cached";
  if (!key) {
    if (!password) throw new Error("需要口令(首次启动或密钥缓存失效)");
    key = deriveKey(blob, password);
    source = "password";
  }
  const manifest = unpackWithKey(blob, key); // 认证失败即抛错(口令错或被篡改)
  if (source === "password") cacheKey(dataRoot, key);
  const written = materialize(manifest, dataRoot, layout);
  return { source, ms: Date.now() - t0, written };
}
