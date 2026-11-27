# Pi Web 桌面版：OpenCode

输入栏的 Agent 菜单选 `OpenCode`，从下一条消息开始生效；同一会话可切回 Pi 或 Cline。模型、推理档位、历史、项目规则、Skill 和 Pi 扩展仍走原入口，默认选择不变。

OpenCode 2.4.2 的内置系统提示不发给实际模型，桌面模式改用一句话。文件、搜索、命令与网页工具只提供最短说明；详细规则走原有按需索引。纯文字回复不启动 OpenCode，首次调用原生工具才启动，工具调用仍经过现有 Pi 检查。

桌面版使用 `opencode-agent/cli-2.4.2/opencode.exe`，可临时设置 `PI_WEB_OPENCODE_BIN` 测试。升级跟踪官方 V2 CLI 渠道 `@opencode/cli`；旧 npm 包 `opencode-ai` 和 GitHub `releases/latest` 仍可指向 V1。当前固定 [官方 Windows x64 2.4.2](https://github.com/anomalyco/opencode/releases/tag/v2.4.2)，ZIP SHA-256 `a8ab3034ca5b3ec8476e9ee73b1dc334b6d8e93edaaf224b3d2a5205e2cbfb99`。此适配不改独立运行的 OpenCode 或其配置。
