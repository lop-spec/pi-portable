// 项目显示名与短路径（方向 A spec §2.2，审计 D01）。纯函数，不做任何文件系统判断。

export function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/u).filter(Boolean);
}

/** 主标签：registry 里的名字，否则路径最后一段。 */
export function projectLabel(project: { name?: string | null; root: string }): string {
  const named = project.name?.trim();
  if (named) return named;
  const segments = pathSegments(project.root);
  return segments[segments.length - 1] ?? project.root;
}

/** 头像方块里的单字：取首个字符，拉丁字母大写。 */
export function projectInitial(label: string): string {
  const first = Array.from(label.trim())[0] ?? "?";
  return first.toLocaleUpperCase();
}

function stripDrive(segments: string[]): string[] {
  return segments.length > 0 && /^[a-zA-Z]:$/u.test(segments[0]) ? segments.slice(1) : segments;
}

/**
 * 短路径：去掉盘符；当前用户主目录换成 ~；其他用户目录去掉 Users 只留用户名；
 * 分隔符写成 " / "；超过 4 段时折叠中间段（保留前 2 段和后 2 段）。
 */
export function shortProjectPath(root: string, homeDir?: string | null): string {
  let segments = stripDrive(pathSegments(root));
  const home = homeDir ? stripDrive(pathSegments(homeDir)) : [];
  const sameSegment = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (home.length > 0 && segments.length >= home.length && home.every((part, index) => sameSegment(part, segments[index]))) {
    segments = ["~", ...segments.slice(home.length)];
  } else if (segments.length >= 2 && /^(users|home)$/iu.test(segments[0])) {
    segments = segments.slice(1);
  }
  if (segments.length === 0) return root;
  if (segments.length > 4) segments = [segments[0], segments[1], "…", segments[segments.length - 2], segments[segments.length - 1]];
  return segments.join(" / ");
}
