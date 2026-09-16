# 双机账号池同步

后台监听账号池变更，不调用模型。按账号身份的 SHA256 匹配，不按 `acct3` 等目录名匹配；同一账号的旧槽位和在用槽位合并判断。

- 同步加入、移出和恢复的成员记录。移出只写 `.pi-pool-removed.json`，恢复前物理备份并移走标记，登录文件不删不改。
- **不传输登录凭据。** 对端没有本机登录文件的账号显示 `local-login-missing`，须在那台机器的 Pi Web 添加账号，不能直接作为可用账号轮转。
- 不同步当前使用账号、固定账号、冷却时间、额度缓存、会话、OAuth 刷新结果或其他机器状态。
- 两端并发修改不同账号直接合并；同一账号并发移除/恢复时移除优先，收到移除后的再次恢复优先。保留删除记录，断线重连不会用旧副本复活账号。
- 当前固定账号及最后一个本地在池账号暂缓移除，分别记录 `locally-pinned` / `last-local-member`。解除固定或添加替代账号后自动补做。

## 运行

两端任务名 `PiWeb-AccountPoolSync`，用户登录后隐藏运行，1 分钟看护触发；单实例保护，不启动窗口，不重启 Pi。两端都在线时，YANGYONG 建立一条到另一端的 SSH 长连接，双向传输成员元数据。底层使用既有 `lop` 身份和本机密钥，严格核验主机公钥，不复制任何密钥。

文件事件合并窗口 200ms；每 15 秒校对并发送心跳。断线按 2–30 秒退避重连；恢复后交换完整成员版本。Windows 原生 SSH multiplex 实测失败，因此明确关闭该机制，复用同一条 stdio 会话。文件监听不可用会记录原因，15 秒校对仍继续。

数据目录由安装参数指定，账号池位置从本机桥的只读 `/health` 发现。登录状态损坏、数据格式未知或备份失败时保留原文件并记录原因，不自动覆盖修复。

```powershell
# 本机路径依部署位置填写，脚本不复制配置或凭据。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/install-pool-sync-task.ps1 -DataRoot "<便携数据目录>" -Node "<node.exe>"
node src/account-pool-sync.mjs status --data-root "<便携数据目录>"
```

状态和日志：`<便携数据目录>/account-pool-sync/status.json`、`sync.log`。状态包含连接时间、双方成员摘要和待处理原因，不包含账号邮箱或 token。日志按 1MiB、3 个轮转文件保留。`connected=true` 仅表示元数据链路可达；`pending=[]` 才表示本机成员全部落地。`state.json` 是各自的持久版本和恢复日志，不能互相覆盖或删除。

暂停：禁用两端 `PiWeb-AccountPoolSync` 计划任务并停止该任务的同步进程，不停止 Pi。重启同一任务后会继续补同步。若需撤销某次移除，在同步暂停后从标记备份恢复，或通过 Pi Web 的添加账号入口重新加入。

## 验证

```sh
node --test tests/account-pool-sync.mjs tests/account-pool-sync-watch.mjs
```

测试只用临时目录和假凭据，覆盖双向事件、并发冲突、断线重启、重复槽位、备份失败、损坏数据、无凭据账号、凭据字节不变、固定/最后账号保护和空闲无循环。两端实际链路可通过状态中的 `digest` 相等、近期 `lastPeerAt` 和各自 `pending` 核对。
