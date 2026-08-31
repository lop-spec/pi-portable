// 历史索引后台扫描器(2026-08-31 循环验收 修正1):由 lop-chain 扩展 detached 拉起。
// scanHistory 内含大段同步 sqlite/解析,进程内运行会饿死宿主事件循环,把会话首轮
// 压在扫描背后(实测 2s 等待上限的定时器打不进,首轮 s3 被拖到整个扫描时长)。
// 数据根经 LOP_MEMORY_HOME 传入;并发由 scan.lock 天然互斥,busy 即静默退出。
import { pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1));
const mem = await import(pathToFileURL(path.join(HERE, "lop-memory.mjs")).href);
try {
  await mem.scanHistory({ render: false });
} catch {
  process.exit(1);
}
