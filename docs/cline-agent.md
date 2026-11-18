# Cline agent

对话框输入区的 agent 下拉（`Pi` / `Cline`，默认 Cline）决定下一条消息由哪个 agent 处理。会话、模型、推理档位、历史、压缩、规则、Skill、记忆和 Pi 扩展工具两边共用，所以可以逐条消息来回切换。未安装 Cline 的机器不显示这个下拉，pi-web 行为与之前相同。

## 两种模式的差别

| | Pi | Cline |
|---|---|---|
| 系统提示 | Pi 的 | Cline 的，后接 Pi 的项目上下文、Skill、扩展段（如记忆索引） |
| 文件与命令工具 | `read` `bash` `edit` `write` `grep` `find` `ls` | Cline 的 `read_files` `run_commands` `editor` `search_codebase` `fetch_web_content` `skills` |
| Pi 扩展工具（提问、浏览器、生图、子代理、MCP…） | 可用 | 可用，仍由 Pi 执行 |
| 模型调用、会话文件、界面事件 | Pi | Pi |

工具前安全检查（`lop-pretool`）对两边同样生效：Cline 的 `run_commands` 逐条命令按 `bash` 判定，`editor` 按 `write` / `edit` 判定，命中即整次调用不交给 Cline。

Cline 的 `ask_question`、`spawn_agent`、`team_*` 不提供：前者需要它的终端界面，后两者启动的 agent 不在 Pi 的会话里；对应能力用 Pi 的提问和子代理工具。

## 工作方式

每个完整会话带一个内联扩展（`lib/cline-agent.ts`）。Cline 模式的一轮：

1. 取 Cline 的系统提示和工具清单。它们只能从 Cline 进程发出的第一个请求里读到，而进程要先加载约 0.9 秒的程序、再初始化约 0.3 秒才会发出，所以按「Cline 程序 + 工作目录」存一份在 `<agentDir>/cline-agent/prompt-cache/`：
   - 有存档：直接用，不等进程。提示里的日期换成今天；进程起来后用它报告的内容更新存档，Skill 等有变化时下一轮生效。
   - 没有存档（该目录首次使用、Cline 升级后）：等进程发出第一个请求，读到后存档，这一轮多等 1.3–2.5 秒。
2. `cline --json` 进程在后台启动（`ClineTurn.create` 立即返回），不挡在模型调用之前。
3. 把 Cline 的工具注册为 Pi 工具并替换 Pi 自己的文件/命令工具；系统提示用 Pi 的构建器渲染后作为本轮提示。
4. Pi 照常调用模型。文字增量转给 Cline 的请求；模型调用 Cline 工具时，Pi 执行到该工具才把调用交给 Cline，Cline 执行后在下一个请求里带回结果；调用到达时进程还没起来就等它。
5. 一轮结束：进程已发出过请求的，收到最终回答后自行退出；整轮没有用到工具、进程还没发出请求的，直接结束它。Pi 的工具集恢复。

Cline 进程不保存任何状态：它的请求里只用到系统提示、工具清单和工具结果，对话内容全部来自 Pi 的会话。所以进程中途退出、重试、追加消息时换一个新进程即可继续。点「停止」会立即结束 Cline 进程树。

启动等待能被模型的思考时间盖住多少：盖住的是 min(进程启动时间, 模型给出第一个工具调用的时间)。推理模型通常要几秒，等待基本消失；极快的模型（几百毫秒）仍要等进程起来，只省下模型那一段。实测（模型延迟 2.5 秒）提示被接受从 2.6 秒降到 20–30 毫秒，整轮与 Pi 只差工具本身的 0.3 秒。

切换 agent 的第一条消息，模型侧的提示缓存前缀会变（系统提示和工具集不同），该请求不命中缓存；之后同一模式内正常命中。会话文件每次切换多一条约 8–10 KB 的工具声明记录。

## 安装与升级

```bash
node tools/install-cline-agent.mjs
```

把 `assets/cline-agent.json` 固定版本的平台包装到 `<agentDir>/cline-agent/cli`（约 140 MB，只有可执行文件）。升级：改该文件的版本号后重跑。Cline 自己的状态在 `<agentDir>/cline-agent/home`，每个进程留下的记录超过两天自动清理，不读写用户的 `~/.cline`，不启动它的后台守护进程，关闭了自动更新和遥测。

`PI_WEB_CLINE_BIN` 可指向别处的可执行文件。卸载：删除 `<agentDir>/cline-agent`，开关随之消失。

## 复验

`node --experimental-strip-types --test tests/piweb-cline-agent.mjs`：集成锚点；进程桥对一个 Cline 形态客户端（`tests/fixtures/fake-cline.mjs`，可设置启动延迟）的协议，包括进程还在加载时的调用、没用到就结束、启动超时；提示存档的日期换算、按目录与程序分条、坏文件忽略、条数上限。
