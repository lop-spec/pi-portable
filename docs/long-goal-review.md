# 本机长目标双巡检

用户明确授权的专用计划任务；不改变普通对话的执行链路，不打开新执行对话，也不启用旧达标模式。

| 任务 | 周期 | 巡检模型 | 路线窗口 |
|---|---:|---|---:|
| `PiWeb-LongGoals-Astra-30min` | 整点、半点 | 本机 Pi / `gpt-6-astra` / low | 6小时 |
| `PiWeb-LongGoals-Fable-30min` | 每小时15分、45分 | YANGYONG Claude / `claude-fable-5-1` / high；额度耗尽时 `claude-opus-5` / xhigh | 4小时 |

正常模式每15分钟轮流触发一次，两模型各30分钟一次；按目标来源机器的时钟调度。Claude 暂不可用时可用安装器 `-Enable -PiOnly` 切回 Pi 每15分钟、Claude 禁用；不是宣称已实现自动故障切换。

时间窗口用于选路线，不是达标承诺。旧 `PiWeb-QuotaIdle-30min` 禁用并保留，不再按额度临重置、全局空闲或近期P0/P1派发新执行对话。

## 单一来源与传输

- DESKTOP-3EGB4LB：`D:/Downloads/pi-protable/data/长目标清单.md`。
- YANGYONG：`C:/Users/lop/AppData/Local/pi-web/portable/data/长目标清单.md`。
- 每轮先读本机清单：空文件、仅清单标题、明确的空清单，或全文既没有数字也没有“目标”两个字时，直接记录原因并跳过，不查会话、不调用模型、不发送消息。有数字或“目标”任一项即可通过新增检查；数字包括半角、全角等十进制数字。通过后仍由模型理解自然语言，不需标识、字段或固定标题。
- 两端仅同步实现、测试、提示词模板和任务安装器。清单独立维护；凭据与原始会话文件不复制。全局规则各自只加本机清单位置。
- Astra 使用本机 Pi 原生 CLI 巡检会话，首次承接已有专用会话，随后以 `--session` 固定原文件，不再随“最近会话”漂移；仅在该进程显式加载现有 Codex 认证扩展与 `goal_inspect` 只读分页工具，不向普通会话安装扩展。完整摘要和最近记录分开分页，避免内置 read 截断超长 JSONL 单行。
- Fable 使用对端现有官方 Claude CLI 和既有认证，自动比较桥配置入口与 Desktop 已安装版本，选择最新入口；首选指定 Fable 5.1，只有额度耗尽才按授权切到指定 Opus 5。通过现有 SSH 执行，原生持久化巡检对话；每台来源机器独立工作目录和固定会话 ID，首次创建后始终 `--resume <id>`，不 fork、不每轮新建，只开放 `goal_inspect` MCP 只读工具。需要本机历史/产物时，经反向 SSH 按需读取，最终结果回传来源机器。双方均不传输认证文件。

## Claude 额度切换

