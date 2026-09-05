import assert from "node:assert/strict";
import test from "node:test";

import { PEER_OF, SITES, applyPatch, localSiteName, mapPath } from "../tools/peer-sync.mjs";

const identity = (p) => String(p).replace(/\\/g, "/");

test("主机名 → 站点：只认两台受管机，大小写无关", () => {
  assert.equal(localSiteName("YANGYONG"), "yangyong");
  assert.equal(localSiteName("DESKTOP-3EGB4LB"), "desktop-3egb4lb");
  assert.throws(() => localSiteName("other-pc"), /未知主机/u);
  assert.equal(PEER_OF.yangyong, "desktop-3egb4lb");
  assert.equal(PEER_OF["desktop-3egb4lb"], "yangyong");
});

test("三棵树映射：仓库 / agent / claude 各自映射到对端对应根（不走 realpath 的纯映射）", () => {
  const opts = { realpath: identity };
  assert.deepEqual(mapPath("C:/Users/lop/Documents/claude/pi-portable/src/bridge/x.mjs", "yangyong", opts), {
    local: "C:/Users/lop/Documents/claude/pi-portable/src/bridge/x.mjs",
    remote: "D:/Downloads/pi-protable/src/bridge/x.mjs",
    tree: "repo",
  });
  assert.equal(mapPath("C:/Users/lop/.pi/agent/extensions/lop-pretool.ts", "yangyong", opts).remote, "D:/Downloads/pi-protable/data/.pi/agent/extensions/lop-pretool.ts");
  assert.equal(mapPath("C:/Users/lop/.claude/CLAUDE.md", "yangyong", opts).remote, "C:/Users/lop/.claude/CLAUDE.md");
  // 反向（在对端执行）
  assert.equal(mapPath("D:/Downloads/pi-protable/tools/backup.mjs", "desktop-3egb4lb", opts).remote, "C:/Users/lop/Documents/claude/pi-portable/tools/backup.mjs");
  assert.equal(mapPath("D:/Downloads/pi-protable/data/.pi/agent/AGENTS.md", "desktop-3egb4lb", opts).remote, "C:/Users/lop/.pi/agent/AGENTS.md");
});

test("别名 AGENTS / CLAUDE 与反斜杠路径", () => {
  assert.equal(mapPath("AGENTS", "yangyong").remote, `${SITES["desktop-3egb4lb"].agent}/AGENTS.md`);
  assert.equal(mapPath("CLAUDE", "desktop-3egb4lb").remote, `${SITES.yangyong.claude}/CLAUDE.md`);
  assert.equal(mapPath("C:\\Users\\lop\\Documents\\claude\\pi-portable\\assets\\bash-prelude.sh", "yangyong", { realpath: identity }).remote, "D:/Downloads/pi-protable/assets/bash-prelude.sh");
});

test("所有目录可用：已知树之外按相同绝对路径同步，双向一致", () => {
  for (const site of Object.keys(SITES)) {
    for (const file of ["C:/Users/lop/Downloads/x.txt", "C:/Users/lop/AppData/Roaming/npm/system-prompt.js", "D:/其它目录/有 空格.txt"]) {
      assert.deepEqual(mapPath(file, site, { realpath: identity }), { local: file, remote: file, tree: "absolute" });
    }
  }
  const sibling = "C:/Users/lop/Documents/claude/pi-portable-other/x.txt";
  assert.equal(mapPath(sibling, "yangyong", { realpath: identity }).tree, "absolute");
});

test("patch：锚点恰好一处才改，替换文本里的 $ 不被当作替换模式", () => {
  assert.equal(applyPatch("a\nold line\nb", { old: "old line", new: "new $& $1 line" }), "a\nnew $& $1 line\nb");
  assert.throws(() => applyPatch("x\nx", { old: "x", new: "y" }), /出现 2 次/u);
  assert.throws(() => applyPatch("abc", { old: "zzz", new: "y" }), /出现 0 次/u);
});

test("patch：数组规格按顺序逐条应用，任一锚点不唯一整体失败", () => {
  assert.equal(applyPatch("a\nb\nc", [{ old: "a", new: "A" }, { old: "c", new: "C" }]), "A\nb\nC");
  assert.throws(() => applyPatch("a\nb\nb", [{ old: "a", new: "A" }, { old: "b", new: "B" }]), /出现 2 次/u);
});
