# pi-portable

pi-web + 规则执行链 + codex 代理桥的便携发行版工程。目标:另一台 Windows 机器拿到一个 exe,双击即用,关闭即彻底退出。

方案与循环验收契约:`decision-replay-engine/specs/piweb-release/plan.md`

GPT 全执行链、历史/规则/扩写硬门及五类性能回放：[`docs/gpt-execution-chain.md`](docs/gpt-execution-chain.md)

## 目录

- `src/bridge/` — 受版本控制的便携桥层；随生产桥同步升级，并在本仓维护 Pi user-role 历史与 exact response memo 适配。
- `src/lop-chain.ts` — 执行链扩展；包含确定性目标门，以及无 subagent 的两态验收目标循环（冻结合同、active/complete/blocked、分支持久恢复）；persistent checklist 停滞时复用换向器，过期 `nextAction` 仅从精确动作记录识别，Bash 前台 deadline 阻止跨小时 sleep 冒充进展。
- `src/browser-agent/` — 浏览器工具扩展(工具名 `browser`):Playwright-core 走 loopback CDP 驱动独立 profile 的无头 Edge/Chrome,**默认常驻**(会话结束只断连不杀进程,靠 profile/DevToolsActivePort 跨会话重连;`PI_BROWSER_RESIDENT=0` 回到会话即关),动作 open/goto/snapshot/text/eval/click/type/press/wait/screenshot/tabs;`tools/sync-cli-home.mjs` 以 junction 装进 `~/.pi/agent/extensions/browser-agent`;自检 `selftest.mjs`(0 可见窗口)/`selftest-resident.mjs`(跨进程重连+延迟)/`selftest-pi-load.mjs`(pi RPC 装载)。**备份目录不得放在 extensions 目录内,pi 会把它当第二个扩展装载并报 Tool browser conflicts。**
- `src/run-supervisor.mjs` — 会话级持久化运行监督器；在转发前保存 prompt/Abort，监听 Pi Web 运行注册表与 session JSONL，并从最后叶节点续接；同时提供不改写原生 JSONL 的会话归档/恢复代理，绝不直接重放工具调用或硬删除会话。
- `packaging/windows-launcher.cpp` — 由云 CI 编译的 Win32 GUI 宿主；以 `DETACHED_PROCESS` 和显式标准流拉起主 Node，并作为 bridge/web 子 Node 的无控制台进程宿主；同时监督重启并用 Job Object 兜底清理进程树。相同云构建还发布独立的 `windows-silent-exec-host.exe`，供交互会话中的计划任务静默启动任意精确路径程序。
- `src/egress-autodetect.mjs` — 出口自适应(直连探测 → 常见代理端口探测 → 引导输入),换机第一难题的解法。
- `src/rules-snapshot.mjs` — 规则单向生成器；bootstrap/受管源经校验后原子生成 `data/rules.jsonl`。
- `tools/deploy-rules-remote.mjs` — 主机侧 canonical-only SSH 部署器；严格主机密钥校验、变更前物理备份、远端原子生成与只读漂移检查。
- `tests/` — 可在 CI 运行的契约与隔离记忆测试。
- `benchmarks/` — 高频五类任务、历史最佳阶段值和严格 `<50%` 性能门。
- `tools/pi-five-chain-benchmark.mjs` — 两轮真实 GPT/工具/历史/规则/canonical 验收。
- `tools/pi-chain-hard-gate-probes.mjs` — 扩写、规则全集和模型历史使用的反事实验收。

## 跨机静默计划任务宿主

每个 tag Release 同时发布 `windows-silent-exec-host.exe` 与 SHA-256 sidecar。该资产不依赖 Pi 目录或内置 Node，可随管理包复制到任意 Windows 机器。调用契约：

```text
windows-silent-exec-host.exe --pi-silent-exec <working-directory> <executable> [arguments...]
```

宿主自身是 Windows GUI subsystem；目标通过精确路径、`DETACHED_PROCESS`、隐藏 startup info、NUL 标准流及 suspend → Job Object → resume 顺序启动。宿主等待并透传退出码，宿主被终止时整棵目标进程树随 Job 回收。后台模式错误只写相邻 `data/launcher-bootstrap.log`，禁止弹出抢焦点对话框。

