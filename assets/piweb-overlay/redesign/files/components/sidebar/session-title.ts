// 未命名会话的显示标题（审计 D13）：首条消息常以报错、路径、URL、@文件引用开头，
// 直接截取会把真正的意图挤到省略号后面。这里只做显示层的整理，不写回会话名。

const CJK = /[㐀-鿿豈-﫿]/u;
const URL_RE = /^https?:\/\/[^\s]+/iu;
const AT_REF_RE = /^@("[^"]+"|[^\s]+)/u;
const WIN_PATH_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)[^\s]*/u;
const POSIX_PATH_RE = /^(?:~|\.{1,2})?\/[^\s]*\/[^\s]*/u;
const ERROR_LINE_RE = /^(?:error|错误|exception|traceback|warning)\b[:：]?/iu;

function lastSegment(path: string): string {
  const parts = path.replace(/^["']|["']$/gu, "").split(/[\\/]+/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(0, dot) : name;
}

function urlLabel(raw: string): string {
  try {
    const url = new URL(raw.replace(/[),.;，。]+$/u, ""));
    const tail = url.pathname.split("/").filter(Boolean).pop();
    return tail ? `${url.host}/${decodeURIComponent(tail)}` : url.host;
  } catch {
    return raw;
  }
}

/** 把一行开头的引用（@文件、URL、路径）缩成末级名称，保留后面的正文。 */
function shortenLeadingRefs(line: string): string {
  let rest = line.trim();
  const labels: string[] = [];
  for (let guard = 0; guard < 4 && rest; guard += 1) {
    const at = rest.match(AT_REF_RE);
    if (at) { labels.push(stripExtension(lastSegment(at[1]))); rest = rest.slice(at[0].length).trimStart(); continue; }
    const url = rest.match(URL_RE);
    if (url) { labels.push(urlLabel(url[0])); rest = rest.slice(url[0].length).trimStart(); continue; }
    const win = rest.match(WIN_PATH_RE) ?? rest.match(POSIX_PATH_RE);
    if (win) { labels.push(lastSegment(win[0])); rest = rest.slice(win[0].length).trimStart(); continue; }
    break;
  }
  return [labels.join(" "), rest].filter(Boolean).join(" ").trim();
}

function firstSentence(text: string): string {
  const match = text.match(/^(.{6,}?[。！？!?])(?:\s|$)/u);
  return match ? match[1] : text;
}

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  return ERROR_LINE_RE.test(trimmed)
    || URL_RE.test(trimmed)
    || WIN_PATH_RE.test(trimmed)
    || POSIX_PATH_RE.test(trimmed)
    || /^[`{[<]/u.test(trimmed);
}

/**
 * 推导会话标题：有名字用名字；否则从首条消息取一行有意义的文字。
 * 规则：优先第一行「不是报错/路径/URL/代码」且含中文的行；开头的 @引用、URL、路径缩成末级名称；
 * 只取第一句；压缩空白；最长 80 字。
 */
export function deriveSessionTitle(name: string | undefined, firstMessage: string, id: string): string {
  const named = name?.trim();
  if (named) return named;
  const lines = firstMessage.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return id.slice(0, 12);
  const preferred = lines.find((line) => !isNoiseLine(line) && CJK.test(line))
    ?? lines.find((line) => !isNoiseLine(line))
    ?? lines[0];
  let title = shortenLeadingRefs(preferred);
  if (ERROR_LINE_RE.test(title) && title.replace(ERROR_LINE_RE, "").trim()) title = title.replace(ERROR_LINE_RE, "").trim();
  title = firstSentence(title).replace(/\s+/gu, " ").trim();
  if (!title) title = lines[0].replace(/\s+/gu, " ").trim();
  return title.length > 80 ? `${title.slice(0, 80)}…` : title || id.slice(0, 12);
}
