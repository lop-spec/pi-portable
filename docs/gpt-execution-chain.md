# GPT 全执行链与硬验收

## 目标与边界

Pi Portable 对每个真实用户回合执行同一条链。历史、规则和个性化扩写不是“注入即算完成”，而是分别保留候选来源、集合 oracle、模型使用处置和反事实证据。性能门只约束历史基线中超过 `1000 ms` 的阶段，且从当前验证的第二轮开始要求严格小于历史最佳值的 `50%`；等于也失败。

不得用下列方式换速度：降低答案准确性、删除必要工具证据、缩短 `summary20/full` 语义、减少规则集合或跳过 canonical 落账。确定性窄动作快路是在同一 pretool 安全门后直接取得当前证据，不是模拟工具结果。

## 当前执行路径

1. **S0 启动与上下文**
   - `src/launcher.mjs` 只使用包内 Node，并以 hidden/no-activate 方式启动本地进程。
   - `src/lop-chain.ts` 在 `context` 事件删除旧回合的 `lop-*` custom message，防止历史规则跨回合累积。
2. **S1 输入归一化**
   - 保留真实用户 prompt；system envelope、旧启动注入和控制文本不能进入历史候选。
3. **S2 个性化联想扩写**
   - 读取 `anchors.jsonl` 的实体、`what` 关系与用户画像，再加入受控语义别名。
   - `forHistory` 的 Unicode 字符数必须达到原问题的 `3×`；`forRules` 不加入画像底座，避免规则过召回。
   - 指标记录 `charRatio`、规则术语、个性化术语以及 S3/S4 的新增命中。
4. **S3 历史扫描、召回与使用门**
   - 扩展装载时立即增量扫描 Codex、Claude 和 Pi v3 JSONL；Pi 默认根为 `PI_PORTABLE_DATA/.pi/agent/sessions`。
   - Pi parser 只把 `stopReason=stop` 的最终 assistant message 记作完成态；工具中间消息不冒充最终答案。
   - 每个完成态确定性生成 canonical `summary20 + semanticFull`，无需模型输出隐藏 marker；任务仍待用户动作时 outcome 为 `待处理`，不进入完成态关联候选。
   - 候选入口用 OR 语义检索；交付前再检查任务类型、对象覆盖、summary 覆盖、全文覆盖、相关度 `>=0.82` 和领先差值。上下文型追问继承同一 session 的自包含根任务。
   - 基础 query miss 后，扩写只扩大候选；评分仍以原问题和可归因别名为准。
   - 命中后模型必须在最终可见结论引用相关事实，并唯一附加 `history-used` 或 `history-conflict`。缺失时最多定向修正两次；仍失败则禁止 canonical 写入。
5. **S4 按需规则与全集 oracle**
   - 实际集合为原 prompt 与 `forRules` 的匹配并集，排除 always-on 规则。
   - 独立 oracle 逐条执行完整语料的 trigger；实际 ID 集合与 oracle 必须完全相等，不允许截断前 16 条。
6. **S5 确定性高频快路**
   - 只识别 cwd 内受限路径的四类窄动作：Node 语法检查、唯一字面替换并读回、文件 stat、显式 `node <file> --check`；另有经固定真值验证的 JSON/JSONL 极短解释草稿。
   - 所有工具型快路先经过 S7 同一个 pretool 检查；子进程使用 direct argv、timeout 和 `windowsHide`，修改失败时整体回滚。
   - 当前证据在首个模型请求前注入，模型无需为一个确定动作反复“决定—调用—总结”。
7. **模型执行、S6 对抗预审与两态目标循环**
   - 非确定性任务仍由 GPT 规划和调用工具。
   - 后台对抗预审只检查开工前的 scope/cheaper/evidence；它不读取最终产物，也不冒充完工验收器。S5 已取得当前证据时，审查任务被确认并主动取消，避免无价值的第二次模型调用和悬挂连接。
   - 执行任务首份 `【验收清单】` 冻结为分支持久合同；只接受 `[ ]` 与 `[x]`。解析范围严格限于标题后紧邻的连续清单块，后文代码示例和普通列表不参与判定。第三状态、漏清单、删项、改名和缩减都保持 `active` 并自动 follow-up，不再有固定两轮后的静默放行。
   - 同一外部阻塞与同一未完成集合连续出现三轮才转 `blocked`；用户发送上下文型“继续”可恢复 `active`。全部冻结项目均 `[x]` 才转 `complete`。状态以 `lop-checklist-goal-state` custom entry 写入当前分支，恢复/分叉后按分支重建。
   - 扩展内嵌 `LOP_CHAIN_RUNTIME_VERSION`。活动文件被覆盖后，旧 runner 在下一次真实用户轮检测版本漂移并排队 `/lop-chain-reload`；旧门因已有 pending message 不再追加过期 follow-up。
   - 显式 `【目标门】` 命令仍拥有最高完成优先级；宿主已确定验证的 deterministic fast path 可直接置 `complete`。目标循环不安装或调用 subagent。