交互登录 (`InteractiveToken`) 的计划任务不得直接登记 `node.exe`、`python.exe`、`cmd.exe`、`powershell.exe`、`pwsh.exe`、`bash.exe` 等 console-subsystem 入口；注册层必须将它们封装进上述宿主。确实需要可见交互时必须显式记录豁免理由，不能靠 Task Scheduler 的 `Hidden` 字段冒充窗口隐藏。

## 规则单一真值

规则唯一可编辑源是 `vscodium/shared/registry/data/rules-corpus.jsonl`。发行包只携带 `src/rules-snapshot.mjs`，不嵌入规则或凭据；本机由 `vscodium/tools/sync.mjs` 生成 `~/.pi/agent/data/rules.jsonl`，异机由 SSH 把同一 canonical corpus 推到 `data/registry/rules-corpus.jsonl`，再原子生成 `data/rules.jsonl`。运行链只读生成物，绝不反写上游。旧包中若仍有 `assets.enc/rules.jsonl`，启动器只把它映射为 bootstrap；已有受管源优先，因此重启不会退回旧规则。

主机侧使用唯一部署入口（默认源固定为相邻 `vscodium/shared/registry/data/rules-corpus.jsonl`；`--source` 也只接受该 canonical 目录后缀）：

```bash
node tools/deploy-rules-remote.mjs --host user@host --remote-root D:/path/to/pi-portable --identity C:/path/to/id_ed25519 --known-hosts C:/path/to/known_hosts
node tools/deploy-rules-remote.mjs --host user@host --remote-root D:/path/to/pi-portable --identity C:/path/to/id_ed25519 --known-hosts C:/path/to/known_hosts --check
```

第一条命令在联网前校验 canonical JSONL；有变化时先在异机 `data/backups/rules-deploy-<时间戳>/` 做物理备份，再通过带互斥锁的临时文件调用远端 `rules-snapshot.mjs` 原子收敛。第二条命令全程只读，核对 canonical、受管源、生成物的规则数和 SHA-256，并拒绝残留 `.incoming` 文件或部署锁；远端进程被强制终止时保留锁并故障关闭，需先调查对应 SSH/Node 进程和备份清单，确认无部署在跑后再移除该锁。

## 进度(S1-S9,全绿才允许交付)

| 步骤 | 状态 | 证据 |
|---|---|---|
| S1 脱敏基线 | ✅ | scan-secrets 0 命中(1 例外带书面理由) |
| S2 可移植化 | ✅ 6/6 | `test/s2-full.mjs`:出口自适应 4.4s → 桥 v7.8.5 就绪 → 写点全在数据根 → 真实请求 200 → 零污染本机 |
| 加密资产层 | ✅ 8/8 | `test/s2-assets-crypto.mjs`:6 项 128KB,纯解密 0.64ms,首启 867ms,源零改动,错口令/篡改被拒 |
| S3 公有仓 | ✅ | 已推 https://github.com/lop-spec/pi-portable(MIT);匿名克隆 + 全历史扫描 0 泄漏 |
| S4 云 CI | ✅ | Actions 绿 → Release `v0.0.1-rc2` 出 **82.9MB 单 exe** + SHA256;匿名下载校验 MATCH、PE 头 OK |
| S5 安装面 | ✅ 13/13 | `test/s5-real-exe.mjs`(真实 Release exe):解压完整包 → 包内 node v22.19.0 自足 → 解密 859ms → 出口自适应 → 双服务 → **真实工具回显 exe-ok** → 关闭双端口释放 → 复活零口令 |
| S6 执行链 | ✅ 9/9 | `test/s6-chain-coldstart.mjs`(空账本冷启):INJECT 生效 → S8 落账建库 → **第二遍 exact 命中(冷启→热账本闭环)** → 历史注入 630B |
| S7 代理桥 | ✅ | 含于 S2/S5/S6:出口自适应命中、/health 版本正确、真实模型请求 200 |
| S8 预演(本机) | ✅ 13/13 | `test/s8-fresh-machine-sim.mjs`(纯下载 v0.0.2-rc2 全含版,零注入):自带 938KB 加密段 → 仅输一次口令 881ms → 出口自适应 → 双服务 → **零配置直接对话+工具执行 fresh-machine-ok** → 执行链 INJECT 生效 → 关闭端口全释放 → 复活零口令 |
| 托盘 app 形态 | ✅ 17/17 + 2/2 | `test/tray-e2e.mjs`(隔离实例):启动托盘就绪 70ms → 关窗驻留(服务不断)→ 托盘进入复活窗口 → 托盘重启整套换代 → 托盘彻底退出零残留;`tests/tray-contract.mjs`:协议契约 + tray.ps1 实跑(真图标 `ICON:custom`) |
| S8 机器2 终验 | ☐ **待异机执行** | 需真实异机:下载 Release exe → 双击 → 输口令 → 同 13 项断言。本机无法代验 |
| S9 交付 | ☐ | S8 异机通过后:去 rc 正式 tag + README 补机器2 记录 |

