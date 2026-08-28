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
| S1 脱敏基线 | ✅ | scan-secrets 0 命中(1 例外带书面理由) |
| S2 可移植化 | ✅ 6/6 | `test/s2-full.mjs`:出口自适应 4.4s → 桥 v7.8.5 就绪 → 写点全在数据根 → 真实请求 200 → 零污染本机 |
| 加密资产层 | ✅ 8/8 | `test/s2-assets-crypto.mjs`:6 项 128KB,纯解密 0.64ms,首启 867ms,源零改动,错口令/篡改被拒 |
| S3 公有仓 | ✅ | 已推 https://github.com/lop-spec/pi-portable(MIT);匿名克隆 + 全历史扫描 0 泄漏 |
| S4 云 CI | ✅ | Actions 绿 → Release `v0.0.1-rc2` 出 **82.9MB 单 exe** + SHA256;匿名下载校验 MATCH、PE 头 OK |
| S5 安装面 | ✅ 13/13 | `test/s5-real-exe.mjs`(真实 Release exe):解压完整包 → 包内 node v22.19.0 自足 → 解密 859ms → 出口自适应 → 双服务 → **真实工具回显 exe-ok** → 关闭双端口释放 → 复活零口令 |
| S6 执行链 | ✅ 9/9 | `test/s6-chain-coldstart.mjs`(空账本冷启):INJECT 生效 → S8 落账建库 → **第二遍 exact 命中(冷启→热账本闭环)** → 历史注入 630B |
| S7 代理桥 | ✅ | 含于 S2/S5/S6:出口自适应命中、/health 版本正确、真实模型请求 200 |
| S8 预演(本机) | ✅ 13/13 | `test/s8-fresh-machine-sim.mjs`(纯下载 v0.0.2-rc2 全含版,零注入):自带 938KB 加密段 → 仅输一次口令 881ms → 出口自适应 → 双服务 → **零配置直接对话+工具执行 fresh-machine-ok** → 执行链 INJECT 生效 → 关闭端口全释放 → 复活零口令 |
| S8 机器2 终验 | ☐ **待异机执行** | 需真实异机:下载 Release exe → 双击 → 输口令 → 同 13 项断言。本机无法代验 |
| S9 交付 | ☐ | S8 异机通过后:去 rc 正式 tag + README 补机器2 记录 |

## 使用方式(机器2)

1. 从 [Releases](https://github.com/lop-spec/pi-portable/releases) 下载 `pi-portable-<版本>.exe`
2. 双击 → 解压 → 首次启动输一次解密口令(之后本机免输)
3. 自动完成:出口探测 → 起桥 → 起 pi-web → 打开独立窗口
4. 关闭窗口 = 彻底退出(整棵进程树被回收);再双击即复活

无凭证的 base 版:删掉仓库根的 `assets.enc` 重新构建即可,首启会用本机已有的 codex 登录态。

## 关键实测结论

- **出口是换机头号变量**:chatgpt.com 在部分网络环境**直连不可达**(TLS 超时),必须走代理。发行版不能假设直连——`egress-autodetect` 按 直连 → 常见本机代理端口 → 用户自定义端口 顺序探测,数秒内定位可用出口并持久化;全失败则由 UI 引导输入。
- 桥的本机耦合只有 4 处(日志/指标写点、egress 状态文件、代理端口默认),全部参数化后隔离实例真实出网 200。
- 端口避让:8796 是本机 codex-app-gateway,8793 占用;测试用 8899。

## 本地验收

```bash
node tools/portable-ize.mjs          # 重生成可移植桥
node test/s2-full.mjs                # S2 隔离实例完整验收
node src/egress-autodetect.mjs <dir> --force   # 单测出口探测
```
