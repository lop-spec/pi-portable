# 工具阶段后台压缩

唯一自动水位 `800000`；摘要沿用所捕获请求的推理档位：high→high、xhigh→xhigh、max→max。优先沿用原对话前缀读取缓存；主对话档位和最近消息保留量不变。本地不登记容量，无法承诺所有模型达到该水位。

水位只由同目录 `config.json` 的 `startTokens` 设置；agent 根下 `lop-async-compaction.json` 仍可覆盖其他选项，旧水位和首次工具字段不再生效。`/async-compact-status` 查看实际配置，`/async-compact-now` 手动启动。日志在 agent 根下 `data/lop-async-compaction.jsonl`。

## 请求层推理状态

- 原生 `openai-codex` 与历史 `codex-bridge` 的全部 Responses 请求（不分模型，lop 2026-10-30 定为全局）填入默认 `reasoning.context: current_turn`。省略或 `auto` 才填入；显式指定的 `current_turn`／`all_turns` 保留，其他协议不改。10-30 两轮实测 gpt-6.1-terra、gpt-6-sol、gpt-6-luna、gpt-6.1-sol、codex-bridge/gpt-5.6-sol 均接受，第 2 轮不再带第 1 轮推理（terra 未设时多带 426 token，设后 14）。代价：每条新用户消息会把上一轮从首个推理项起按未缓存重算一次；10-26~29 回放净省。新模型若拒收该字段，请求会直接报错，届时在此处排除。
- 不改变 `reasoning.effort`、mode、工具、消息、cache key 或原始会话记录，不删除思考条目。主请求、缓存摘要和原生摘要使用同一策略，先应用策略再捕获或校验缓存前缀。
- 该请求策略不依赖后台压缩的 `enabled` 开关；暂停后台压缩不撤销请求默认值。日志标识为 `codex-current-turn-v2-global`（v1 为四模型白名单），只记录模型、档位和状态范围，不记录请求正文。
- 完整扩展加载的工具会话使用上述全局策略。Pi-web 无工具轻聊天和受 `noExtensions` 限制的委派会话只显式加载 `compaction-only.ts`：使用同一自动水位，不扫描普通用户扩展，也不改主请求推理范围；其日志为 `reasoningContextPolicy: unchanged-main`。实际 pi-web 委派路径须另做运行验收。

## 生成与兜底

- 工具执行开始或一轮完成时，估算上下文 ≥800000 则后台启动；首次工具不绕过水位。没有可压缩历史时不发送请求；已排队消息、失效快照和中止信号仍阻止不安全应用。
- 默认 `thinkingMode: "request"`：任务启动时读取所捕获原请求的档位，锁定为本次摘要档位。没有可用请求记录时，锁定启动快照中的主档位；不因缓存失效改用 high。`providers` 的既有目标模型保留，但其中 `thinkingLevel` 不覆盖 request 模式；目标模型不支持所需档位则明确失败，不换模型、不降档。不能仅据配置声称某个网页模型支持该档位。
- `thinkingMode: "fixed"`（或旧配置省略该字段）保留历史固定档位行为，才使用 `thinkingLevel` 与 provider 档位覆盖；部署配置已显式切为 request。
- 当前工具调用、其结果和后续新增消息不进入后台快照的压缩范围，保留消息边界仍由原有上游决定。主对话在摘要生成期间继续执行。
- 摘要任务启动后，切换主对话推理档位不取消、也不重发或改档该任务；模型、会话、分支、边界、设置、容量和自定义指令的校验继续保留。`mainThinkingInvalidatesSummary: false`。
- 缓存路径不可用或返回空摘要、工具调用、失败或截断时，后台任务改用原生摘要生成器，仍使用该任务锁定的原请求档位；返回的工具调用从不执行。取消或超时不再补发请求。
- 服务端返回可识别的明确上下文超限时，不等待水位：原生逻辑压缩后最多重试一次。手动 `/compact` 和超限恢复没有可复用后台摘要时，使用相同请求档位；附加指令继续传入。摘要失败则明确报错、保留历史，不偷偷回落到主对话档位；摘要请求本身若仍超限，目前不会自动分块，不能保证恢复所有超限情况。未知容量也无法可靠检测服务端无错误的静默输入截断，或识别所有非标准超限报错。

## 缓存路径

`cachedSummary: true` 为默认值；设为 false 可只关闭缓存生成，不关闭后台压缩。

