# pi-web 界面合并（2026-11-08）
把 GitHub 上最好看的几个 harness 的优点合并进 pi-web，保留现有设计体系（token、8px 圆角上限、低噪声），哪里缺就补。
全部是叠加层最后一步 `tools/patch-piweb-merge.mjs` + `assets/piweb-overlay/merge/`，不改上游与既有叠加步骤的文件本体。

## 合并了什么
| 来源 | 落到 pi-web | 位置 |
|---|---|---|
| cc-haha 多任务标签 | 顶栏下的会话标签栏：运行中转圈、后台新回复小圆点、关闭不停会话、列表保存在浏览器 | `components/SessionTabs.tsx` |
| agent-orchestrator 状态看板 | 「看板」标签：运行中 / 待你处理 / 待办 / 积压 / 完成，拖卡片即改工作流状态，已取消可显示 | `components/SessionBoard.tsx`、`lib/portable-session-board.mjs` |
| Kun 欢迎页 | 空白新会话页输入框下的「继续任务」三张卡 | `components/WelcomeResume.tsx` |
| cc-haha 过程摘要 | 折叠行「6 个步骤 · 编辑 2 · 命令 1 · 读取 1 · 用时 26 秒」 | `lib/portable-timeline-summary.mjs` |
| cc-haha 奶油暖色 | 新主题「纸白」（暖白底、陶土强调色），设置页每个主题带色块 | `app/merge.css` |
| — 修缮 | 中文加粗 `**说明：**后文` 不再显示字面星号；状态色回到 token；状态列表去硬分割线；设置页「会话归档」开关对齐 | `lib/portable-cjk-emphasis.mjs`、`app/merge.css` |

## 取舍
- 看板栏位按「现在谁需要关注」分：未手动指定状态的会话有新回复就进「待你处理」；手动拖过的以状态为准，不被未读拽回。
- 三个视图共用 `lib/portable-session-store.ts` 的快照，AppShell 只发布数据；打开 / 新建会话走 `window` 事件，不给 memo 的 ChatWindow 加会变的 props。
- 看板盖在对话区上，下面的对话保持挂载（流式输出与滚动位置不丢），打开期间对话区 `inert`，Esc 关闭。
- 没有动 ChatInput / useAgentSession 等大文件的逻辑；新增能力只用既有 token 与 `.pw-*` 原语，动效只用 transform / opacity，支持 `prefers-reduced-motion`。

## 验证
- 单测 `tests/piweb-merge.mjs`（纯函数）与合同 `tests/patch-piweb-merge-contract.mjs`（接在固定上游上、锚点漂移零写入、样式只用 token）。
- 本地复刻 CI：叠加 → 合同测试 → `tsc --noEmit` → `next build --webpack`；隔离开发实例上做了标签 / 看板拖放 / 欢迎页的交互验收与多主题截图。

## 回滚
还原 `tools/patch-piweb-source.mjs` 里 `integrateMerge` 一行（及 import）即整体撤回；或部署上一版 release（`_deploy` 保留回滚指针）。