## 使用方式(异机,2026-08-29 方案改定)

发行物只有脱敏 base.exe(代码 + runtime,零凭证);敏感资产不再嵌加密段,由主机经 SSH 私道直推异机数据根。

1. 从 [Releases](https://github.com/lop-spec/pi-portable/releases) 下载 `pi-portable-<版本>.exe`(或主机 SSH 推送解包内容)
2. 主机推资产到 `<解包目录>\data\`:`auth.json`、`.pi/agent/{models,settings,AGENTS.md,extensions/lop-chain.ts}`、`rules-pretool.mjs`、`registry/rules-corpus.jsonl`、`anchors.jsonl`、`egress-extra-ports.json`(models.json 先过 `tools/portableize-models.mjs` 便携化凭证引用)
3. 双击 exe:7z SFX 直接进入 Win32 GUI 宿主(`pi-portable-launcher.exe`)，不经过 Explorer/cmd/VBScript；宿主用无控制台进程启动 launcher，后者校验受管语料并原子生成 `data/rules.jsonl`，再自动完成出口探测 → 起桥 → 起 pi-web → 打开独立 app 窗口，同时托盘常驻 pi 图标
4. 托盘交互:**单击图标 = 进入(重开窗口)**;右键菜单 = 打开 Pi Web / 重启(整套换代重启)/ 彻底退出(整棵进程树回收零残留)。关闭窗口只驻留托盘,不再整体退出
5. 托盘不可用时自动回退旧语义:关闭窗口 = 彻底退出;`PI_TRAY=0` 可显式关闭托盘。托盘宿主是 Windows 自带 PowerShell NotifyIcon(`src/tray.ps1`,纯 ASCII 契约,中文菜单由 launcher argv 传入),图标运行时取 `@agegr/pi-web/public/icons/icon-192.png`,零新增资产
6. launcher 同时守护 Pi Web 与 `run-supervisor`;对外地址仍是 `127.0.0.1:30141`，但先进入 supervisor 的透明持久化代理，Pi Web 私有上游改为 `127.0.0.1:30140`。这样 prompt 在转发前已写入 `data/run-supervisor/state.json`，不受 Pi“首个 assistant 前不落 session JSONL”的窗口影响。Pi Web 异常退出会原位重启，健康面默认 `http://127.0.0.1:30142/health`，事件证据写入 `data/run-supervisor.log`。同一叶节点只投递一次恢复，连续三次相同失败转 `blocked`；UI Abort、显式 `/lop-goal-cancel`、`取消当前目标` 或 `停止自动续跑` 会写 durable cancel marker 并禁止恢复。
7. 输入框支持直接粘贴系统文件：图片沿用图片附件链，普通文件在浏览器无法暴露绝对路径时上传到当前会话目录并插入 `@文件` 引用（单文件 25 MB、单次 100 MB；重名自动改名，绝不覆盖），文件与文本混合粘贴会保留文本。聊天离开底部时会显示 30 px 的“回到底部”悬浮按钮，到底后自动隐藏。扩展明确标为 `display:false` 的内部消息只保留在会话/模型上下文中，不渲染任何消息框；可见扩展消息与普通消息不受影响。模型生成中的用户可见推理摘要保留并默认展开，只有已结束且内容为空的推理块会被过滤。桌面端每个非空会话始终显示对话节点侧栏：真实用户问题与 `stop` 终答分别作为 Q/A 节点，工具小轮次与恢复控制消息不计；节点压成单行，索引覆盖完整活动分支并可滚动查看、点击定位。
8. 会话列表的垃圾桶语义已整体替换为“归档”：归档只原子更新 `data/.pi/agent/session-archive.json` sidecar，原生 `sessions/**/*.jsonl` 保持原路径、原字节；顶部归档按钮可查看并恢复。旧客户端即使发出 `DELETE /api/sessions/:id` 也只会进入非破坏性归档兼容路径，不会到达 Pi Web 的硬删除 API。归档会话继续由 Pi `SessionManager` 读取并由 Pi/GPT 共用历史层检索；从归档会话继续发送消息时会先自动恢复。
9. Worktree 切换器作为项目分类使用：始终显示 main，并自动显示 Pi Web 在 `<repo>-worktrees/` 下创建或复用的分类分支（包括“历史对话”和用户从“新建 worktree”创建的分支）；Claude/Codex 等智能体在其他位置生成的临时 worktree 不显示。过滤只影响切换器，不删除分支、worktree 或其历史会话；分类由既有路径约定自动发现，无额外注册表或同步维护点。

无头验证(SSH 远程,不开窗口):`runtime\node.exe tools\remote-verify.mjs "<测试 prompt>"`——出口/桥 health/pi 全链/S6 预审日志一次回显。

历史方案(exe 内嵌 AES 加密资产段 + 首启口令)已于 2026-08-29 退役:CI 现在断言 stage 里不得出现 `assets.enc`。

## 关键实测结论

- **Windows 工具子进程静默**:启动器向 Git Bash 注入 `MSYS=enable_pcon`，原生 `python.exe` 及其后代进入 ConPTY；保持等待、退出码和输出管道，同时不新建可见控制台、不抢焦点。
- **出口是换机头号变量**:chatgpt.com 在部分网络环境**直连不可达**(TLS 超时),必须走代理。发行版不能假设直连——`egress-autodetect` 按 直连 → 常见本机代理端口 → 用户自定义端口 顺序探测,数秒内定位可用出口并持久化;全失败则由 UI 引导输入。
- 桥的本机耦合只有 4 处(日志/指标写点、egress 状态文件、代理端口默认),全部参数化后隔离实例真实出网 200。
- **Sol 容量池降级**:仅当首个有效 SSE 前收到结构化 `server_is_overloaded`，按 `gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → gpt-reserve` 有界降级；任何有效输出后绝不重发。实际模型通过响应头、日志和 metrics 留痕，fallback 结果不写入 Sol 的 exact memo。
- 端口避让:8796 是本机 codex-app-gateway,8793/8797/8798 由既有服务占用;隔离测试必须先探测空闲高位端口。

## 本地验收

```bash
node tests/rules-snapshot-contract.mjs # 唯一真值→bootstrap/受管源→生成物契约
node tests/deploy-rules-remote-contract.mjs # canonical-only SSH 下发、备份、原子生成、只读 check 契约
node tests/windows-launcher-contract.mjs # GUI 子系统→无 cmd/WSH→Node 监督与 SFX 入口契约
node --test tests/lop-chain-contract.mjs # 两态清单冻结、停滞 evidence→tabu 换路、前台 deadline、持续终态/“继续”重开、历史绕过回归、目标门优先
node --test tests/run-supervisor.mjs # session 增量索引、持久状态、去重/熔断、取消和恢复时延
node --test tests/piweb-session-archive.mjs # 非破坏归档/恢复、视图代理、Pi/GPT 历史识别
node --test tests/pi-history-contract.mjs tests/deterministic-fast-path.mjs tests/bridge-response-replay.mjs tests/codex-overload-retry.mjs
node tools/pi-five-chain-benchmark.mjs --dry-run # 高频排序、基线和门定义自检
node test/s2-full.mjs                # S2 隔离实例完整验收
node src/egress-autodetect.mjs <dir> --force   # 单测出口探测
```
