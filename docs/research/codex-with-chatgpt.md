# codex-with-chatgpt 借鉴调研

调研日期：2026-09-24。目标仓库：[XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)，固定在公开仓库当时 `main` 的提交 [`9663b887`](https://github.com/XiaoDuoYa/codex-with-chatgpt/tree/9663b88753e35c76796c5bce000293e0bd22cd9e)。只阅读 README、源码、测试与协议文档；未安装依赖、运行其脚本或连接服务。其代码由 `src/workspace`、`src/session`、`src/execution`、`src/bridge`、`src/mcp` 等组成；它是 ChatGPT 网页与 Codex 之间的只读 MCP 桥，不是本项目这种本地浏览器旁观执行器。[源码目录](https://github.com/XiaoDuoYa/codex-with-chatgpt/tree/9663b88753e35c76796c5bce000293e0bd22cd9/src) · [架构](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/docs/architecture.md)

以下按对本项目的潜在价值排序；“值得借鉴”是设计判断，不表示已在本项目复现缺陷或决定实施。

## 1. 为 watcher 设计有界、可恢复的动作断点

上游把会话 URL 与任务断点分开存：断点含任务 ID、轮次、协议状态、等待对象及简短的目标/进展/问题/下一步，文本字段限制在 400–800 字符；更新会合并旧值，完成后可单独清除断点。[数据结构与字段上限](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/session/state.ts#L12-L69) · [合并实现](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/session/state.ts#L165-L264) · [兼容测试](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/tests/session.test.ts#L96-L173)。其 Skill 按 `EXECUTED_LOCAL` / `EXECUTED_SENT` 等断点区别“待发送结果”与“等待网页审查”，并明确超时不等于任务丢失；聊天失效时以简短 HANDOFF 续接，而非粘贴日志。[恢复步骤](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/skill/SKILL.md#L513-L559) · [协议说明](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/docs/protocol.md#L21-L49)

本项目可借鉴的是“先记录阶段，再决定是否重做”，尤其针对 watcher 执行 Host 动作后、结果回填前被关闭的窗口。只存脱敏的阶段、动作标识和必要元数据；重启后先核实旧聊天是否仍可打开，再确定回填。**不可直接照搬其恢复承诺**：上游不是自动执行任意 Host 动作；本项目 `run` 可能有副作用。仅靠短断点无法保证“恰好执行一次”，故任何重放都须以故障注入、动作幂等性或用户确认作前提，不能静默重复执行。

## 2. 统一敏感文件拒绝策略，但保留“噪声目录”和“敏感文件”的区别

上游将 `.env*`、私钥、凭据文件等列为不可读模式，将依赖、构建缓存等列为默认隐藏的噪声模式，另允许项目通过 `.c2cignore` 增加限制。[规则实现](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/workspace/ignore.ts#L9-L108)。直接 `read_file` 经路径解析后拒绝敏感项；目录清单隐藏两类项；搜索的 Node 回退在读取前跳过，ripgrep 路径在返回匹配时过滤。[路径与读取](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/workspace/manager.ts#L139-L190) · [目录清单](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/workspace/manager.ts#L248-L294) · [搜索双路径](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/workspace/search.ts#L70-L208) · [相关测试](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/tests/workspace.test.ts#L98-L137)。

本项目的 `read` / `ls` / `search` 可考虑共用同一拒绝判断，以减少误将凭据回填网页的风险；现有 `LS_IGNORED_DIRS` 应保持为“递归不下钻”而非把普通依赖文件一律禁读。**边界**：上游的实现依赖额外 `ignore` 包，与本项目零新增依赖约束冲突；其路径解析允许根目录内绝对路径，而本项目明确拒绝绝对路径，不能复制。更重要的是，本项目 `run` 能启动白名单脚本，脚本仍可能自行读取敏感文件；仅拦截三种文件操作不能宣称整个 Host 已无泄露途径。上游的 ripgrep 路径是在匹配结果处过滤，不等于检索进程从未触碰敏感文件。

## 3. 将运行证据分为“摘要”和“可选择公开的输出”

上游 `test_status` / `execution_summary` 只返回任务、轮次、测试结论等元数据；`execution_output` 必须先列清单再按 ID 读取，受限项没有正文。[MCP 工具实现](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/mcp/server.ts#L368-L468)。输出入库前以固定规则拒绝私钥，遮盖若干 token/家庭目录路径，并限制为 200 行、64 KiB；保存时仅写脱敏正文，最多保留 40 条。[脱敏规则](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/execution/sanitize.ts#L3-L75) · [存储与读取](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/execution/output.ts#L60-L128) · [测试](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/tests/execution-output.test.ts#L7-L87)。

可借鉴为本项目的**诊断/历史记录**设计：默认只留动作状态、耗时、截断/错误类别，用户需要排障时再明确选择是否保留有限正文。与当前 Host `run` 的网页回填协议不同，不能无兼容设计就把执行结果改成“只有摘要”，否则网页无法分析失败。正则脱敏只覆盖已知格式，不能保证任意秘密不泄露；日志内容、命令行参数和错误堆栈都要作为潜在敏感输入审视。

## 4. 将“健康 / 已停止 / 状态不明”分开，状态不明时保留现场

上游根据本地健康探针、工作区 ID 和进程存在性将桥接进程分成 `healthy`、`stopped`、`unknown`；探针失败但进程仍在时不推断“已死”。[观察状态实现](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/bridge/runtime.ts#L50-L107) · [进程复用入口](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/process/daemon.ts#L29-L77)。本项目可把这一思想用于控制台、watcher 与专用浏览器之间的故障提示：程序重启、页面不可达、浏览器资料目录被占用应分别说明；“未知”状态只给安全的人工处理步骤。由于本项目已实现资料目录占用时不自动杀浏览器，该点主要是完善状态呈现和测试，而不是引入桥接守护进程。

## 不宜照搬

- **公网隧道、OAuth 配对和 MCP 服务**：上游需要让 ChatGPT 网页主动访问本地只读桥，因此引入 Cloudflare 隧道、OAuth、配对码及一组 npm 包；本项目用本地专用浏览器与控制台，不存在同样的跨网络前提。照搬会增加攻击面、依赖和权限配置，违背当前零新增依赖及不擅自扩权的边界。[上游架构](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/docs/architecture.md) · [上游依赖清单](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/package.json)
- **ChatGPT Project 集合的一项目一集合模型**：上游在 `project` 模式下，新 Codex 对话会在同一 ChatGPT Project 中新建聊天，而非复用上次 URL；它把“集合”视为项目记忆边界。[模式解析](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/src/session/state.ts#L114-L163) · [Skill 操作约定](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9/skill/SKILL.md#L407-L442)。本项目当前需求是**同一项目尽量续接同一网页会话**，且支持 DeepSeek 等网站；不能用集合语义替换。
- **直接复制其正则或路径实现**：上游路径解析允许根内绝对路径，脱敏也非任意秘密的证明；本项目需守住更严格的 Host Root 约束，并通过自身真实样本和单测验证。

调研未对目标仓库进行运行测试；以上“源码已核实”只表示静态核对实现与测试，不能推断其部署环境里的行为。后续若动手实现，仍按本仓库 `AGENTS.md` 先建立本地可复现证据、一次只改一个边界清晰的问题。
