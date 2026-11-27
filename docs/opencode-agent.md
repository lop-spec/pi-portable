# Pi Web 桌面版：OpenCode

输入栏的 Agent 菜单选 `OpenCode`，从下一条消息开始生效；同一会话可切回 Pi 或 Cline。模型、推理档位、历史、项目规则、Skill 和 Pi 扩展仍走原入口，默认选择不变。

OpenCode 1.19.6 的内置系统提示不发给实际模型，桌面模式改用一句话。文件、搜索、命令与网页工具只提供最短说明；详细规则走原有按需索引。纯文字回复不启动 OpenCode，首次调用原生工具才启动，工具调用仍经过现有 Pi 检查。

桌面版的 agent 目录内使用 `opencode-agent/cli/opencode.exe`，也可临时设置 `PI_WEB_OPENCODE_BIN` 做测试。只用 [官方 Windows x64 1.19.6](https://github.com/anomalyco/opencode/releases/tag/v1.19.6)，ZIP SHA-256 为 `fa31c9ec0bac7611ab12699ef8e2fc4c173fb95ac977b09b189b255b8f559bcc`。升级时用真实二进制复验 `tests/piweb-opencode-agent.mjs`。此适配不改独立运行的 OpenCode，也不改它的全局配置。
