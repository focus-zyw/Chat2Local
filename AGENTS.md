# 维护约束

本文件适用于整个仓库。

## 产品边界

- 面向中文用户；CLI 提示、用户可见错误、README 与维护文档使用中文。
- 保持 host 的 `read` / `ls` / `search` 只读文件能力和 `run` 受限脚本执行能力，不为 host 新增文件写入动作。`run` 的脚本可能读写文件；Host Root 路径过滤不是运行隔离。
- `mcp` 是 watch 模式的可选桥接：server 由用户指定，模型只能调用已展示并授权的工具；目录缺失或授权状态不明时停止执行。工具入参及副作用由 server 负责，接入非只读 server 须由用户明确决定。修改 MCP 授权、会话、写入审批或现场验证时，先读 [MCP 桥接与验证](docs/agents/mcp-watch.md)。
- MCP 写入审批只覆盖 `src/host-actions.mjs` 中 `isMcpWriteTool` 按名称识别的工具；不能据此认定其他外部工具只读。审批模式不放宽 server 的授权根、敏感路径、越界、符号链接或二进制覆盖保护。
- 不新增 npm 依赖；优先使用 Node.js 内置模块。Playwright 是现有浏览器驱动依赖。
- 保持 Receipt、动作协议及已有调用方式向后兼容；确需变更时先补兼容测试。

## 安全与数据兼容

- Host Root 是硬沙箱边界：拒绝绝对路径、`..` 越界以及通过符号链接或目录联接越界。
- `read` / `ls` / `search` 同时检查请求路径与解析后的真实路径；目录遍历先隐藏常见凭据、私钥和敏感目录。
- `run` 只执行白名单类型，必须保留超时、输出上限和隐藏窗口等防护。
- 不读取或打印凭据、浏览器配置、会话数据；真实站点只使用专用浏览器资料目录。
- watch 断点只保存阶段、回复指纹与动作计数；中断状态未经人工核对时，保持原聊天并停止自动执行或回填，不能以新建会话绕过，也不能猜测发送结果后重放。
- 不做破坏性迁移、外部发布、权限扩张或需要产品方向取舍的改动，除非用户明确决定。

## 改进闭环

代码或行为改进按以下顺序执行；纯文档改动检查事实、链接、差异与工作区，按影响范围决定是否需要测试。只读咨询和审阅不产生提交。

1. 读取 `PLAN.md`、工作区状态、测试结果与真实运行表现，按影响、风险和验证成本排序。
2. 每次只选择一个边界清晰的改进；先建立可复现证据，再实现最小完整修复。
3. 同步必要文档，运行针对性测试、完整单测和相关浏览器冒烟；真实站点未验证时明确记录范围。
4. 检查 diff 与工作区，使用独立、可回滚的 Git 提交保存。
5. 在 `PLAN.md` 记录完成证据和下一批候选，不把未经验证的猜测写成既定缺陷。

## 架构速查

