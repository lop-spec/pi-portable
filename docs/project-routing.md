# 项目与对话

左侧直接展开项目和对话；新对话先进入独立收件区，收件区不登记为项目。
首轮正常回复末尾的 `<归属 项目="项目名">对话标题</归属>` 由扩展收走，回复完成后运行脚本；不新增模型调用或工具轮次。

```sh
node tools/pi-project.mjs create --project "极速浏览器"
node tools/pi-project.mjs move --session 会话ID --project "极速浏览器" --title "调整标签页长度与样式"
node tools/pi-project.mjs move --session 会话ID --project "Android" --title "恢复无线调试连接" --defer
node tools/pi-project.mjs list
```

- `--defer`：先落持久队列，等待当前回复结束再执行；不打断运行中的对话。
- `--preserve-cwd`：供自动巡检等固定工作目录使用，仅调整项目归属与会话物理位置。
- JSONL 的物理位置为 `项目根/项目名/会话/文件.jsonl`，相对项目根最多三层；SDK 的会话目录只保留一级索引联接，不另存副本。
- 移动保留 ID、历史正文、图片、子代理关系和归档状态；改名使用原生 `session_info` 节点。
- 项目重命名会改物理文件夹并更新索引、归属、工作目录与关联路径；含会话的项目不能直接删除。
- 迁移日志与原始会话头位于 agent 的 `project-migrations/`、`session-header-backups/`；不随源码同步会话数据。
