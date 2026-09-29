# 网页聊天 → 本地执行桥：同类项目横扫调研

调研日期：2026-09-30。起因：用户提供一份同类项目清单（Hearth、anybridge、thresh-bridge、webcodex-mcp、LocalMCP、chat-cli），要求逐项核实并继续横扫赛道。方法：GitHub API 搜索 + 各仓库 README/安全文档静态阅读；**未安装依赖、未运行任何第三方代码**。星标与推送日期为当日 GitHub API 快照。

## 一、清单核实结果：一半不实，采纳前需逐项核对

| 清单中的项目 | 核实结果 | 说明 |
|---|---|---|
| anybridge | ✅ 存在，描述吻合 | [winnerman-gc/anybridge](https://github.com/winnerman-gc/anybridge) |
| LocalMCP | ✅ 存在，描述吻合 | [daodao97/localmcp](https://github.com/daodao97/localmcp)，"本机主动 WebSocket 连中继、不需要公网 IP" 与 README 一致 |
| webcodex-mcp | ⚠️ 名称对不上 | 实际为 [xq3427/WebCodex](https://github.com/xq3427/WebCodex)（"让 ChatGPT 通过 MCP 操作授权的本地项目"）与 [3169657175/gpt-webcodex](https://github.com/3169657175/gpt-webcodex)，没有一个叫 `webcodex-mcp` |
| Hearth（Open-Sourcer） | ⚠️ 仅找到名字最近的 | [yujimtb/hearth](https://github.com/yujimtb/hearth)（"Thin local-first Windows MCP runtime for ChatGPT Web"，0★）；清单所述"隧道+自设密码+支持 Claude/通用 MCP 客户端"未能核实 |
| thresh-bridge | ❌ 未找到 | GitHub 搜索无任何匹配（扩展+守护进程+WebSocket 的描述无对应仓库） |
| chat-cli（Chrome 扩展配对本地守护进程） | ❌ 未找到 | 该名称与描述组合搜不到 |

清单可能来自另一 AI 的检索或转述；其中 anybridge、LocalMCP 信息准确，其余为张冠李戴或不存在。

## 二、赛道归纳：三条技术路线

1. **网页旁观 / 浏览器注入**（本项目、anybridge、justcode）：不改聊天站服务端，靠浏览器侧（Playwright 独立驱动 / Tampermonkey 用户脚本 / MV3 扩展）读取回复、执行、回填。适用任何网页聊天（含免费 DeepSeek/Kimi），代价是 DOM 依赖、站点改版要跟。
2. **官方连接器 / 远程 MCP**（webcodex、gpt-webcodex、localmcp、RepoRelay、codex-with-chatgpt、yujimtb/hearth）：本地起 MCP server，经隧道或中继暴露，ChatGPT 开发者模式配置连接器。协议稳定、不爬 DOM，但要求 ChatGPT 付费档+开发者模式（DeepSeek/Kimi 等无此入口），且本地服务暴露面更大（隧道、凭据分发）。
3. **一键上下文 / 代码回贴**（justcode 也属此类）：非 agentic 循环，单轮推送项目上下文、把生成的脚本一键部署回来。

## 三、逐项档案（已核实部分）

### anybridge — 与本项目最同质

[winnerman-gc/anybridge](https://github.com/winnerman-gc/anybridge)：12★、0 fork、21 commits，MIT，Python 3.10+（仅标准库）本地 agent + Tampermonkey/Violentmonkey 用户脚本，在 Windows 上编写和测试。

- **协议**：模型在回复里输出 JSON 块 → 用户脚本从响应流提取 → POST 到本机 127.0.0.1 agent → 结果渲染为纯文本粘贴回聊天。与本项目的 ```host 围栏 + watcher 回填同构，但传输层是"用户脚本 + 本地 HTTP"而非"Playwright 旁观"。
- **站点**：ChatGPT、Gemini、Kimi、DeepSeek、Qwen、Grok、z.ai 各配流式适配器；Claude 适配器存在，但 Claude 拒绝充当桥模型（README 明说）。
- **工具面**：17 个文件工具（read/write/edit/replace_lines/insert_lines/apply_patch/list/glob/grep/mkdir/move/copy/delete/git_status/git_diff/watch_file 等）+ 显式 `--bash` 才开启的 shell。**write-first，含 delete**。
- **安全模型**：目录允许列表沙箱（检查前解析 symlink/junction，`--all` 显式关闭）；仅绑回环；自定义 `X-Anybridge` 头令跨域 fetch 在预检阶段被拒；每次运行一次性配对 token；Host 头校验防 DNS rebinding；无 CORS 头；写前必读、删除严格规则；按块 ID 防重放；只扫描 assistant 容器、不执行用户消息里的块；推理轨迹不执行。

### yyjeqhc/webcodex — 赛道头部

[yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex)：2054★、259 fork、1712 commits，Apache-2.0，Rust，推送至 2026-09-29（活跃）。"Give cloud AI agents a real development environment on your own machines."

- MCP/HTTPS 桥：单机桌面应用（内置 CLI/Server/Runner）或多机自建 Server + 各机器 Runner；仓库不上传，AI 客户端经 MCP 连到持有代码的机器，可改代码、跑测试、看 diff。
- 产品化程度最高：一键"share"临时会话试用、Runtime Console 长任务观测、Windows/macOS/Debian/Ubuntu 安装包（README 自述跨平台安装验证未完成）。
- 安全：执行限制在已注册项目边界内，工具结果（含文件片段）回传给客户端；细节在其 SECURITY.md。

### 3169657175/gpt-webcodex — 中文，250★

[gpt-webcodex](https://github.com/3169657175/gpt-webcodex)：250★、34 fork，MIT，Electron（Windows）桌面助手 + Python "Coding Tools MCP" 运行时，18 commits，v0.7.6。

- 架构：ChatGPT 网页 → 隧道 + API key → 本地运行时；页面与本地执行解耦，短时断网不杀运行中任务。
- MCP schema v10 暴露 9 个工具：文件操作、shell（PowerShell/Git/npm/Python）、测试、打包、工作区切换、任务恢复。
- **全权限默认**：命令以当前 Windows 用户运行，Git/构建无需聊天内审批；README 自警告仅用于可信机器。面向 ChatGPT 开发者模式用户。

### daodao97/localmcp — 中继派代表

[daodao97/localmcp](https://github.com/daodao97/localmcp)：71★、13 fork，MIT，TypeScript，npm 包 `@daodao97/localmcp`，推送至 2026-09-20。

- 架构：本机 agent **主动外连** Cloudflare Worker 中继（无需公网 IP/入站端口）；默认公共中继开箱即用，可一键自部署 Worker。ChatGPT 开发者模式加 connector，**凭据内嵌在 MCP URL 里**（auth 设 None）。
- 工具：文件/shell/常驻进程（config `features` 可逐项开关）+ Skills（`~/.localmcp/skills/<name>/SKILL.md`）；外部 MCP server 经 `list_mcp_servers` / `list_mcp_tools` / `call_mcp_tool` 三个固定工具透传——与本项目 P60 的"目录=允许列表"是两极（动态发现 vs 冻结授权）。

### RepoRelay — 安全姿态与本项目最近

[Lukie-81 的 RepoRelay](https://lukie-81.github.io)：ChatGPT Web/Codex 经 MCP 只读访问**单个显式批准的本地仓库**；回环隧道、路径校验、无通用 shell、固定少数工具。属于路线 2 里的"只读保守派"。

### 其余小项目

- [xq3427/WebCodex](https://github.com/xq3427/WebCodex)：5★，TypeScript，"让 ChatGPT 通过 MCP 操作授权的本地项目"，推送至 2026-09-22。
- [JuanseGZZ/localmcpcoder](https://github.com/JuanseGZZ/localmcpcoder)：4★，JavaScript，remote MCP server with shell/file/search。
- [yujimtb/hearth](https://github.com/yujimtb/hearth)：0★，JavaScript，"Thin local-first Windows MCP runtime for ChatGPT Web"，推送至 2026-09-22；疑似即清单中"Hearth"，细节未核实。
- [achendev/justcode](https://github.com/achendev/justcode)：8★、384 commits，GPL-3.0。Chrome MV3 扩展 + 可选 Flask 本地服务；一键推项目上下文、一键部署 LLM 生成的 bash 脚本，自动生成 undo/redo 脚本；Browser 模式用 File System Access API（句柄存 IndexedDB，无需服务）；Server 模式提供 /getcontext /deploycode /undo /redo、MCP 桥与 Whisper 听写。属路线 3，README 自警告"LLM 代码直接在你机器上执行"。
- [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)：2026-09-24 已单独调研，见 [codex-with-chatgpt.md](codex-with-chatgpt.md)。

## 四、与本项目对照

| 维度 | Chat2Local | anybridge | gpt-webcodex | daodao97/localmcp |
|---|---|---|---|---|
| 接入方式 | Playwright 旁观执行 | 用户脚本注入 | 隧道 + ChatGPT 开发者模式 | Worker 中继 + 开发者模式 |
| 需要付费档/开发者模式 | 否（任何网页聊天） | 否 | 是（ChatGPT） | 是（ChatGPT） |
| 可用站点 | DeepSeek 等（站点数据化） | 7 家，含 DeepSeek | 仅 ChatGPT | 仅 ChatGPT |
| 默认工具面 | 只读四动作 | 17 写读工具 + 可选 bash | 9 工具，全权限默认 | 文件/shell/进程，features 开关 |
| 写入管控 | MCP 桥接 + 分级审批（P60/P61）、dryRun diff、.bak、会话撤销 | 沙箱允许列表 + 写前必读，无逐笔审批 UI | 无聊天内审批 | ChatGPT 侧调用确认，靠模型侧确认框 |
| 结果不明/断点 | watch 断点人工核对、状态不明停止批次 | 按块 ID 防重放 | 任务恢复工具 | 未述 |
| 依赖 | Node 内置 + Playwright | Python 标准库 | Electron + Python | Node 22 + CF Worker |

本项目在同类中的差异化恰好是"保守"那一侧：默认只读 + 硬沙箱（Host Root、敏感路径、符号链接）、写入走门控分级审批、结果不明时停人工核对、双模式中文提示词纪律。同类项目普遍 write-first 且把安全寄托在"用户自己审查"上。

## 五、可借鉴与不宜照搬（设计判断，不表示已决定实施）

**可核对/可借鉴：**

1. anybridge 的本地 HTTP 加固三件套：一次性配对 token、Host 头防 DNS rebinding、自定义头拒绝跨域。若未来 `control-server.mjs` 演进出对外 HTTP 接口，这是现成的反例清单。
2. anybridge「只扫描 assistant 容器、不执行用户消息中的块」+「按块 ID 防重放」。本项目 parse 层从网页提取回复，值得核对一次提取范围与重复块去重现状——仅列为核对候选，非既定缺陷。
3. daodao97/localmcp 的三固定工具透传外部 MCP，与 P60 冻结授权互为对照，可用于检验 P60 文案是否把"为什么不动态发现"讲清楚。
4. webcodex 的一键临时 share 试用，属产品层思路，当前边界不做。

**不宜照搬：**

- Cloudflare 公共中继、凭据内嵌 URL（localmcp）：把信任押在 URL 保密上，与本项目"本地专用浏览器、不扩网络暴露面"的前提冲突。
- 全权限默认、无逐笔审批（gpt-webcodex、anybridge `--all`）：与分级写入审批方向相反。
- 隧道 + OAuth 配对（codex-with-chatgpt 已论证不照搬，理由不变）。

## 六、趋势判断

- ChatGPT 官方 Connectors→Apps、开发者模式 MCP 持续降低路线 2 门槛；头部 webcodex 2054★ 说明"云端模型 + 本地环境"需求真实且在涨。
- 官方能力扩张主要挤压路线 2（都要开发者模式、都要付费）；本项目所在的路线 1 面向 DeepSeek/Kimi/免费用户等**没有官方 MCP 入口**的站点，生态位短期仍在。
- 生态共性难题：anybridge 记录了"Claude 拒绝充当桥模型"——协议对模型的纪律要求是全赛道问题，与本项目用开场白 + 工具目录 + 回填协议约束模型的思路一致，侧面验证了提示词纪律投入的价值。

## 七、未验证范围

- 全部为静态阅读（README、GitHub API、搜索摘要）；未运行任何第三方代码，未实测任何协议。
- 星标/推送日期为 2026-09-30 快照，会随时间过期。
- yujimtb/hearth 仅见搜索摘要，未逐条核对 README；"Hearth (Open-Sourcer)"出处未找到。
- anybridge 的工具数、"Claude 拒绝充当桥模型"等细节来自其 README 自述，未实测。