| 文件 | 职责 |
|---|---|
| `src/loop.mjs` | `runTurn()` 单轮原语；`orchestrate()`（任务模式）是其参数化封装。**改循环语义只改 runTurn** |
| `src/watcher.mjs` | watch 旁观执行：变化唤醒 → 稳定判定 → 动作执行 → 结果回填；结果不明时停止批次与回填，保留未确认断点。会话收尾细节见 [MCP 桥接与验证](docs/agents/mcp-watch.md) |
| `src/watch-checkpoint.mjs` | 按站点和项目保存最小断点；原子写入，不存聊天正文、动作参数、结果或线程地址；未确认断点保留到人工核对 |
| `src/host-actions.mjs` | read/ls/run/search 执行器 + root 沙箱 + 截断/超时 + `LS_IGNORED_DIRS`。read 双坐标（字符 offset / 行号 line），search 输出 `文件:行号:` 与 read 行号模式同坐标。`mcp` 动作在此校验形状后经 `runAction(msg, root, ctx)` 的 ctx 桥接 |
| `src/mcp-client.mjs` / `src/write-gate.mjs` | MCP 常驻客户端与写入审批；会话及门控细节见 [MCP 桥接与验证](docs/agents/mcp-watch.md) |
| `src/kill-tree.mjs` | 进程树终止（Windows taskkill /T，POSIX 进程组 SIGKILL）；run 超时与 MCP 会话收尾共用 |
| `src/sensitive-paths.mjs` | 常见敏感路径的纯函数判定；Host 动作在请求路径和真实路径上调用 |
| `src/parse.mjs` | 回复 → 动作：```host 围栏 / 裸 JSON 兜底 / 中文标点归一化；`stripActionBlocks` 剥块供显示 |
| `src/protocol.mjs` | payload 构造：`firstPayload`（任务）/ `chatIntroPayload`（导师）/ `resultPayload`（结果回填） |
| `src/page-script.mjs` | 页面端自包含函数（`page.evaluate` 注入）：填框/发送/观看/提取。`<pre>` 重建为 ``` 围栏 |
| `src/sites.mjs` | 站点选择器**纯数据**。站点改版只改这里，不动骨架 |
| `src/page-driver.mjs` | Playwright 驱动器；`send` 对明确未发送与发送状态不明的错误作区分，`probe` 只读检查标签页及可见输入框 |
| `src/browser.mjs` | `launchPersistentContext` + chrome→msedge→chromium 回退；资料目录占用时保留原浏览器并提示处理 |
| `src/control-server.mjs` | 本地控制台会话与断点恢复入口；网页连接健康/已停止/状态不明独立于执行状态，状态不明只提示、不自动重建聊天 |
| `src/cli.mjs` | setup / list / ask（任务）/ chat（导师 REPL）/ watch（旁观执行）命令 |

## 开发约定

- 新增或修改自带 MCP server（`demo/mcp-*.mjs`）的路径、目录、读取、子进程或输出行为前，先按 `docs/agents/mcp-server-review.md` 列出适用边界并建立失败样本；交付时逐项核对反例、真实 client 回填和未验证范围。
- 两种模式共用 `runTurn`：行为差异全部用参数表达（`detectDone` / `stallLimit` / `wrapUpOnBudget`），不要复制循环代码。
- `host-actions.mjs` 的上限常量（`READ_MAX_CHARS` 等）与 `protocol.mjs` 的协议文案保持一致，改一处同步另一处。
- `ls` 递归跳过 `LS_IGNORED_DIRS`（node_modules/.git/dist 等）：目录名保留在清单里但不下钻；单层 ls 与显式 read 依赖文件不受影响。
- watch 恢复改动须覆盖执行中、回填中、已处理及断点损坏的测试；发送状态不明时停在人工核对，只有明确未发送才允许在本进程重试。
- 网页连接诊断仅探测浏览器、标签页和输入框；状态不明时保留原浏览器及原错误，不读取聊天正文或登录信息。
- `chatIntroPayload` 是导师带教纪律提示词（每轮一小步 / 结尾反问 / 先猜再揭晓 / 不读依赖源码 / 严禁编造），`tests/protocol.test.mjs` 用关键词断言锁定，改动前先看测试。
- 站点渲染坑（弯引号、全角标点、围栏丢失）的修复必须先用真实样本写失败测试再修。

## 验证命令

测试脚本以 `package.json` 为准：`npm test` 和 `npm run smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile`。功能或修复需有相关单测；纯文档改动按影响范围验证。

## 工具测试聊天

真实网页模型运行 host/mcp 动作时，按 [MCP 桥接与验证](docs/agents/mcp-watch.md)使用 `dev-root/` 专用测试聊天；测试同样遵守结果不明停止、断点人工核对和浏览器 profile 独占约束。

## 诊断

「动作块没被识别」类问题：终端会提示并把网页原始回复存到 `~/.file-tool/last-reply.txt`，从那里取证，不要凭猜测改解析器。

watch 模式"看不见页面"类问题：`~/.file-tool/watch-trace.txt` 是 watcher 的脱敏快照流水（busy/字符数/变化标记 + 10s 心跳）。busy 长期为 1 时优先检查生成状态信号；字符数恒为 0 时优先检查消息选择器；完全无新行时优先检查会话窗口和进程。旧版本的既有日志可能仍含文本头，排障分享前先检查并脱敏。
