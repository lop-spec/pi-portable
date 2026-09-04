import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_KEEP = 5;

export function appendLineRotating(file, line, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let rotated = false;
    const incomingBytes = Buffer.byteLength(String(line)) + 1;
    let currentBytes = 0;
    try { currentBytes = fs.statSync(file).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (currentBytes > 0 && currentBytes + incomingBytes > maxBytes) {
      if (keep > 0) fs.rmSync(`${file}.${keep}`, { force: true });
      for (let index = Math.max(1, keep - 1); index >= 1; index -= 1) {
        const source = `${file}.${index}`;
        const target = `${file}.${index + 1}`;
        if (fs.existsSync(source)) fs.renameSync(source, target);
      }
      const first = `${file}.1`;
      if (fs.existsSync(first)) fs.rmSync(first, { force: true });
      fs.renameSync(file, first);
      rotated = true;
    }
    fs.appendFileSync(file, `${line}\n`, "utf8");
    return { ok: true, rotated };
  } catch (error) {
    return { ok: false, rotated: false, error: String(error?.message || error) };
  }
}
