// 项目被「从列表隐藏」或「永久删除文件夹」之后左栏该怎么办。纯函数，可直接单测。

export type ProjectRemovalAction = "keep" | "switch";

/**
 * 移除的是当前项目时：
 * - 删除文件夹：目录已经不存在，一律切走（保留只会让「新建」和文件抽屉指向一个不存在的 cwd）；
 * - 隐藏：没有打开的会话才切走，有打开的会话就保留（置顶显示「已隐藏」）。
 */
export function projectRemovalAction({ removedKey, currentKey, deleted, hasOpenSession }: {
  removedKey: string | null;
  currentKey: string | null;
  deleted: boolean;
  hasOpenSession: boolean;
}): ProjectRemovalAction {
  if (!removedKey || removedKey !== currentKey) return "keep";
  if (deleted) return "switch";
  return hasOpenSession ? "keep" : "switch";
}

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

/** path 是否等于 root 或在 root 之内（Windows 盘符 / UNC 路径不区分大小写）。 */
export function pathWithinRoot(path: string, root: string): boolean {
  const a = normalize(path);
  const b = normalize(root);
  if (!a || !b) return false;
  const insensitive = /^[a-z]:/i.test(b) || b.startsWith("//");
  const x = insensitive ? a.toLowerCase() : a;
  const y = insensitive ? b.toLowerCase() : b;
  return x === y || x.startsWith(`${y}/`);
}

// 项目路径的 Windows 判定：盘符（C:）或 UNC（两个反斜杠或两个斜杠开头）。这类路径不区分大小写。
const isWindowsPath = (path: string) => /^[a-z]:/i.test(path) || /^[\\/]{2}/.test(path);

/**
 * 永久删除确认：仍是整串路径确认（目录名、父目录、前缀都不算），但 Windows 路径不区分大小写、
 * / 与 \ 等同、忽略首尾空白和末尾分隔符；POSIX 路径逐字比较（只忽略末尾分隔符）。
 */
export function projectPathConfirmed(typed: string, root: string): boolean {
  const a = normalize(typed.trim());
  const b = normalize(root.trim());
  if (!a || !b) return false;
  return isWindowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * 服务端（validateProjectDeletion）把 confirmPath 与 path.resolve(cwd) 做精确比较。确认通过后发送项目自己的 root，
 * 写成 path.resolve 会得到的原生形式（Windows：反斜杠、无重复/末尾分隔符；POSIX：无末尾分隔符），而不是用户键入的大小写变体。
 */
export function confirmPathFor(root: string): string {
  const path = root.trim();
  if (isWindowsPath(path)) {
    const unc = /^[\\/]{2}/.test(path);
    const joined = path.replace(/\//g, "\\").replace(/\\{2,}/g, "\\");
    const native = unc ? `\\${joined}` : joined;
    return native.length > 3 ? native.replace(/\\+$/, "") : native;
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

// 「从列表隐藏」时服务端的 registry 只保留小写 key，原始大小写的 root 就丢了（没有对话的项目之后只剩 key）。
// 隐藏时把原始 root 记在本机浏览器里，隐藏列表/恢复/删除都用它，而不是退回小写 key。
export const REMEMBERED_ROOTS_KEY = "pi-web:hidden-project-roots";
type RootStorage = Pick<Storage, "getItem" | "setItem">;

function defaultRootStorage(): RootStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readRememberedRoots(storage: RootStorage | null = defaultRootStorage()): Map<string, string> {
  const roots = new Map<string, string>();
  if (!storage) return roots;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(REMEMBERED_ROOTS_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, root] of Object.entries(parsed)) if (typeof root === "string" && root) roots.set(key, root);
    }
  } catch (error) {
    console.error("[pi-web projects] remembered project roots unreadable:", error);
  }
  return roots;
}

function writeRememberedRoots(roots: Map<string, string>, storage: RootStorage | null) {
  if (!storage) return;
  try { storage.setItem(REMEMBERED_ROOTS_KEY, JSON.stringify(Object.fromEntries(roots))); }
  catch (error) { console.error("[pi-web projects] could not remember project root:", error); }
}

export function rememberProjectRoot(key: string, root: string, storage: RootStorage | null = defaultRootStorage()) {
  if (!key || !root) return;
  const roots = readRememberedRoots(storage);
  if (roots.get(key) === root) return;
  roots.set(key, root);
  writeRememberedRoots(roots, storage);
}

export function forgetProjectRoot(key: string, storage: RootStorage | null = defaultRootStorage()) {
  const roots = readRememberedRoots(storage);
  if (roots.delete(key)) writeRememberedRoots(roots, storage);
}