- 只接入具有可校验 HTTP 请求体的 Responses、Chat Completions 和 Anthropic Messages 协议；网页自定义协议等继续走原生摘要。
- 在内存中保留最近一次对话请求的完整消息、系统提示、工具定义和请求体。原对话和摘要都必须使用相同模型，最后响应必须成功并报告缓存读取/写入。本地 60 秒资格门槛从该响应完成时计算，不把模型生成耗时误算成响应完成后的闲置时间；请求生成 90 秒后刚返回仍可进入快路，返回后又闲置 90 秒则拒绝。模型声明的缓存寿命仍保守地从请求快照时计算；不延长真实 TTL、不改变缓存保留配置，60 秒也不是对服务端 TTL 的承诺。
- 摘要沿用原对话结构，在末尾追加“仅总结保留边界之前内容”的要求；模型因此能看到完整工具输出，而不是每条结果的前 2000 字符。原有保真要求与该要求一并追加，不改写原系统提示。
- 重新序列化后逐项比较原消息前缀及模型、系统提示、工具、推理档位、cache key 等字段。只有输出额度和缓存断点位置允许变化；不兼容时在发送前拒绝，再走原生摘要，但保留本任务锁定的档位。源消息被编辑/省略或上下文扩展改写旧内容时也拒绝。
- 保持原 session/cache key，以独立 HTTP/SSE 请求生成摘要，不占用或更新主任务的 WebSocket 连接与 continuation；不改变缓存保留时长，不添加到期前提前压缩。
- `cached-summary-result` 记录真实 usage、cacheReadRatio 和 cacheHit；前缀校验通过不等于服务端命中。日志不保存请求体、工具输出或前缀差异片段。
- Codex 实测 high→xhigh 和 high→max 不能读取原 high 缓存，但 xhigh→xhigh、max→max 可以。故摘要匹配原请求档位，而不是全局固定 high。真实 SDK + 上游测试已验证 high→high、xhigh→xhigh 的摘要均命中约 96% 缓存；工具返回前后改变主档位也不改写已经锁定的摘要档位。匹配档位只是缓存前提之一，仍需通过完整前缀校验。
- 摘要应用后仍是“摘要 + 最近消息”；旧历史对应的缓存会失效，系统提示和工具等未变前缀仍可能复用。

## 保真与生命周期

两种生成路径共用 `SUMMARY_INSTRUCTIONS`：2000–3000 output tokens 是软目标，保真优先。合并重复与已完成历史，保留目标、用户约束/否定、未决事项、必要精确标识及当前任务适用的已读规则。路径不能替代规则内容，不把摘要省略误报为读取失败或原结果截断，缺内容时只标必要补读范围。

上游单任务、快照校验、空闲应用、必要时中断和保存后 continue 的机制不变。原生生成器在长轮次拆分时可能发两次摘要请求；缓存路径通常只发一次。文件清单继续累计并写入原生 CompactionEntry，usage 随摘要保存。

`upstream/` 基于 `almogdepaz/pi-async-compaction` v0.1.8，`src/job.ts` 有一处本地补丁以绝对水位应用 ready 摘要；原始和修改后 SHA256、来源及 MIT 许可见 `upstream-integrity.json`。Pi SDK 和 CLI 均须同时应用 `patch-pi-single-watermark.mjs`；不能单独部署本扩展。

## 加载、暂停与验收

SDK 补丁和扩展必须在安全空闲部署中同时切换；普通会话新加载后，读回 `loaded.thinkingMode: request`、`summaryThinkingPolicy: request-snapshot-v1`、`cachedSummaryVersion: full-prefix-v2`、`reasoningContextPolicy: codex-current-turn-v2-global` 和水位；轻聊天应读回 `reasoningContextPolicy: unchanged-main`。并核对运行中的 SDK，才算生效。暂停前备份，再设 `enabled: false` 并 reload；完整回滚同时恢复 SDK 与扩展。既有会话和摘要保留。

设置 `PI_TEST_HOST` 为实际 SDK 包目录、`PI_ASYNC_TEST_DIR` 为本目录，用 Node 执行便携仓库以下脚本：

- `tests/async-compaction-contract.mjs`：水位、配置、快照和生命周期契约、已审查上游文件 SHA256。
- `tests/single-watermark-overflow-sdk.mjs`：离线真实 SDK 的明确溢出、手动压缩、摘要失败和主动取消。
- `tests/single-watermark-chat-sdk.mjs`：无普通扩展、无工具的真实 SDK 轻聊天入口，核对主请求档位、范围及达到水位后的压缩。
- `tests/async-compaction-sdk.mjs`：真实 SDK 的空闲应用、中断/继续、主档位变更和原生摘要双分支；包含显式 low 档历史回归，不代表部署档位。
- `tests/async-compaction-cached.mjs`：真实 SDK 与 Codex 序列化器，high/xhigh/max/low 同档缓存路径、请求结束后但摘要启动前切档、任务进行中切档、xhigh 同档原生兜底、90 秒生成后立即命中、完成后闲置超时、声明 TTL 到期、前缀拒绝、完整工具结果、错误/工具调用、无缓存和不支持档位；全程禁止网络。
- `tests/async-compaction-cached-live.mjs --live <新输出目录>`：显式启用的个人链路测试，只写合成测试会话，验证 high→high、xhigh→xhigh 的真实请求档位与 usage、工具结果末尾约束保留和日常 settings 不变。
- `tests/async-compaction-request-policy.mjs`：四个模型、五个有效档位、显式范围、其他协议和无推理请求、既有回调及压缩关闭时的请求策略；全程禁止网络。
- `tests/async-compaction-reload.mjs`：活动任务中的原生 reload，不中止当前工具或模型。

已核对 SDK 0.87.1；上游 peer 范围为 0.84.x，不以 semver 代替升级后的验收。
