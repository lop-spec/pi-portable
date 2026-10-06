import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  assert.match(
    source,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/,
  );
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  assert.match(
    source,
    /const disabled = !selectedSession \|\| selectedSession\.transient \|\| !hasMessages/,
  );
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  const hydrate = source.slice(
    source.indexOf("  const hydrateSelectedSession = useCallback"),
    source.indexOf("  const handleOpenSession = useCallback"),
  );
  const agentEnd = source.slice(
    source.indexOf("  const handleAgentEnd = useCallback"),
    source.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  // 新建/分支：从侧栏已有目录里取服务端记录，不再单独拉整份 /api/sessions（P15）
  assert.match(hydrate, /sessionCatalogRef\.current\.find\(\(s\) => s\.id === sessionId\)/);
  assert.match(hydrate, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.doesNotMatch(hydrate, /fetch\(/);
  // 轮次结束：服务端 agent_end 已让列表失效，侧栏轮询拉到新列表后由 handleSessionsChange 合并当前会话行
  assert.doesNotMatch(agentEnd, /setRefreshKey|hydrateSelectedSession/);
  assert.match(source, /sessionCatalogRef\.current = sessions;/);
  assert.match(source, /return refreshed \? mergeCatalogRow\(current, refreshed\) : current;/);
});
