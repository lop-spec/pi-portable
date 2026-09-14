# 工具阶段后台压缩

复用 `almogdepaz/pi-async-compaction` v0.1.8。`upstream/` 为未经修改的源码及 MIT 许可，精确来源、npm 完整性和逐文件 SHA256 在 `upstream-integrity.json`。

配置唯一入口：同目录 `config.json`。`128000` 按十进制 token 计，不修改 Pi 的 `compaction` 设置。

- 每个会话首次工具阶段不受 128K 下限限制；没有可压缩旧历史时记录原因并保持待触发，不发送空请求。
- 首次后台任务真正启动后写一条会话自定义记录，重载不重复触发。失败及取消也算本次首次尝试。
- 此后仅在工具执行开始、上下文 ≥128000 且未超过 Pi 原生压缩水位时启动。Pi 原生兜底不变。
- 只处理当前工具调用消息之前的完整历史，当前调用、结果及之后新增消息留在上下文中。
- 使用当时主模型，摘要请求固定 `low`；不支持 low 则失败并记录，不换模型或档位。主对话推理设置不变。
- 仅切换主对话推理档位，不再取消正在生成或已就绪的固定 low 摘要，也不重发摘要请求。适配层只对齐上游用于校验的主档位元数据；模型、会话、分支边界、设置、容量及自定义指令校验仍由原样上游执行。保留/对齐原因无条件写入日志，状态显示 `mainThinkingInvalidatesSummary: false`。
- 上游负责单任务、就绪校验、空闲应用、必要时中断及保存后 `continue`。未及时得到有效摘要时，由 Pi 原生压缩兜底并记原因。
- 上游原生长轮次压缩可能拆成两次摘要请求；这里的“一个后台任务”不等于永远只有一个 API 请求。

`/async-compact-status` 查看配置及状态，`/async-compact-now` 手动触发。日志在 agent 目录的 `data/lop-async-compaction.jsonl`。

安装方式为 Pi 原生 `extensions/*/index.ts` 自动发现，无需修改全局 packages 或 settings。新会话自动加载；已有会话使用原生 reload 加载，不需要重启 Pi。

暂停：备份后将 `enabled` 改为 `false`，对会话执行原生 reload。完整回滚可将本目录移到 agent 的 `_历史版本` 后 reload；会话和既有压缩摘要保留，Pi 原生压缩仍可使用。

验收入口：便携仓库 `tests/async-compaction-contract.mjs`、`tests/async-compaction-sdk.mjs`。设置 `PI_TEST_HOST` 为实际 SDK 包目录、`PI_ASYNC_TEST_DIR` 为本目录后用 Node 执行；测试不发模型请求。已核对当前 SDK 0.85.1；上游包声明的 peer 范围是 0.84.x，不据 semver 声称兼容，升级运行时后应重跑测试。
