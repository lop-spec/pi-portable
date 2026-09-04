# pi-portable

Windows 上的便携 pi-web 运行面：原生 Pi AgentSession、ChatGPT Codex Responses 兼容桥、会话归档 UI，以及少量不调用模型的确定性适配。

## 当前执行链

```text
浏览器 :30141
  → piweb-ui-proxy（归档/额度 UI；agent 请求字节流透传）
  → pi-web :30140
  → Pi AgentSession
      ├─ 原生 read/bash/edit/write
      ├─ lop-pretool（确定性 Windows/Bash 防错）
      └─ lop-followup（默认关闭，仅用户显式开启）
  → codex-responses-proxy :8794
      ├─ ChatGPT 认证与 Responses 协议兼容
      ├─ 账号池/sticky/401/429 切换
      ├─ 首个有效输出前的 5xx/SSE overload fallback
      └─ 固定请求内的出口与实际执行观测
  → chatgpt.com/backend-api/codex/responses
```

普通任务没有历史注入、规则语料匹配、对抗审查、记忆写入、完成标记或会话级自动 recovery。模型正常 `stop` 后不会被后台组件重新派发。

## 组件

- `src/launcher.mjs`：隐藏启动并守护 bridge、pi-web 和 UI proxy；进程崩溃可重启，但不续跑会话。
- `src/piweb-ui-proxy.mjs`：提供会话归档/恢复、账号额度和显式切号 UI；除这些控制端点外，其余请求不解析、不缓冲、不持久化。
- `src/piweb-archive-ui.js`：会话归档和账号用量界面。归档只更新 sidecar，不删除原生 session JSONL。
- `src/bridge/codex-responses-proxy.mjs`：Responses 协议桥、账号池、出口、缓存键、首输出前有界重试和执行观测。
- `src/bridge/account-pool.mjs`：账号 sticky、冷却、刷新及手动切号。
- `src/lop-pretool.ts`：Pi 扩展壳；私有规则位于运行机 `.pi/agent/data/rules-pretool.mjs`，不随公开发行包分发。
- `src/extensions/lop-followup.ts`：用户主动选择“彻底/达标/根因/根治/计划”后才运行；手动输入、模型异常、会话恢复或达到 8 轮上限时暂停。
- `assets/bash-prelude.sh`：只定义静默 SSH helper，不裁剪工具输出。
- `packaging/windows-launcher.cpp`：云端编译的 Win32 GUI 宿主，以隐藏进程和 Job Object 管理运行树。

## 行为边界

### lop-pretool

运行机规则只保留两类：

1. Windows/Git Bash 的确定性兼容修复，例如 heredoc、PowerShell 5.1、编码、ESM 盘符导入和隐藏窗口。
2. 可机械判定的高风险边界，例如生产只读身份、危险递归删除、误 kill、配置备份和凭据落盘。

它不注入 prompt、不调用模型、不读写验收/目标状态，也不改变 retry、compaction 或 Stop。规则缺失会 fail-open 并写一行日志；自动修复失败会阻止原错误命令执行。

### 账号与过载

- 账号池保留自动 sticky、401/429 冷却和切换，也允许用户从额度面板即时切号。
- `gpt-5.6-sol` 只在首个有效输出前因明确 overload/5xx 按 `terra → luna → reserve` 有界 fallback。
- reasoning、文本或工具调用一旦开始输出，本次响应即 committed，之后不重放。
- bridge 是该 provider 的重试责任层；Pi agent-level retry 在运行配置中关闭，避免跨层乘法重试。
- 响应头和 metrics 记录 requested/upstream model、实际账号、出口和尝试数，不记录 token 或 prompt 正文。

### 可选 follow-up

`lop-followup` 默认 off，不进入普通任务链。用户从输入栏 `＋` 或 `/lop-followup` 显式开启后，它才在 `agent_settled` 发送普通用户消息；所有状态可见并写入会话。恢复旧会话时强制进入 paused，不会自行复活。

## UI 增强

launcher 只应用以下补丁：

- 历史过程折叠，但工具卡保持可见；
- 输入草稿持久化；
- 文件粘贴、回到底部和显式 follow-up 入口；
- 移除字面 `auto` 并显示实际 thinking 档位；
- 展示模型 reasoning summary；
- Q/A 对话节点。

不再应用 `hide-recovered` 或 `hide-hidden-extension-messages`，模型上下文中的控制消息不得被 UI 静默隐藏。

## 数据与隐私

- 会话原文仍由 Pi 原生 session JSONL 管理。
- 归档只写 `.pi/agent/session-archive.json`。
- UI proxy 不保存 prompt 请求副本，也没有 run/goal/recovery 状态库。
- bridge 只记录状态码、延迟、模型、账号标签、出口和重试次数。
- launcher、UI proxy、bridge 和 metrics 日志按 20 MB × 5 代自动轮转；pretool 日志按 10 MB × 3 代轮转，不需要人工清理。
- 凭据始终留在运行机数据根，公开仓库和 Release 不包含 `auth.json`、token 或加密资产段。

## 启动与发布

发行物由 GitHub Actions 生成，包含便携 Node、pi-web、launcher、bridge 和 UI 层，不在本地构建发布包。

```text
pi-portable-launcher.exe
```

默认端口：

- `8794`：Responses bridge
- `30140`：pi-web 内部端口
- `30141`：用户入口
- `30142`：UI proxy health

托盘“重启”会清理本运行面拥有的进程树后冷启；未被本运行面接管的外部 8794 不会误杀。所有本地子进程默认 hidden/no-activate。

## 本地合同

```bash
node tests/launcher-portable-node-contract.mjs
node --test tests/piweb-ui-proxy.mjs tests/hard-restart-contract.mjs
node --test tests/account-pool-contract.mjs tests/account-usage-contract.mjs
node --test tests/codex-overload-retry.mjs
node tests/bridge-5xx-retry-e2e.mjs
node tests/pi-pretool-contract.mjs
node --test tests/patch-piweb-fold-contract.mjs
node --test tests/patch-piweb-draft-persist-contract.mjs
node --test tests/patch-piweb-interactions-contract.mjs
node --test tests/patch-piweb-drop-auto-thinking-contract.mjs
node --test tests/patch-piweb-show-thinking-contract.mjs
node --test tests/patch-piweb-conversation-nodes-contract.mjs
node --test tests/pi-trust-and-proxy-contract.mjs
```

## 维护点

没有新增常驻服务。仍有两个既有维护触发条件：

1. ChatGPT Codex Responses 协议变化时更新 bridge 兼容层。
2. pi-web 版本升级时重新核对 UI 补丁锚点；任一锚点不唯一时脚本零写入退出。
