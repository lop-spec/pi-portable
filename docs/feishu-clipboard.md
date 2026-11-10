# 飞书粘贴格式

网页复制统一写入一个 ClipboardItem，包含 `text/html`（适合飞书聊天/云文档粘贴）和 `text/plain`（逐字保留原始内容，供编辑器、终端和纯文本粘贴使用）。不是飞书 API 的 post JSON，也不伪造飞书私有 MIME。

- 消息、`/copy`、Markdown 文件：GFM → 安全 HTML，保留标题、加粗、列表、链接、表格、引用、代码块；使用和网页显示相同的中文加粗插件。
- HTML 文件：去除脚本、事件与危险 URL 后复制。
- SQL、代码、JSON、命令：HTML 代码块 + 未改动的原文；路径、错误、步骤文本同样双 MIME，不按 Markdown 重写。
- 图片作为说明和原 URL，不自动上传、读取图片或请求外站。
- Ctrl+C/右键选区复制：保留语义富文本，去掉按钮与行号；不拦截输入框、可编辑区域或空选区。
- 首选标准 Clipboard API，拒绝时使用 `copy` 事件写入双格式（兼容 LAN HTTP）；两者都不可用才退回原文，所有写入失败则拒绝，不能假报成功。
- 实际飞书目标编辑器支持的元素可能不同；表格/标题的最终呈现由目标编辑器决定，不承诺像素级一致。没有向真实飞书会话发送验收消息。

## 官方源码依据

核对版本：larksuite/cli `1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a`。

- https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/shortcuts/im/helpers.go#L857-L1005 ：`resolveMarkdownAsPost` 将 Markdown 包装为 `zh_cn.content` 的 `tag:md` 元素；这是消息 API 内容，不是剪贴板载荷。
- https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/shortcuts/doc/docs_create_v2.go ：文档内容交给服务端转换。
- https://github.com/larksuite/cli/blob/1bfdcc2c1a0ed0296ddb6349d251bdd75145bc5a/shortcuts/doc/clipboard.go ：读取剪贴板图片，不提供富文本复制输出。

## 复验

源码集成后：`node --experimental-strip-types --test tests/piweb-feishu-copy.mjs`（默认集成树 `upstream`，异地可设置 `PIWEB_COPY_SOURCE`）。CI 同时执行类型检查和云端构建。

浏览器选区：`node tests/piweb-feishu-browser.mjs <集成树> <输出.js>`，通过日常极速后台浏览器加载生成脚本并读取结果；不启动隔离浏览器、不向飞书发探针、不写系统剪贴板。
