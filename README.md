# pi-portable

pi-web + 规则执行链 + codex 代理桥的便携发行版工程。目标:另一台 Windows 机器拿到一个 exe,双击即用,关闭即彻底退出。

方案与循环验收契约:`decision-replay-engine/specs/piweb-release/plan.md`

## 目录

- `src/bridge/` — **生成物**,由 `tools/portable-ize.mjs` 从生产源桥转换而来,勿手改;源桥升级后重跑转换器。
- `src/egress-autodetect.mjs` — 出口自适应(直连探测 → 常见代理端口探测 → 引导输入),换机第一难题的解法。
- `tools/portable-ize.mjs` — 可移植化转换器(路径参数化 + 直连默认 + 发行版措辞)。
- `test/` — 隔离实例验收脚本,伪 HOME 重定向,不碰真实配置。

## 进度(S1-S9,全绿才允许交付)

| 步骤 | 状态 | 证据 |
|---|---|---|
| S1 脱敏基线 | ✅ | scan-secrets 对 `src/bridge` 0 命中 |
| S2 可移植化 | ✅ 6/6 | `node test/s2-full.mjs`:出口自适应 4.4s → 桥就绪 v7.8.5 → 写点全在数据根 → 真实请求 200 → 零污染本机 |
| S3 公有仓 | ☐ | |
| S4 云 CI | ☐ | |
| S5 安装面 | ☐ | |
| S6 执行链 | ☐ | |
| S7 代理桥 | ☐ | |
| S8 机器2 终验 | ☐ | |
| S9 交付 | ☐ | |

## 关键实测结论

- **出口是换机头号变量**:chatgpt.com 在本网络环境**直连不可达**(TLS 超时),必须走代理。发行版不能假设直连——`egress-autodetect` 按 直连 → 7890/10809/10808/1080/8080/7897/57905/18799 顺序探测,4.4s 内定位可用出口并持久化;全失败则由 UI 引导输入。
- 桥的本机耦合只有 4 处(日志/指标写点、egress 状态文件、代理端口默认),全部参数化后隔离实例真实出网 200。
- 端口避让:8796 是本机 codex-app-gateway,8793 占用;测试用 8899。

## 本地验收

```bash
node tools/portable-ize.mjs          # 重生成可移植桥
node test/s2-full.mjs                # S2 隔离实例完整验收
node src/egress-autodetect.mjs <dir> --force   # 单测出口探测
```