- 每轮先用 **Fable 5.1 high**。原生 CLI 明确报告额度耗尽（订阅额度 rejected 或明确用量/余额耗尽错误）后，等原 CLI 退出，在**同一固定会话**以 **`claude-opus-5` / xhigh** 重试一次；路线窗口仍为4小时。
- 只解析原生错误和 `rate_limit_event`，不把模型正文中提到的额度、临近额度的警告、普通429节流、529过载、认证/网络/上下文错误当成切换理由。不使用覆盖范围更宽的 `--fallback-model`，不改账户、充值或提升限额。
- 两次尝试共用原35分钟预算和来源锁；Opus也失败就记录失败，不无限重试或另建会话。下一轮仍先尝试Fable，额度恢复即回归，无额外持久化切换状态。
- 切换原因、原生证据、实际型号/强度/会话ID进入来源日志，结果保存 `fallback`。发给原执行对话的建议标明实际巡检型号，不把Opus标成Fable；执行模型仍按原规则使用Astra xhigh。
- 共享账户/订阅额度耗尽时Opus也可能不可用；切换不保证恢复额度。指定`--effort xhigh`并在该进程开启thinking，不改全局配置。型号以原生 assistant 返回值核验。
- 官方依据：[模型与强度](https://code.claude.com/docs/en/model-config)、[额度与其他错误的区别](https://code.claude.com/docs/en/errors)。当前对端原生目录已确认`claude-opus-5`支持`xhigh`。

## 投递规则

模型读取真实历史、项目报告与运行证据后，对各目标给出 done / observe / steer / resume / blocked。

巡检提示词与发给原执行对话的建议共用一条合并后的指导，不再叠加旧句：**在请求人工介入前，先检查是否因自身核查不够全面而误判为必须人工，补齐必要检查，并寻找现有授权范围内可自行完成的更好方案；能自行处理就直接执行。只有确实必须人工操作或授权时才请求介入，并说明已核实的原因。** 必要的人工授权和安全边界不因此取消。

- 巡检优先判断当前办法是否值得继续、哪个假设已被否定、是否有更便宜的替代办法及最小区分性验证。不要求每轮改向，也不以新报告、重复收尾或测试数量代替解题。
- 达标用done；方向合理的运行、等待数据/资源事件、无新证据或可执行下一步均用observe；暂停、取消、待授权或无法确认原会话用blocked。以上均只记录原因，不发消息。**未达标＋已停止不再自动触发resume。**
- 只有存在干预价值才发送，决策中用intervention表明new-evidence（改变判断的新证据或等待事件发生）、new-route（有依据且区别于已有方案的新路线）、unfinished-action（确实中断且有未完成的授权内动作）。reason说明具体差异，advice给下一步与验证。none或缺失依据时网关不访问执行会话、不切模型、不投递，并记录no-actionable-intervention；模型输出缺失/非法依据还会被解析器拒绝。
- 运行中按上述条件发送原生steer，不强停或切模型；空闲且无相关后台任务才在原对话选Astra xhigh、核对模型与强度后prompt。原有暂停、新用户、后台执行、队列及投递并发保护不变。
- session(section=recent)附上原会话最近3条巡检建议recentAdvice，用于与当前方案、执行方纠正比较；更早历史按需读users。直接复用原生历史，不另建账本或增加模型调用。语义增量仍由原巡检模型判断，不宣称全文哈希已经能自动判定方案等价。
- 发出的消息明确写明不是用户新增指令或授权，原任务可以拒绝已处理、前提错误或越界的建议；没有可推进事项可以正常结束。不得因巡检消息改动生产权限、取消暂停或降低原验收。
- 两类巡检共享投递锁、发送前记录、建议去重和原生读回。出现新用户指令、清单修改、同目标/分叉对话运行、相关后台进程、已有排队输入时暂缓投递并记录原因。共用 cwd 不等于同项目；既有无关 SMS/服务进程不阻断目标，新出现的未分类项目进程会暂缓到下一轮重新判定。
- HTTP结果不确定时不盲目重发；下次读取原对话确认。原生 API 明确返回 accepted=false 的拒绝可在后续轮次安全重试。无法确认的发送保留 uncertain，日志会持续说明，不假装已经成功。
- 原生 API 没有跨命令事务；模型选择与 prompt 之间会多次复查运行态，尽量避免与用户同时操作冲突。不要把此检查描述为对所有用户并发操作的原子保证。

## 只读技术取证

read/list的授权根及凭据拒绝规则不变。search支持项目源码、JSON/JSONL及原有文档日志的字面搜索，返回文件、行号和上下文摘录；完整长行用read分页读取。递归搜索不进入凭据路径、符号链接/junction、依赖或生成目录，每个候选文件仍验证授权根。结果包含跳过分类计数、分页next及明确的预算原因；预算耗尽不等同于“没有匹配”。以具体项目/文件路径定向搜索，不默认全盘扫描。不开放任意命令或生产写入。

## 运行、验证与日志

由隐藏 VBS 启动 Node；所有自建子进程 windowsHide，不激活窗口。任务同实例 IgnoreNew，并另有进程锁。每轮有进展日志；35分钟仍未结束的巡检不作为成功使用，原执行任务不受影响。

在各机代码根运行：

```text
node src/goal-review.mjs --profile astra --dry-run
node src/goal-review.mjs --profile fable --dry-run
node src/goal-review.mjs --profile astra --review-only
node src/goal-review.mjs --profile fable --review-only
node --test tests/goal-review-contract.mjs tests/goal-review-session-contract.mjs tests/goal-review-schedule-contract.mjs tests/goal-claude-fallback-contract.mjs
```

`--dry-run` 不调用模型、不向原对话发送消息；`--review-only` 调用指定巡检模型但不投递建议。实现文件由下一次计划任务启动的新进程加载；不为生效强停正在运行的巡检或执行会话。

回归覆盖等待采集/无新增来源/已有方案的零动作决策不投递、新路线与中断动作仍可投递、消息不产生新授权、源码与结构化产物可搜索、凭据及junction逃逸被拒绝和搜索分页完整性。测试证明网关及工具合同，不等于已证明模型未来每次都正确判断语义增量；长期收益须以自然巡检实际采纳和执行结果评价，accepted/readback只代表送达。

任务安装器：`tools/install-goal-review-tasks.ps1`。默认备份任务XML、安装禁用的新任务并停用旧任务；`-Enable` 启用交替巡检；`-Enable -PiOnly` 切为仅 Pi 每15分钟，停用 Claude；`-InspectOnly` 自动识别当前启用模式，只读核对周期、时刻、启用状态与旧任务停用。不强停正在进行的巡检。安装采用当前登录用户 Interactive principal，需要用户登录且 Pi Web 本机服务可达；网络/服务不可用时明确失败，下轮重试，不改用其他服务。

各机数据根 `goal-review/`：

- `scheduler.log`：运行、进度、跳过/失败、投递读回；5MiB轮转，保留3份。
- `astra-latest-prompt.txt` / `fable-latest-prompt.txt`：最近实际巡检输入。
- `astra-latest-result.json` / `fable-latest-result.json`：最近巡检结论及来源状态边界。
- `deliveries.json`：仅用于防重发的本机投递记录，不是目标完成账本。
- `astra-cli/review-session.json`：本机 Astra 巡检固定会话身份；既有原生历史保留。
- 对端 `fable/<来源机器>/review-session.json`：各来源的 Fable 巡检固定身份；原生 Claude 历史留在对端既有认证配置的会话目录，不复制到来源机器。

### 在对端查找 Claude 巡检对话

它是后台 Claude Code CLI 会话，不是 Chat 页的普通项目聊天。对端 Claude **Code 页输入 `/resume`**，搜索 `长目标巡检 · Fable 5.1 / Opus 5 · desktop-3egb4lb` 或目录 `goal-review/fable/desktop-3egb4lb`，可预览原会话。官方入口说明：<https://code.claude.com/docs/en/desktop>。查看时优先预览，不在定时巡检运行期间另外接管或并发发送消息。

本机目标对应的固定 Claude 会话 ID：`865bb0ef-40e5-478d-9926-5404f03b2c79`。实际原生文件在对端 `C:/Users/lop/.claude/projects/C--Users-lop-AppData-Local-pi-web-portable-data-goal-review-fable-desktop-3egb4lb/865bb0ef-40e5-478d-9926-5404f03b2c79.jsonl`。后续查询以来源目录下 `review-session.json` 为准，不复制原始会话。首轮正式持久化巡检已在来源机时间 2026-09-16 00:56 完成：4项结论、3条 steer 投递读回成功、1项正常运行不干扰。

每轮结果及日志包含实际 `reviewSession`。压缩仍交给原生 CLI；身份不符或固定会话丢失时报错，不自动另建对话。

回滚：先禁用两项新任务，保留日志与状态；若需要恢复旧任务，先从本机备份恢复旧格式清单，再导入本机旧任务XML。不要直接启用两个调度体系，也不要用一台机器的清单覆盖另一台。