8. **S7 工具门**
   - 每个普通工具调用通过 `rules-pretool.mjs`；可确定修正则最多自动修正一次，阻断则返回结构化错误。
9. **S8 确定性落账**
   - 去除处置凭证和旧 marker 后调用 `recordStop()`；canonical 写入必须返回 `saved=true, derived=true`，否则本回合硬失败。
   - `semanticFull` 最多 2000 字符，长答案保留开头和结论尾部；`summary20` 最多 20 字符。
10. **S9 指标与严格回放**
    - 记录 S2/S3/S4/S5/S6/S8、首轮模型、后续模型、工具、TTFB 和端到端耗时。
    - exact 历史请求可使用严格全语义 response memo；Pi 的历史 custom message 是 user role，缓存键会归一化 8–16 位 usage token，但不会模糊匹配不同事实。

## 五类任务与性能门

频率排序与历史最佳来自共享单一真值：

1. 排查修复
2. 实现改动
3. 解释建议
4. 查询审计
5. 运行运维

可执行入口：

```powershell
node tools/pi-five-chain-benchmark.mjs `
  --portable-home D:\Downloads\pi-protable `
  --data D:\Downloads\pi-protable\data `
  --workspace D:\Downloads\codex-lite\workspace\code-lite-src\code-lite\config `
  --cycles 2 --thinking max `
  --bridge-port 18833 --upstream-proxy-port 18799 `
  --output D:\Downloads\pi-protable\data\validation\pi-five-chain
```

`benchmarks/gpt-five-task-baseline.json` 固化任务、排序、历史阶段值和人工核对后的预期规则 ID。第一轮是当前链校准/缓存预热；第二轮开始执行严格 `<50%` 门。

额外硬门与反事实：

```powershell
node tools/pi-chain-hard-gate-probes.mjs `
  --portable-home D:\Downloads\pi-protable `
  --data D:\Downloads\pi-protable\data `
  --workspace D:\Downloads\codex-lite\workspace\code-lite-src\code-lite\config `
  --output D:\Downloads\pi-protable\data\validation\pi-hard-gates
```

该入口必须同时证明：

- 无扩写时历史 miss，扩写后命中相关 `summary20/full`；
- 规则扩写带来正确新增项，实际集合与全语料 oracle 完全一致；
- 随机口令未写盘时无历史模型回答“无法得知”，写入历史后模型准确输出口令并通过 `history-used` 门。

## 2026-08-30 最终实测

最终双循环报告：`data/validation/20260830-031931-pi-five-chain-v793-history-fix/report.json`。第二轮所有受门控阶段均严格低于历史最佳的 50%：

| 排名/类型 | 初始模型：历史 → 50%门 → 当前 | 后续模型：历史 → 50%门 → 当前 |
|---|---:|---:|
| 1 排查修复 | 12086 → `<6043` → **23.2 ms** | 6712 → `<3356` → **0 ms** |
| 2 实现改动 | 33720 → `<16860` → **22.3 ms** | 7240 → `<3620` → **0 ms** |
| 3 解释建议 | 4397 → `<2198.5` → **23.8 ms** | 历史为 0，不设性能门 |
| 4 查询审计 | 7351 → `<3675.5` → **22.8 ms** | 4994 → `<2497` → **0 ms** |
| 5 运行运维 | 13075 → `<6537.5` → **23.4 ms** | 3106 → `<1553` → **0 ms** |

五类两轮均通过答案、工具/读回、S2 3×、S3 使用、S4 集合、S8 derived canonical 和工作区窄范围门。热 Pi 历史扫描由全量迁移的 `3210.8 ms` 降为线性追加 `94.7 ms`，无变化复扫为 `6.3 ms`。反事实报告 `data/validation/20260830-032002-pi-hard-gate-probes-v793-history-fix/report.json` 三门全绿。

历史引用回答不会再递归成为事实源：`请只根据相关历史结论回答` 与带连接结构的 `请只根据相关历史事实与结论回答` 即使已有错误 exact 回答，仍跳过 wrapper 并命中原始成功事件 `e_live_d7538c9cc3e831c732f200df`，`relevance=1`；错误事件不删除，继续保留审计。v7.9.3（`reasoning=max`）真实模型报告位于 `data/validation/20260830-031818-live-v793-recursion-fix2/`，答案引用两个方向的实测事实、唯一带 token 的 `history-used`、S4 actual=oracle、S8 canonical、零 follow-up 均通过；SSH/TLS 协议解释反例继续 miss。

## 回滚

代码由 Git 提供逐文件回滚；部署前还必须在 `PI_PORTABLE_DATA/backups/<timestamp>-gpt-chain-hard-gates/` 保存 live 核心、扩展、配置和 SQLite。若新扫描器或召回门异常，恢复 `src/chain/lop-memory.mjs`、`memory-canonical.mjs`、`src/lop-chain.ts` 与对应 live 扩展，然后读回哈希并启动新会话验证。不得删除原历史 JSONL。
