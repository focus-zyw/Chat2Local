# 持续维护计划

## 硬约束

- 不新增依赖；保持中文 UI / 注释 / 文档。
- 保持 Host Root 沙箱、只读文件能力、受限运行能力和现有数据/协议兼容。
- 每轮只交付一个可验证、可独立回滚的改进。

## 当前轮次

- P66 已交付三项安全与正确性修复（均为已有能力，无新功能）：①`undo_write` 收编写入门控（host 清单按名拦截 + server dryRun 纯预览，消除模型绕过审批撤销文件的缺口）；②search 单文件分支同样应用 include 过滤（消除同名参数两种语义）；③切换写入审批模式即收回会话同意（补上授权只缩不扩的收回路径）。单测 243/243、五条冒烟通过；三项修复各自独立提交，见下方 P66 记录。
- P65 已校准维护文档：AGENTS.md 区分只读文件动作与可能产生副作用的 `run`，将 MCP 会话/审批/现场验证细节移入 `docs/agents/mcp-watch.md`，明确按名称识别写入工具的覆盖范围，并让纯文档改动按影响范围验证。README 的文件 server 示例改为显式 `--mcp-allow`；同时记录代码审阅发现的 `undo_write` 审批缺口与外部 dryRun 信任边界。仅文档改动；已核对源码、示例工具名、相对链接、diff 与工作区，未运行单测或浏览器冒烟。
- P64 本地项目展示名称改为 Chat2Local：更新包名、CLI、控制台、浏览器标签页、新回填消息和求职展示文档；保留 `~/.file-tool` 状态目录、控制台请求头、原命令及公开仓库地址，避免迁移旧聊天和断点。新旧回填标记由 mock 场景兼容识别；单测 239/239、五条浏览器冒烟通过，见下方 P64 记录。
- P63 已整理求职展示入口：README 前置项目定位、快速复现和证据导航，新增 `docs/PORTFOLIO.md` 的调用链、工程取舍、面试演示与验证边界；同步修正 README 中 `run`、写入能力、专用浏览器隔离和示例命令的过时表述。仅文档改动，`npm test` 239/239、五项浏览器冒烟通过；本地版本尚未同步到公开仓库，见下方记录。
- P62 已把 P59 压缩摘要提示词升级为结构化分节模板（吸收 pi compaction：Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context，外加「涉及文件」清单）：七小节固定组织、空节写「无」、相对路径:行号、原样保留函数名与报错信息、软性 2000 字符预算、禁嵌套围栏（保摘要捕获不被截断）；存档/注入机制零改动。测试 239/239、五条冒烟，见下方 P62 记录。
- P61 已把写入门控升级为 Codex 式分级审批（用户反馈驱动：会话开关粒度太粗、拒绝后重发浪费一轮、缺 diff 与撤销）：逐笔询问（默认，diff 预览 + 同意/会话同意/拒绝，**持有调用直执不耗模型轮次**）/风险询问（仅覆盖已有内容）/自动批准/禁止；server 端风险分级、LCS diff、undo_write 撤销栈、二进制拒覆盖；测试 239/239、五条冒烟，见下方 P61 记录。
- P60 已交付 MCP 写入门控（开源强化候选第 5 序，用户 2026-09-27 决定）：写入类工具在允许列表之上加会话级开关，默认拒绝 fail-closed；自带 fs server 新增 write_file（dryRun+备份）/create_directory；AGENTS.md 边界条款同步修订。测试 233/233、五条冒烟；真实站点写入链路待用户现场验证，见下方 P60 记录。
- P59 已交付 watch 线程压缩续接：REPL `压缩(compact)`/`保存摘要` 两命令 + `--new` 消费注入，模型自产 ```summary 摘要、用户确认后才存档（threads.json 扩展字段，取出即清除）；三角色开场白支持摘要注入。测试 232/232、smoke:watch 通过；真实站点三步链路（压缩→存档→--new 注入）待用户现场验证，见下方 P59 记录。
- P58 已交付开源强化候选第 3 序「repo-map 式符号地图」`demo/mcp-map-server.mjs`：零依赖启发式（正则+缩进状态机）抽 JS/TS/Python 符号，行号与 read 的 line 参数同坐标，出现次数排序 + 字符预算；按 P57 清单逐项核对并自查修掉联接绕过敏感过滤的 walk 缺口。测试 229/229、现场验收（symbol_map → 内置 read 行级验证）见下方记录。
- P57 已补充自带 MCP server 的实现前核对与验收清单：`AGENTS.md` 仅保留触发入口，`docs/agents/mcp-server-review.md` 列明授权路径、全部输出、只读副作用、有界读取与失败样本；针对 P53/P56 已确认缺口设计，未改运行代码。完整单测 227/227（包含工作区另有的未提交 map server 测试）、五条浏览器冒烟通过；未据此推断未来 server 已通过清单。
- P56 已修复 P55 文件 server 审核发现的路径、元数据与读取边界缺口：请求路径和真实路径双重敏感/越界检查，目录大小不跟随子链接，单句柄有界读取与全文 NUL 检查，纯敏感目录保留隐藏提示。定向 10/10、完整单测 223/223、五条浏览器冒烟通过；见下方 P56 记录。
- P55 已交付自带过滤版文件 server `demo/mcp-fs-server.mjs`（P54 审阅引出：官方 filesystem server 无敏感路径过滤）：四只读工具，敏感隐藏/拒绝语义与内置 host 动作同源（复用 isSensitivePath 与 LS_IGNORED_DIRS），realpath 冻结根作用域；dev-root 新增假凭据 fixture。测试 218/218、smoke:watch、现场验收（含 .env 拒绝实链路）见下方记录。
- P54 已完成开源强化候选第 2 序「Filesystem MCP server 只读接入」：零运行时代码改动，README 接入节 + 探测 + dev-root 现场验收（四次自构造调用全部回填、仓库零变化）；P53 遗留的敏感路径与外部执行两项边界核对结论见下方 P54 记录。
- P53 已修复 P52 Git server 代码审核确认的四处边界问题：敏感补丁泄露、Git 配置触发外部程序及索引写入、大 diff 超过旧缓冲上限后报错、失败 stderr 可使 MCP 单帧超限。隔离仓库回归见下方 P53 记录；完整单测 213/213、五条浏览器冒烟通过。
- P52 已完成开源强化候选第 1 序「Git MCP server 只读接入」：实施核实发现官方 reference 为 Python 包且允许调用时传 repo_path 覆盖作用域（与启动冻结的信任模型冲突），改为自带零依赖 Node 实现 `demo/mcp-git-server.mjs`；同轮按用户指示把工具目录上限 4→12（独立提交 86be084）。证据见下方 P52 记录。
- P51 已修复 P50 审核发现的现场记录未入库问题：把本地忽略的 `.log` 人工核对后整理为可跟踪的 `docs/runs/P50-cross-server-field-run.md`，补充固定版本入口、复跑命令、任务范本、逐轮输出、Lab 取证与证据边界；P50/README 引用已更新。
- P50 已完成跨 server 兼容验证：chrome-devtools-mcp@1.10.1（独立实现）接入同一桥接机制，task 角色重跑 Lab 全流程通过（模型自构造调用、单会话单次加载、暂停恢复保持状态、本轮新建浏览器进程检查 clean）；Playwright MCP 仍为正式已验收场景。
- P49 已修复 P48 审核的参数日志泄露风险，将现场记录脱敏整理为可跟踪文件并补齐复跑信息；修复证据见下方 P49 记录。
- P48 已完成真实模型现场重跑；当轮代码审核发现的参数日志及证据归档问题由 P49 修复，原审核结论保留在「P48 审核结果」。
- P47 已修复 P46 验收复审缺口：重连消息按实际建连时序描述旧状态失效；提交真实外部浏览器 MCP 的可重复验收脚本，修正文档与现场记录的命令和证据范围。
- P46 已把 @playwright/mcp@0.0.82 接成首个正式有状态工具场景：task 纪律补会话型工具条款（操作前读页面/变化后重取引用/保持状态不擅自刷新/暂停后先检查/结果不明不重试副作用），重连消息声明工具会话失效，README 给出接入说明；task 角色现场验收通过（六步任务、单会话单次加载、暂停恢复保持页面状态、零遗留进程）。
- P45 已修复 P44 代码复审确认的四处衔接缺口：task 开场白只待命、明确任务前零动作；task 冒烟使用正确角色断点键；角色 ID/标签/启动文案由单一元数据派生；README 补齐三角色语义与跨角色断点规则。
- P44 已新增 watch 任务执行角色（`--role task`）：连续调用工具完成明确任务，无教学纪律，done 以结论+可验证证据收尾；线程与断点按角色独立登记，完整复用授权/常驻会话/暂停恢复/结果不明停止/资源清理。后续外部 MCP 现场验证统一 `--role task --root dev-root`。
- P43 已在 P42 修复后重跑外部浏览器 MCP 现场任务：DeepSeek 专用 `dev-root` 测试聊天自行构造 5 次浏览器工具调用；本地 lab 取证证明同一页面内存状态跨调用和暂停恢复连续；退出后 server 与浏览器进程释放。范围仍限本地 stdio、串行、文本结果工具。
- P41 已落地工具测试聊天约定：AGENTS.md 新增「工具测试聊天」小节，dev-root/ 作为专用 Host Root（随仓库提交稳定样例），网页工具验证不再借用真实项目聊天线程。
- P42 已修复 P40 代码复审（`75e3608`）确认的五处缺口：目录同步失败停止并留断点、启动期目录变化不丢失、忙时立即拒绝、stderr 按 4 KiB 原始字节保留、完整帧释放底层缓冲。已验证范围仍限定为本地 stdio、串行调用、需要会话内状态的文本结果工具（浏览器连续交互场景）；远程连接、交互式授权（elicitation）、多 server 仍是独立需求。
- P39 已修复 P38 代码复审确认的四处缺口：退出释放 MCP、停止信号阻止后续动作与回填、崩溃及时结束在途调用、超时立即清理 server；验证见下方 P39 记录。远程 transport、多 server、自动重连与跨进程恢复按方案边界不实施，待后续演进。
- P37 已修复 P36 代码复审问题：能力撤销与同步失败关闭、允许列表失败关闭、完整且类型正确的调用示例、真实 UTF-8 跨块回归；接收内存上限在本轮 P38 以单帧上限形式交付。
- P36 已完成"模型能正确认识并使用工具"（目录含参数结构与示例、续接同步能力、允许列表闭环、独立 server 互操作验证）；真实网页模型自行构造调用的现场验证见 P36 记录。接收内存上限/流式输入上限（P35 缺口 4）仍待下一轮。
- P35 已完成 MCP 桥接最小版（只读搜索 + 回填）；写入类工具门控与远程 transport 是后续候选，未经用户决定不实施。
- P34 已整理 MIT 公开展示版：新增无账号 mock 演示入口和复现说明，修正 Node 版本与 npm 下载源，并以全新 Git 历史发布到 `focus-zyw/file-tool`；真实站点兼容性仍待现场验证。
- P33 已修复 P32 复审确认的 audit 段落误判、Receipt 普通任务字段兼容及文档不一致；P28 真实站点改版失败样本仍保持待验证。
- P30 已完成第一轮修复；复审发现 probe 可见性和 audit 完成判定仍有缺口，P31 已修复其中已确认的问题，余项见下方 P32 复审记录。

## 待验证候选

- 求职展示的公开版本同步：2026-09-28 核对 `focus-zyw/file-tool` 仍是 P34 时期的三提交演示仓库，本地已到 P63。若要把新能力作为公开作品展示，先审查拟公开文件和历史记录，再由用户决定是否及如何更新外部仓库；当前文档整理没有执行发布。
- MCP 后续工作按下方「MCP 演进方案（修订）」执行：控制台配置与 SDK 迁移按明确需求触发。
- P28 真实站点改版失败样本尚未出现；改版实际发生时，用 `scripts/probe-site.mjs` 采样后补充回归验证。
- 网页模型自行构造浏览器调用：P48 已在专用测试聊天重跑，P49 将脱敏记录整理为 `docs/runs/P48-field-run.md`；`scripts/verify-browser-mcp.mjs` 继续作为脚本生成动作的技术验收，两类证据分开标注。

## MCP 演进方案（修订）

本方案替代此前讨论的「先抽取通用 MCP 会话管理器，再接入控制台」优先顺序。当前交付是设计修订，以下验收与迁移均为后续工作，不代表已经完成。

### 目标与复用边界

目标是让网页模型通过现有 watch 可靠使用现成 MCP 工具。当前链路继续为：网页模型 → host 动作 → 授权校验 → MCP client → 外部 server → 结果回填。

| 能力 | 复用决策 |
| --- | --- |
| 浏览器导航、点击、快照和页面会话 | 使用已接入的 Playwright MCP；按已验收版本独立安装，不新增浏览器 server |
| MCP 握手、JSON-RPC、transport、工具发现与调用 | 当前维护现有受限客户端；需要扩展协议时优先评估官方 SDK，停止累加自研通用协议能力 |
| 网页工具目录同步、允许列表、暂停、断点、结果不明停止 | 由本项目现有 Host/watch 负责；这些规则与网页聊天执行流程绑定 |
| 控制台 MCP 配置 | 暂缓；确认 CLI 配置造成实际使用障碍后，只增加必要输入与状态展示，复用同一执行路径 |
| 通用会话管理器、多 server 管理和工具市场 | 当前不列入实施范围；出现具体需求后先调查现成能力 |

官方 SDK 已提供 Client、StdioClientTransport、listTools/callTool 等接口，参考 Host 也展示了配置和路由。它们可复用的范围不等于已经满足本项目的接收上限、进程树清理或结果不明语义，迁移必须验证这些约束。

参考：[官方 TypeScript SDK 客户端文档](https://ts.sdk.modelcontextprotocol.io/client)、[官方参考 Host](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/cli-client/README.md)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)。版本与接口以实施时核实并锁定的版本为准。

### 真实模型任务的可复核证据（P48 已实跑；P49 修复审核发现的归档问题）

复用 task 角色、dev-root 专用测试聊天、现有 Lab 页和外部 Playwright MCP。用户只给自然语言目标，由网页模型自行选择并构造工具调用。任务依次完成打开页面、读取内存标记、展开详情、读取当前状态、暂停恢复后再次读取，最后退出；后续任务参数不传回随机标记，也不重新导航或刷新。

验收同时保留三类脱敏证据：模型构造动作的最小片段与动作顺序、Lab 的会话标识及状态变化、Host 启停与退出清理记录。只保存专用测试内容，不保存登录资料、完整聊天、线程地址或浏览器配置；watch 断点格式保持现有最小字段。运行记录写明提交、外部 server 固定版本、可重放的启动步骤、自然语言任务和实际结果。

通过条件：明确任务前零调用；模型独立构造合法调用；同一页面会话仅加载一次，展开状态跨调用及暂停恢复保留；退出后本轮 server 与浏览器无残留。server 启动次数与握手次数分别按可观测证据报告，没有握手仪表化就明确写「未独立测量」，不能用同 PID 推导握手一次。脚本生成动作的技术验收与真实模型行为证据分别标注。

发生失败时按实际证据选择一个最小修复：目录表达问题修协议文案，网页解析问题修相应解析路径，MCP 互操作问题评估客户端或 SDK。完成前不增加另一套循环、通用日志平台或新测试模式。对运行代码的修复先补失败样本，再运行针对性测试、完整单测和五种浏览器冒烟。

### 后续触发条件

1. **控制台确有接入需求**：先定义所需配置和状态；调用同一配置校验、目录授权与会话收尾逻辑。只有 CLI 与控制台实际需要复用时才抽取小模块，避免复制执行循环或预建通用管理框架。
2. **需要更多 MCP 协议能力或协议维护成为实际负担**：先比较官方 SDK 与当前实现。仓库现有「不新增 npm 依赖」规则仍有效；正式引入前需由用户明确调整该约束，本次设计修订不授权安装或迁移。
3. **SDK 迁移被选定**：固定版本，在现有 createMcpClient/listTools/callTool/close 接口后做最小适配，复用现有故障 fixture；验证单帧 1 MiB、stderr 4 KiB、忙时拒绝、超时/断线结果不明、目录变化后授权只缩不扩、暂停保留、退出清理及一次性包装兼容。SDK 缺失的保护只在最小适配边界补齐；若需要维护 SDK 分叉或重复一套协议解析，重新评估迁移成本。全部通过后才替换正式路径并删除被替代的协议实现，不长期维护双实现。

设计验收：本轮只调整 PLAN.md；不改变运行接口、依赖与权限。后续工作以真实需求和上述验收证据为入口，已完成的有界接收与会话连续性测试继续作为回归资产。

## 已观察、待处理问题

- 外部 MCP dryRun 信任边界（P65 代码审阅确认）：写入门会向外部 server 发送 `dryRun: true` 取得预览，但当前 host 无法验证 server 是否无副作用；对未核实的外部写入工具，不能声称逐笔询问提供无副作用预览。后续若要支持这类工具，先明确预览能力与失败关闭策略。
- 真实站点验证限制：P28 目前只有真实站点健康基线和 mock 故障样本；真实改版失败样本尚未出现，届时仍需采集并补回归。

### 新增候选（来自 P29 试点发现）

- ~~include 参数在「单文件 path」search 下被静默忽略~~（P66 已按选项二解决：单文件分支同样应用 include，文件名不匹配时返回 no matches 并注明被过滤，与目录递归同语义）

### 产品拓展方向（待验证）

以下是按当前讨论排序的候选方向，不代表已确认需求或既定缺陷。原优先级 1 的故障排查和优先级 4 的文本目录问答已完成，见 P23、P24。实施前应选择一个边界清晰的场景，建立可复现样本，并沿用现有 Host Root、只读能力、受限运行和协议兼容约束。

| 优先级 | 方向 | 用户能得到什么 | 最小落地点 |
| --- | --- | --- | --- |
| 2 | **代码与文档核查** | 回答“文档说的行为，代码真的实现了吗？”“这项改动影响哪里？” | 增加核查模板，要求区分已验证事实与推测 |
| 3 | **只读项目体检** | 找出过期说明、缺少测试的关键路径、明显不一致之处 | 输出按影响排序的发现清单，每项带证据 |
| 5 | **跨网页模型复核** | 让第二个模型检查第一份结论中的证据和遗漏 | 先做由用户触发的单次复核，复用现有 Receipt |

### 开源强化候选（2026-09-27 调研定向，方向已获用户确认；第 1、2 序已由 P52/P54 交付，P55 补齐第 2 序的敏感过滤，其余未实施）

排序依据：本轮开源调研确认项目能力上限受三个结构性短板约束（消费级模型端点、DOM 通道迭代速度、网页线程上下文不受控）。开源可强化的是其中可救的两条——每轮给模型的信息密度、长线程退化——以及经现有 MCP 桥接零代码扩工具；端点质量一条开源救不了，不在候选内。browser-use/stagehand（现有 page-driver + P47 元素引用纪律已覆盖主痛点、且为重型依赖）与网页转 API 的逆向项目（用户未选 facade 方向，ToS 风险前置）评估后不列入。

接入写入类工具构成 P35 记录「未经用户决定不实施」所需的方向决定（用户 2026-09-27 已确认想做，含开写门），但实施仍逐轮走"先证据后实现"；写入门控轮落地前须同步修订 AGENTS.md「不新增文件写入入口」边界条款。外部 server 沿用 P50 先例：npm 全局安装固定版本、由用户 `--mcp` 指定，仓库零新增依赖。

| 建议顺序 | 方向 | 来源与证据等级 | 最小落地点与验收要点 |
| --- | --- | --- | --- |
| 1（P52 已完成） | Git MCP server 只读接入 | 官方 reference 核实为 Python 包且 repo_path 可覆盖作用域 → 改自带实现 | 已交付 `demo/mcp-git-server.mjs`（四只读工具、作用域启动冻结）；现场验收与证据见 P52 记录 |
| 2（P54 已完成） | Filesystem MCP server 只读接入 | 官方包 2026.8.31 实际 14 工具（10 只读 + 4 写入），无工具级只读开关，只读靠允许列表圈定 | 已交付 README 接入节（固定版本 + 九只读授权 + 敏感路径不过滤警告）；探测与现场验收见 P54 记录 |
| 3（P58 已完成） | repo-map 式符号地图 | aider repomap：tree-sitter 抽符号 + 引用图排序 + token 预算（官方文档声明，源码未逐行核实） | 已交付 `demo/mcp-map-server.mjs`（零依赖启发式抽符号、read 行号同坐标、出现次数排序、字符预算）；按 P57 清单核对，证据见 P58 记录 |
| 4（P59 已完成） | watch 线程压缩续接 | gemini-cli `/compress` + 阈值自动压缩（Apache-2.0，文档/更新日志声明）；本项目有意去掉自动触发，全程人在环 | 已交付 REPL 压缩/保存摘要 + --new 注入三件套；证据见 P59 记录（真实站点链路待用户验证） |
| 5（P60/P61 已完成） | 写入门控 | Codex 式分级审批；载体为自带 fs server 写入工具 | 已交付：默认逐笔询问、风险询问、自动批准、禁止；server 层 dryRun/备份/敏感拒与会话撤销；证据见 P60/P61 记录 |

轮次编号以实际执行为准（复审修复轮可能插入，如 P48→P49、P50→P51 先例）；每轮仍按"读取现状 → 单一边界改进 → 证据先行 → 测试与冒烟 → 独立提交"闭环执行。

## 已完成

- P66 三项安全与正确性修复（本轮；2026-09-30）。
  - ①undo_write 收编写入门控（`9665207`）：P65 审阅确认的缺口——`undo_write` 不在 `MCP_WRITE_TOOLS`，模型获目录授权即可绕过审批撤销文件；且 server 的 undo_write 原先不接收参数，门控发出的 `dryRun:true` 会真实执行撤销、确认后再连退一笔。修复：host 清单收编 `undo_write`/`undo`（fail-closed）；server 的 undo_write 支持 dryRun 纯预览（只报告将撤销哪一笔，不弹栈不落盘），schema 同步。测试先失败后转绿（dryRun 预览不触发确认不弹栈、确认后恰好撤销一笔空栈报错；真实清单 allowWrite 关闭时拒绝且文件不变）。
  - ②search 单文件 include 过滤（`92b37e4`）：P29 试点确认 include 在目录递归生效但单文件 path 被静默忽略。按「过滤语义统一」方向修复：单文件分支文件名不匹配 include 时返回 no matches 并注明被过滤；未传 include 行为不变。两分支回归先失败后转绿。README 措辞本就覆盖单文件，无需改动。
  - ③切换审批模式收回会话同意（`ba56f89`）：会话同意过的工具此前除重启进程外无法收回，切换到更严模式（风险询问/逐笔询问/禁止）后仍完全跳过确认。修复：`write-gate` 新增 `resetApprovals()`，cli 三个切换分支（允许写入/禁止写入/写入模式 X）接线调用并在输出列明被收回的工具。文档同步 `docs/agents/mcp-watch.md`（含移除 undo_write 缺口条目）与 README。
  - 验证：三项各自定向测试先失败后转绿；`npm test` 243/243；五条浏览器冒烟通过。真实站点写入审批链路（含本次 undo_write 审批与模式切换收回）仍待用户现场验证。
- P64 本地改名 Chat2Local：包名、可见提示、标签页、自动回填和求职文档统一；旧状态目录与请求头保持稳定，公开仓库未改名或同步。单测 239/239、五条浏览器冒烟通过。
- P63 求职展示文档：README 顶部改为项目定位、无账号演示、真实模型记录的入口；`docs/PORTFOLIO.md` 提供一分钟介绍、调用链、技术决策、面试演示和限制；`docs/SHOWCASE.md` 串联测试层次。`README` 纠正 Host 动作“纯函数”、`run` 可执行 `npm test`、“没有写入能力”以及专用浏览器等同系统隔离等旧表述；无运行代码改动。测试 239/239、五项浏览器冒烟通过。公共 GitHub 版本仍旧，未发布。

- P61 Codex 式分级写入审批（逐笔询问默认 + 风险询问 + 自动 + 禁止；持有调用不耗模型轮次；diff 预览 + undo_write 撤销）；测试 239/239、五条冒烟。证据见下方记录。
- P60 交付 MCP 写入门控与 fs server 写入工具（会话级开关，已被 P61 分级审批取代语义）；测试 233/233、五条冒烟；真实站点链路待用户验证。证据见下方记录。
- P59 watch 线程压缩续接（压缩/保存摘要/--new 注入三件套，人在环）；测试 232/232、smoke:watch；真实站点链路待用户验证。证据见下方记录。
- P58 repo-map 式符号地图 server（JS/TS/Python 启发式 + read 行号同坐标 + 出现次数排序 + 预算；P57 清单五项逐项核对）；测试 229/229、smoke:watch、现场验收含行号坐标一致性链路。证据见下方记录。
- P56 修复 P55 代码审核问题：请求与真实路径双重过滤、越界联接元数据隔离、同句柄 1 MB 读取及全文 NUL、隐藏数量提示；测试 223/223、五条浏览器冒烟通过。未重新进行真实网页模型现场验收。
- P55 自带过滤版文件 server（敏感隐藏/拒绝、realpath 作用域冻结、越界拒、批量读逐项容错）；测试 218/218；现场验收含 .env 拒绝实链路。证据见下方记录。
- P54 官方 filesystem server 只读接入（README 接入节，零代码改动）；探测与现场验收证据见下方记录。
- P53 修复 Git server 审核问题：敏感状态/补丁过滤、Git 外部扩展与可选索引写入禁用、有界流式接收及错误回填；测试 213/213、五条浏览器冒烟通过。未重新进行真实网页模型现场验收。
- P52 自带只读 git server 四工具（作用域启动冻结）+ 目录上限 12 + dev-root 内层 git fixture；测试 209/209、五条冒烟、dev-root task 线程三次自构造调用全部回填且仓库零变化。代码验收由用户负责。
- P51 将 P50 脱敏现场记录纳入版本控制并补齐独立复跑步骤；原始 `.log` 仍只在本机，完整动作参数和 server 内部握手次数未保存，见下方记录。
- P49 已修复 P48 审核结论：常规 MCP 日志只显示固定参数名，省略所有参数值和其他字段名；P48 现场记录经人工脱敏后存入 `docs/runs/P48-field-run.md`，并明确可复核范围。
- P48 task 角色曾在专用测试聊天完成真实模型浏览器任务重跑；原始日志当时未入库，P49 才将脱敏记录纳入版本控制。
- P47 已修复 P46 现场验收与重连语义缺口：重连消息按实际建连时序描述旧状态失效；提交真实外部浏览器 MCP 的可重复验收脚本，修正文档与现场记录的命令和证据范围。

### P64：本地展示名称改为 Chat2Local

- 范围：`package.json` 与锁文件改为 `chat2local`；CLI 帮助和日志、控制台、浏览器标签页、MCP client 元数据、发给网页模型的新回填与重连文案、README 和求职文档统一展示 Chat2Local。
- 兼容：`node src/cli.mjs` 命令、`~/.file-tool` 登录资料与断点、`X-File-Tool-Token` 控制台请求头、历史聊天内容和公开仓库 `focus-zyw/file-tool` 保持原样；mock 同时识别新旧回填前缀。未移动目录或发布代码。
- 证据：`npm test` 239/239；`npm run smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 均通过。watch 冒烟将旧聊天标题设为 `〔file-tool〕旧聊天`，确认 `markTab` 更新为 `〔Chat2Local〕旧聊天` 后继续完成动作与回填。控制台旧标题断言导致的首次冒烟超时已修正并重跑通过。

### P62：压缩摘要结构化分节模板（上一轮）

- 动机与定位：P59 的 `compressPayload` 只列三类内容（目标/事实与结论/步骤），摘要结构靠模型自由发挥，新线程开场信息密度不稳定。调研 pi（earendil-works，本地 D:/git-project/pi）coding-agent 的 compaction 设计后，把其结构化摘要模板吸收进提示词：pi `SUMMARIZATION_PROMPT`（packages/coding-agent/src/core/compaction/compaction.ts）用固定小节 Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context，并要求「每节简短、原样保留文件路径/函数名/报错信息」。借鉴模板与纪律；**不借鉴其阈值自动触发**——P59 已论证本项目保持人工触发与人在环。
- 改动面：仅 `src/protocol.mjs` 的 `compressPayload` 文案 + `tests/protocol.test.mjs` 关键词断言；存档（保存摘要）、`--new` 注入、watcher `extractSummaryFence` 捕获链路零改动。七小节中文组织（①目标 ②约束与偏好 ③进度 ④关键决策 ⑤下一步 ⑥关键上下文 ⑦涉及文件），空节写「无」不省略（pi 的 "(none)" 惯例）；⑦对应 pi 摘要附带的 read-files/modified-files 清单，让新线程免于重复摸结构；⑥要求相对路径:行号，与内置 read 行号坐标一致。
- 自保护两条：软性 2000 字符预算（摘要经 `summarySection` 原文注入开场白，防注入段膨胀新线程开场）；摘要内禁再嵌套 ``` 围栏（`extractSummaryFence` 懒匹配到首个闭合围栏，内嵌围栏会把捕获截断，提示词先行约束，捕获函数本轮不改）。
- 边界与未验证：模板对三角色共用同一条提示词（P59 形态如此，未按角色分化）；真实站点「压缩→保存→--new 注入」链路自 P59 起仍待用户现场验证，本轮不改变该状态；摘要内容仍只存用户确认过的文本，只存本机 threads.json。
- 验证：protocol 定向 20/20（新增 9 条分节关键词断言），`npm test` 239/239；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五条全过。代码与证据验收由用户执行。

### P61：Codex 式分级写入审批（本轮）

- 动机：P60 交付后用户提出三点——会话开关粒度太粗（同意一次全部放行）、拒绝后模型重发浪费一轮输出、缺 diff 查看与撤销。参考 Codex 审批模型重构。
- 设计映射：`变更文件时询问`→逐笔询问（默认）；`帮我批准`→确认框第三选项「会话同意」（记住该工具本会话不再询问）；`对检测到的风险操作请求批准`→风险询问模式；`完全访问`→自动批准（**刻意差异**：本项目沙箱——授权根、敏感路径、越界、符号链接、二进制覆盖保护——是硬边界，不随审批模式放宽）。P60 的 允许写入/禁止写入 保留为 自动/禁止 的兼容别名。
- 关键语义改进——**持有而非拒绝**：确认期间调用在 execAction 内 await（与 Claude Code 逐审批停下的形态相同），同意后同一调用直执，模型侧只是感受到延迟、不消耗轮次；只有拒绝才回填一次告知。终端输入经 REPL 循环路由（挂起时 同意(y)/会话同意(a)/拒绝(n) 优先，其余输入提示先处理确认）；确认期间 Ctrl+C 退出走既有断点恢复纪律。P60 担心的"阻塞快照轮询"在此形态下可接受：回复已标记 processed 不会重复处理，页面不会因此变化。
- 实现：①`src/write-gate.mjs`（新，可测门控核）——intercept 决策（deny→null 走 host 门控统一文案；auto/会话同意→直执；ask/risk→先 dryRun 预览再 confirm 注入决策）；dryRun:true 调用直通（纯预览零副作用，模型自查不被确认打断）；dryRun 失败（敏感/越界等确定性错误）直接回填不打扰确认；无 dryRun 的外部写工具按保守处理（视为覆盖已有内容需询问）。②server（`demo/mcp-fs-server.mjs`）——dryRun 输出改为首行 `风险: 新建|会话内已写|覆盖已有内容|无变化` + LCS 行级 diff（±1500 行上限，超限显示规模；新建显示前 40 行预览）；会话内写入跟踪 + 撤销栈（50 笔）；新工具 `undo_write`（覆盖型恢复原内容/新建型删除/建目录型非空拒绝并保留记录；模型可调用但同受写门控）；二进制文件拒绝覆盖；create_directory 支持 dryRun。③cli——写入模式 命令（询问|风险|自动|禁止，含 完全访问/帮我批准 等价映射与当前状态显示）、撤销写入 命令（host 直调 server undo，不占模型轮）、REPL 确认路由、目录含写工具时启动提示。
- 验证：新增 `tests/write-gate.test.mjs` 六例（真实 server client + 假 confirm）——ask 同意直执且预览含风险分级与 +/- diff；拒绝不落盘且回填原因、会话同意后不再询问；risk 模式新建/会话内自动、仅覆盖预置文件询问；auto 全放行、deny 由 host 门控拒绝、dryRun 敏感路径失败不打扰确认；undo 覆盖恢复/新建删除/空栈报错；create_directory 风险分级 + 非空目录撤销拒绝。定向 6/6，`npm test` 239/239（P60 旧 dryRun 文案断言同步更新），五条浏览器冒烟全过。真实站点写入确认链路待用户现场验证。代码与证据验收由用户执行。
- 文档：AGENTS.md 门控条目改写为分级审批；README 写入节重写（四模式语义、持有直执、undo、沙箱不放宽声明）。

### P60：MCP 写入门控 + 自带 fs server 写入工具（本轮）

- 设计定案（用户 2026-09-27 决定开写门）：借 codex「沙箱模式×审批策略」二维模型——Host Root/授权根与允许列表是既有第一轴，本轮补第二轴（何时需要人点头）。采用**会话级开关**而非逐写阻塞确认：执行循环内等待终端输入会阻塞快照轮询、把 watcher 拖进不可中断状态；两段式（写请求被拒并回填提示 → 用户确认 → 模型重发同一调用）在保持人在环的同时不阻塞循环，语义与回填重试/断点纪律正交。
- host 层（`src/host-actions.mjs`）：`MCP_WRITE_TOOLS` 固定清单 + `isMcpWriteTool` 按名匹配（write_file/edit_file/create_directory/move_file 及常见短名）；`mcpAction` 在允许列表校验之后新增 `allowWrite` 检查——默认 undefined 视为拒绝（fail-closed，旧调用方无需改动即获得门控），清单外工具按只读处理。拒绝回填文本写明开放方法，模型可在下一轮引导用户操作；拒绝发生在连接调用之前，不产生任何副作用。
- cli 层（`src/cli.mjs`）：REPL 新增 `允许写入`（allow-write）/`禁止写入`（deny-write）命令，切换可变的 `allowWrite` 会话状态（execAction 闭包按引用读取，启动时常量不变）；开放只对本 watch 进程有效，退出即失效，默认重新关闭。
- server 层（`demo/mcp-fs-server.mjs`）：新增 `write_file`（dryRun 预览不落盘；覆盖前同目录 `.bak` 备份只留一代；1 MB 上限；符号链接目标拒绝）与 `create_directory`（幂等）；`resolveTarget` 新增 `createMode`——目标自身允许不存在，自底向上定位最近存在的祖先做越界/敏感复核后按前缀关系拼回，最终路径仍不得逃出授权根；写入工具目录项无 readOnlyHint 注记。
- AGENTS.md 修订（随用户决定生效）：「不新增文件写入入口」条款收窄为「host 四动作保持只读不变」，新增 MCP 写入门控条目（固定清单、fail-closed、会话级、dryRun/备份硬要求、无 dryRun 的外部写工具接入前须评估）。
- 验证：host-actions 新增 1 例端到端回归（默认拒/不落盘 → 只读不受影响 → 允许后落盘 → 覆盖留 .bak → dryRun 不落盘 → 收回再拒 → 开放下敏感/越界仍拒）——定向 41/41，`npm test` 233/233，五条浏览器冒烟全过。真实站点写入链路（模型请求写入→用户开放→重发执行）未现场验证，留待用户在 dev-root task 线程实测。代码与证据验收由用户执行。
- README：fs server 章节后新增「写入与写入门控」小节（双层门模型、会话级边界、git server diff 审查配套建议）。

### P59：watch 线程压缩续接（本轮）

- 动机与定位：开源强化候选第 4 序。三个结构性短板中唯一能抢回上下文控制权的一项（gemini-cli `/compress` + 阈值自动压缩的借设计版）：网页线程越长质量越退化、且线程不受工具控制；压缩续接把旧线程状态搬进新线程。与 gemini-cli 的差异是有意为之——**不自动触发、不自动发送**：本项目 watch 是人在环形态，阈值自动压缩会把"换线程"这种可见性极低的动作变成无人值守行为，与断点人工核对纪律冲突；改为用户经 REPL 三步手动完成。
- 三件套：①REPL `压缩`（compact）——发 `compressPayload`（要求模型输出 ```summary 围栏摘要、不调用任何工具），watcher 新增 `onSummary` 回调捕获围栏内容（新私有函数 `extractSummaryFence`，只认 summary 语言标签），捕获后仅提示待确认；②REPL `保存摘要`（save-summary）——确认后才 `saveSummary` 存入线程登记（threads.json 同 key 扩展字段 summary/summaryAt，原子写入复用现有 save；无登记线程时拒绝），未确认可忽略或重新压缩（pendingSummary 单槽，防覆盖）；③`watch --new` 消费——`takeSummary` 取出即清除（一个摘要只注入一次），随开场白经 `summarySection` 注入新线程，三角色开场白均支持（conversationIntroPayload 新增 opts.summary 透传，协议正文未动，protocol 既有关键词测试全部保持通过）。
- 安全边界：摘要内容只存用户确认过的文本、只存本机 threads.json、注入时开场白自带「事实来源仍以本对话与实际工具结果为准」防模型把摘要当权威；旧线程登记被新线程覆盖（与 --new 既有语义一致，原线程仍在网站可手动回看）。
- 验证：state 摘要存取 1 例（取出即清除/无线程拒绝/角色隔离）、protocol 1 例（compressPayload 形态 + 三角色注入 + 空白摘要不注入）、watcher 1 例（summary 围栏走 onSummary 不走 onReply、同回复只处理一次）——`npm test` 232/232；`smoke:watch` 通过。**真实站点三步链路（压缩→保存→--new 注入）未现场验证**，mock 页剧本不含压缩分支；留待用户在 dev-root task 线程实测。
- README：watch 章节新增「压缩续接」小节（三步流程、人在环边界）。

### P58：repo-map 式符号地图 server（本轮）

- 动机与定位：开源强化候选第 3 序。aider repo-map 的两个思想（符号级压缩视图、预算控制）以零依赖方式落地——行级启发式替代 tree-sitter（不引依赖），标识符出现次数替代引用图排序（轻量近似）。价值主张：替代「反复 ls + read 摸结构」的多轮往返，地图行号直达 read 行级精读。
- 实现（`demo/mcp-map-server.mjs`，单工具 `symbol_map`）：支持 `.js/.mjs/.cjs/.ts/.tsx/.jsx/.py`；JS 用正则 + 类体缩进状态机（`function`/`class`/函数值 `const`/类方法含 static/async/get/set 修饰符），Python 用缩进区分方法与顶层函数（async def 支持）；注释行不产符号；输出每文件一行 `rel: L3 fn alpha ×3 · L7 class Widget · L11 method run(Widget)`。预算默认 4000 字符（`maxChars` 500–7000 可调），被引用最多的文件先进预算；`path` 参数限定子目录。输出注明「行号以 read 实读为准」的启发式边界。
- P57 清单逐项核对：①授权路径——请求/真实路径双重敏感与越界核对（P56 同款 `withinRoot` 模式），相对/绝对/多根/`..`/根内外联接语义明确，`path` 子目录同样过双重核对；②全部输出——地图只含代码文件名与符号名，敏感路径/凭据内容不可进输出，合成凭据回归锁定；③只读副作用——无子进程，纯 fs 读取；④有界读取——单句柄 `fstat` 后最多读 1MB+1 字节，逐段查 NUL（含 NUL 视为二进制跳过），`O_NOFOLLOW`/`O_NONBLOCK` 平台可用即启用，输出 7000 字符封顶；⑤完成证据——隔离目录假凭据，覆盖行号精确断言、引用计数排序、子目录限定、预算截断（下限钳 500）、联接绕过、合成凭据不可见、非代码目录拒启。
- 自查修复的缺口：目录遍历（walk）原本会跟随符号链接/目录联接——无邪名联接指向 `.ssh` 时敏感文件可进地图；已改为 `isSymbolicLink()` 不下钻，并有「根外联接指回根内被请求路径核对拒绝」「根内联接指敏感目录被真实路径核对拒绝」「默认遍历不含联接内容」三重回归。开发中还修了类方法正则未剥缩进导致方法永不匹配的 bug（fixture 行号断言当场逮住）。
- 验证：定向 6/6，`npm test` 229/229，`smoke:watch` 通过。现场验收（dev-root task 线程续接，自然语言任务未提供 host JSON）：目录同步 1 工具后模型自构造 `symbol_map` → **内置 `read`（line 参数）**两次调用全部回填——正是设计目标链路「地图行号 → read 行级验证坐标一致」，最终 806 字符结论无动作块；验收后内层仓库与验收前一致（仅预置 `M scratch/git-check.md`）。结论文本未存档（沿 P50 惯例）。代码与证据验收由用户执行。
- README：新增「自带符号地图 server」节（repo-map 式定位、坐标约定、排序与预算、启发式边界说明）。

### P56：文件 server 路径与读取边界修复

- 审核复现：根内 `.ssh` 目录联接指向普通目录时显式读取/元数据查询未拒；根外链接指回根内也会被接受；`list_directory(withSizes)` 对根外联接执行 `stat`；仅含 `.env` 的目录丢失隐藏提示；NUL 位于第 8193 字节时被当成文本。原实现的大小检查与 `readFile` 分离，文件并发增长时不保证 1 MB 读取上限。
- 修复：请求路径和真实路径均核对敏感名称及授权根；子项大小只对普通文件用 `lstat`，不跟随链接；批量读取在同一文件句柄上先检查类型/大小，再最多读 1 MB + 1 字节并逐段检查 NUL，单项读取错误保持逐项回填；空目录分支仍附隐藏数量。支持的平台另用 `O_NOFOLLOW` / `O_NONBLOCK` 缩小链接替换与特殊文件阻塞风险。未改工具目录、授权和会话协议。
- 验证：新增五例隔离目录回归，覆盖两类请求路径联接、纯敏感目录、越界联接大小查询、恰好/超过 1 MB 与后段 NUL。定向 10/10，`npm test` 223/223；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 全过。后续候选仍按上方开源强化顺序推进，真实网页模型现场任务本轮未重跑。

### P55：自带过滤版文件 server

- 动机与方案：P54 审阅确认官方 filesystem server 没有敏感路径过滤（授权目录内 `.env`/私钥照常读出）。评估三方案（自带实现 / 定向代理守卫 / 仅圈目录纪律）后按用户决定采用自带实现——与 P52 git server 同构：过滤属于 server 自身语义，不碰「工具入参对 host 不透明」的桥接边界；代理守卫的 schema 漂移风险高于自维护的 fs 薄封装。
- 实现（`demo/mcp-fs-server.mjs`，零依赖）：四只读工具 `list_directory`（可选 withSizes）/ `directory_tree`（深度≤6、上限 400 项、依赖/构建目录不展开）/ `read_multiple_files`（最多 10 个，逐项容错）/ `get_file_info`。敏感语义与 host 动作同源：复用 `isSensitivePath`（`.env.example` 等示例名不误伤）——列举隐藏并提示隐藏数量、显式读取/元数据拒绝；`LS_IGNORED_DIRS` 直接从 host-actions 导入避免两处漂移。授权根启动时 realpath 冻结，符号链接/目录联接逃逸与越界一律拒绝；相对路径按第一个根解析（与启动 cwd 无关）；单文件 1MB 上限、二进制检测（NUL）不读、输出 7000 字符截断（低于桥接端 8000，提示不被切掉）。
- 测试（`tests/mcp-fs-server.test.mjs` 五例）：列举与树隐藏敏感项但保留 `.env.example`；批量读逐项容错（正常读出/敏感拒绝/越界拒绝/缺失报错共存一批）；元数据敏感拒绝与多根 `[R2]` 标签；超大输出截断含提示；授权目录不存在启动即退出。定向 5/5，`npm test` 218/218，`smoke:watch` 通过。
- 现场验收（dev-root task 线程续接，自然语言任务未提供 host JSON；任务显式要求尝试读 `.env`）：目录同步 4 工具后模型自构造 `directory_tree` → `read_multiple_files` ×2（第二次即 .env 尝试），全部 → ok 逐轮回填——批量读对敏感项按设计**逐项报错而整批成功**（`✗ 已拒绝：敏感路径不通过本工具暴露` 回填给模型），最终 1112 字符结论。只读硬证据：验收后内层仓库与验收前一致（`## master`、仅预置 `M scratch/git-check.md`），`.env` fixture 内容逐字未变。结论文本未存档（沿 P50 惯例）。
- fixture：`dev-root/.env` 为标注清楚的假凭据（随仓库提交；内层 fixture 仓库同步提交），专供过滤验证——自带版必须隐藏/拒绝它。
- 运维记录：首次启动被资料目录占位守卫拒绝（P54 后台会话尚在预埋收尾期内，按设计不并行、不杀进程），等其优雅退出后重试成功。
- README：新增「自带过滤版文件 server」节（推荐日常用法，无需 --mcp-allow），官方 server 节补「需要凭据过滤时改用自带版」指向；官方接入保留作为兼容性证据（P50 之于 chrome-devtools-mcp 的同款定位）。代码与证据验收由用户执行。

### P54：官方 filesystem server 只读接入（上一轮）

- 动机：开源强化候选第 2 序；并按 P53 收尾指示「届时先核对同类敏感路径与外部执行边界」执行两项核对。
- 边界核对：①敏感路径——官方 server 没有 host 动作那套敏感文件名/凭据过滤，授权目录内的 `.env`、私钥会被照常读出，授权目录是唯一边界，已作为显著警告写入 README；②外部执行面——该 server 为纯文件系统实现（读/列/stat），不存在 git server 曾暴露的 diff.external/textconv 类外部程序触发路径，无需额外处置。
- 接入（零运行时代码改动，见 README「外部 server：官方 filesystem server 只读接入」节）：固定版本 `@modelcontextprotocol/server-filesystem@2026.8.31` 全局安装，`--mcp` 指向其 `dist/index.js`（P50 同款 node 直跑接法，仓库零新增依赖）；`--mcp-allow` 显式圈九个只读工具。必须显式圈定的原因：不圈会默认授权目录前 12 个、包含四个写入工具——等于接入非只读 server（扩权，需用户明确决定）。`read_file` 为 `read_text_file` 旧别名，语义重复不重复授权。
- 探测（2026-09-27，自有 client）：该版本实际 14 工具（10 只读 + 4 写入，比此前 README 推断多一个 read_file 别名）；九个只读工具目录行 180–345 字符全部可渲染；`directory_tree`/`read_multiple_files`/`get_file_info` 真实调用成功；越界读 `C:/Windows/win.ini` 被 server 拒绝——作用域启动冻结由官方实现自身保证。
- 现场验收（dev-root task 线程续接，自然语言任务未提供 host JSON）：目录同步 9 工具、5 个未授权工具（read_file + 四写入）正确列出后，模型自构造 `directory_tree` ×2（含不同参数形态）→ `read_multiple_files` → `get_file_info` 四次调用，全部 → ok 逐轮回填（参数日志脱敏），最终 1074 字符结论无动作块。只读硬证据：验收后 dev-root 内层仓库与验收前完全一致（`## master`、仅预置 `M scratch/git-check.md`、3 条 fixture 提交，无任何新增改动）。结论文本未存档（沿 P50 惯例）。
- 验证：`npm test` 213/213（本轮未改运行代码，仅 README）。代码与证据验收由用户执行。

### P53：Git server 只读边界与有界回填修复

- 审核与复现：隔离仓库中受跟踪的 `.env` 差异会泄露合成凭据；`diff.external` 和 `core.fsmonitor` 可触发写文件程序，普通 `git status` 会刷新索引；5 MiB 差异超过原 4 MiB `maxBuffer` 时返回错误而非截断；失败 stderr 未限长可使客户端进入结果不明。
- 修复：状态与差异先读取 Git 的 NUL 分隔路径清单，复用 `isSensitivePath` 过滤；重命名来源或目标敏感时隐藏整项差异。Git 调用不继承 `GIT_*` 环境，禁用外部 diff、textconv、fsmonitor 与可选索引写入。stdout/stderr 持续排空且只保留有界前缀，成功与失败均限制回填长度；工具签名、授权目录与会话生命周期未改。
- 验证：新增四例隔离仓库回归，覆盖暂存/未暂存敏感补丁、敏感文件改名、外部扩展与索引不写入、超过 4 MiB 的差异按上限截断。定向 8/8，`npm test` 213/213；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 全过。后续候选仍为只读 Filesystem server 接入，届时先核对同类敏感路径与外部执行边界。

### P52：自带只读 git server 接入 + 工具目录上限放宽

- 动机与决策：开源强化候选第 1 序。实施核实修正候选前提——官方 reference git server（modelcontextprotocol/servers/src/git，2026-09-27 核查）是 Python 包（uvx/pip 分发，npm 无包），且允许调用时传 `repo_path` 覆盖作用域，与本项目「server 与作用域由用户启动时决定、模型不可选」的信任边界冲突，改为仓库自带零依赖 Node 实现。
- 实现（`demo/mcp-git-server.mjs`）：四个只读工具 `git_status` / `git_diff_unstaged` / `git_diff_staged` / `git_log`；仓库路径启动时冻结（缺省取 Host Root，可 `--mcp-arg` 指定），工具入参一律不接受路径；模型字符串永不进入 git argv——`git_log` 仅 max/skip 两个数字参数，经消毒与上限钳制；git 非零退出按普通工具失败回填（isError，连接不中断）；输出 7000 字符截断并提示（低于桥接端 8000，为截断提示留余量，避免提示本身被桥接端切掉）；启动即 rev-parse 校验，非 git 目录直接退出（桥接按探测失败降级、不注入执行器）。
- 上限放宽（用户当轮指示，独立提交 86be084）：`MCP_TOOLS_MAX` 4→12，为候选第 2 序 Filesystem server（9 只读工具）铺路；README、帮助文案与目录闭环测试同步改引常量；「展示=授权=执行」不变式与授权冻结语义未动。
- 测试：新增 `tests/mcp-git-server.test.mjs` 四例——真实常驻 client 全链路（四工具/状态/两个 diff/log 对真实临时 git 仓库断言）、参数消毒与作用域冻结（`max:"3; rm -rf /"`、`repo_path`、未知参数不改变结果；`git_commit` 被拒）、超大输出截断含提示、非 git 目录握手失败。`npm test` 209/209；五条浏览器冒烟全过。
- 现场验收（dev-root task 线程续接，自然语言任务，未提供 host JSON）：能力更新同步 4 工具目录后，模型依次自构造 `git_status` → `git_diff_unstaged` → `git_log`，三次全部 → ok 并逐轮回填（终端参数日志脱敏），最终 874 字符结论文本无动作块。只读性硬证据：验收后内层仓库与验收前完全一致（`## master`、仅预置的 `M scratch/git-check.md`、3 条 fixture 提交，无任何新增改动）。结论文本未存档（沿 P50 惯例）。本轮代码与证据的验收由用户执行。
- fixture：dev-root 初始化为独立内层 git 仓库（机器本地；`dev-root/.git`、`dev-root/scratch/` 已入外层 .gitignore，`dev-root/.gitignore` 随仓库提交）。复跑：在 dev-root 重建内层仓库与未暂存改动后，按 README「自带只读 git server」示例启动 watch。

### P50：跨 server 兼容验证——chrome-devtools-mcp（本轮）

- 动机与结论：回答"同一套桥接机制能否服务第二个真实、独立的 MCP server"。答案成立——把 `--mcp` 指向 `chrome-devtools-mcp@1.10.1`（Google 官方，基于官方 TypeScript SDK，与 Playwright MCP 完全独立实现），同一 Lab 页的 打开/读标记/点击展开/复核/暂停恢复/evaluate 回报 全流程通过，模型按该 server 的工具目录自行构造调用。正式已验收场景仍为 Playwright MCP；本轮是兼容性证据，不替换默认场景。
- 接入过程：`npm install -g chrome-devtools-mcp@1.10.1`（固定版本，项目零新增依赖）；启动参数 `--headless --isolated`（isolated 自建并自动清理临时资料目录）；`--mcp-allow` 授权四工具 **new_page / take_snapshot / click / evaluate_script**——该 server 的工具形态与 Playwright 不同（导航必填 pageId、点击需 pageId+uid），故用 `new_page` 建页即导航、pageId/uid 从回填结果取，四工具恰好放进目录上限。自有 client 的互操作探测先行：握手协议 2024-11-05、30 个工具、四工具目录行全部可渲染。
- 现场验收（P49-CROSS-SERVER-VALIDATION PASSED；可跟踪的脱敏摘录 `docs/runs/P50-cross-server-field-run.md`）：dev-root task 线程重连续接；待命零调用；模型自构造 `new_page` → `take_snapshot` → `click` → `take_snapshot` → 暂停/恢复 → `evaluate_script` 五次调用全部 ok 并逐轮回填（动作片段按 P49 的值脱敏格式记录：参数键+省略计数，不含参数值）；beacon 取证恰好 load→expand→model-verify，同一会话 UUID（edb448f7…）、同一标记 LAB-m1k7b50c、detailsOpen false→true→true；退出后"本轮新建浏览器进程"检查 clean。原始 `.log` 仍仅在本机；复跑命令、任务范本及证据边界见摘录。
- 通过条件逐项：明确任务前零调用 ✔；模型独立构造合法调用 ✔（含跨 server 的 pageId/uid 方案适配，完整参数未存档）；同一页面会话仅加载一次、展开状态跨调用及暂停恢复保留 ✔；退出后本轮新建浏览器进程检查 clean，watch 收尾路径释放 server（日志没有独立保存 server PID 的退出检查）。server 就绪日志恰一次；握手次数=未独立测量（无握手仪表化，不以同 PID 推导）。
- 验证：`npm test` 205/205；本轮未改运行代码，未发生需要修复的失败（自有 client 互操作探测一次通过）。

### P51：修复 P50 审核的现场记录缺口（本轮）

- 复现：`git ls-files` 未列出 P50 引用的 `.log`，`git check-ignore -v` 命中 `.gitignore` 的 `*.log`；干净检出只有 PLAN/README 的结论，没有可核查的运行摘录。
- 修复：依据本地原始记录新增可跟踪的 `docs/runs/P50-cross-server-field-run.md`，保存五次调用及回填、暂停恢复、三条 Lab beacon、浏览器进程检查，并提供固定版本的 Node 入口及完整 watch 命令。README 与 P50 引用改指该文档；原始 `.log` 继续留在本机。
- 证据边界：终端未独立打印包版本或 Git SHA，复跑任务的逐字原文未存档；动作参数值和 `pageId`/`uid` 已脱敏，server 内部握手次数及退出 PID 未独立测量。上述内容在记录中逐项说明，不再用浏览器进程检查替代 server PID 证据。
- 验证：本地原始记录机器解析得到 `load → expand → model-verify` 三条、唯一 Lab 会话与标记、展开态 `false → true → true`；新文档静态检查未见本机用户路径、外部 URL、邮箱或凭据赋值，且包含复跑命令及五次调用；`npm test` 205/205；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 全部通过。
- 下一批候选仍为上方产品拓展方向；此轮只修复证据归档，不引入新的 MCP 能力。

### P49：修复 P48 审核结论（上一轮）

- 日志边界：`src/watcher.mjs` 的 MCP 动作日志及结果不明通知仅显示固定参数字段名 `url`、`element`、`target`、`function`，其余字段名只记数量，全部参数值省略；本地动作仍为 `op+path`。原先的 160 字符 JSON 前缀方案已撤销，避免任意 server 的凭据或会话数据流入常规日志和 `onFatal`。
- 回归样本：先以包含敏感值及敏感字段名的 `browser_click`/`browser_evaluate` 动作复现两条失败（普通日志、结果不明通知），再修复并验证不输出敏感内容；watcher 针对性测试 23/23 通过。
- 证据归档：保留本地忽略的原始 `.log` 不变，人工核对后新增可跟踪的 `docs/runs/P48-field-run.md`；文件含被测实现提交的来源说明、外部 server 固定版本及未独立测量的限制、可重放的 Lab/watch 启动步骤、自然语言任务、五次动作、暂停恢复、Lab beacon 和清理结果。不包含本机用户路径、浏览器资料目录或聊天地址。该文件是脱敏摘录，不能当作完整原始日志或模型内部决策记录。
- 验证：`npm test` 205/205；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五种浏览器冒烟通过；真实 `@playwright/mcp@0.0.82` 技术验收脚本通过（serverStarts=1、actionCount=6、load→expand→script-verify、sameSession/sameMarker、浏览器残留 0）。脚本动作由程序生成；真实网页模型任务仍以 P48 脱敏现场记录为证据。
- 审核三项待修条件已落实：日志不再输出不透明参数值、现场记录进入版本控制、复跑元数据已补齐；版本与提交的原始终端测量限制在记录中如实说明。后续 MCP 演进仍按需求触发。

### P48：真实模型任务的可复核证据（历史实现：cd4e6ea + 37d4218；审核缺口由 P49 修复）

- 原证据载体：watcher 曾在常规日志和结果不明消息中附 MCP 入参 JSON 前 160 字符；本地动作仍为 op+path。审核确认长度截断不能保护敏感值，P49 已移除参数值输出，原测试同步改为敏感值不外泄回归。
- 技术验收（脚本生成动作）：`scripts/verify-browser-mcp.mjs` 实跑通过（serverStarts=1、actionCount=6、beacon 序列 load→expand→script-verify、sameSession/sameMarker、浏览器残留 0），固定版本 0.0.82 由脚本断言。此项证明执行链路状态连续性；动作由验收程序生成，与下述真实模型证据分开标注。
- 真实模型现场验收（P47-FIELD-VALIDATION PASSED；P49 归档脱敏记录 `docs/runs/P48-field-run.md`）：DeepSeek，按 README 示例命令启动 `watch deepseek --root dev-root --role task`（四工具 `--mcp-allow` 授权，独立临时资料目录）；dev-root task 线程走重连路径，P47 修订后的重连消息（旧状态不可沿用、新会话以建连为准）实际送达。自然语言任务原文（仅描述目标，无 host JSON，不回传标记）：「明确任务（此前会话已失效，请重新打开页面）：用浏览器检查页面 http://127.0.0.1:8765/ 。①打开页面并读取「会话标记：」后面 LAB- 开头的标记和括号里的会话短 ID；②点击「展开详情」按钮；③再次读取页面，核对标记与会话短 ID 和第一次一致、详情已展开；④用 browser_evaluate 在页面里执行代码：读取 window.__lab 的全部字段，以 JSON 为 body、event 字段填 model-verify，POST 到本页 /beacon；⑤用 done 块给出结论与证据。每条回复只发一个 host 块。」
- 证据一（P48 历史日志中模型构造动作的最小片段与顺序；现行日志不再输出参数值）：`mcp browser_navigate {"url":"http://127.0.0.1:8765/"} → ok` → `mcp browser_snapshot {} → ok` → `mcp browser_click {"element":"展开详情 按钮","target":"e4"} → ok` → `mcp browser_snapshot {} → ok` → 暂停/恢复 → `mcp browser_evaluate {"function":"async () => { const lab = window.__lab ? JSON.parse(JSON.stringify(window.__lab)) : null; …"} → ok`。点击元素描述与引用、evaluate 函数体均为模型从页面快照自行构造。
- 证据二（Lab 会话标识与状态变化）：恰好 load→expand→model-verify 三条，同一 sessionUuid（a681634f…）、同一标记 LAB-e68r37f1、detailsOpen false→true→true——页面仅加载一次，前序交互状态被后续调用读取，暂停恢复后保持。
- 证据三（Host 启停与退出清理）：明确任务下达前工具调用为零（重连汇报回复 165 字符无动作）；「MCP server 就绪」日志恰 1 次；五次调用逐轮回填成功，done 总结 1060 字符；退出后按序清理，遗留进程检查 clean。日志仅含专用测试内容。
- 通过条件逐项：明确任务前零调用 ✔；模型独立构造合法调用 ✔（片段如上）；同一页面会话仅加载一次、展开状态跨调用及暂停恢复保留 ✔；退出后 server 与浏览器无残留 ✔。server 启动次数=1（可观测：就绪日志恰一次）；**握手次数=未独立测量**（客户端无握手仪表化，不以同 PID 推导；协议层握手一次由常驻回归测试的 stats.initializes===1 锁定）。
- 验证：watcher 片段日志测试；`npm test` 204/204；smoke:watch 全过。不新增另一套循环、日志平台或测试模式。

#### P48 审核结果（基线 4665b85...HEAD；本轮记录）

- **Standards：2 项 P1。**（1）`src/watcher.mjs` 将任意 MCP 参数 JSON 化并输出前 160 字符，且结果不明时随消息传给 `onFatal`；截断不等于脱敏，可能打印凭据、cookie 或会话数据，违反 AGENTS.md 禁止读取/打印凭据及会话数据的约束。（2）PLAN 声称现场日志已入库，但 `docs/runs/P48-field-run.log` 命中 `.gitignore` 的 `*.log`，并未进入 HEAD，干净检出无法取得证据。
- **Spec：2 项 P1、1 项 P2。**（1）P1：参数日志对所有 MCP 调用常开，超出本轮现场证据所需且未满足脱敏要求。（2）P1：现场记录未纳入版本控制，“运行记录入库”验收尚未完成。（3）P2：日志本身没有被测提交、外部 server 固定版本、可执行启动步骤和自然语言任务；方案要求运行记录包含这些信息，现有信息散落在 PLAN/README，日志无法独立复核。
- **已核对通过：**日志片段最长 160 字符、本地动作仍为 `op+path`、结果不明通知带片段；现场日志记录的五次动作顺序、暂停恢复、server 启动一次及握手“未独立测量”的表述与验收要求一致。代码气味基线无其他可行动发现。
- **审核验证：**`npm test` 204/204、`npm run smoke:watch` 通过、`git diff --check` 通过。以上验证确认现有行为测试通过，不代表前述安全与证据入库问题已解决。
- **结论（审核当时）：P48 待修复。**要求为日志参数建立脱敏/白名单策略、归档可跟踪的现场记录并补齐复跑元数据；P49 已完成相应修复与验证，见上方记录。

### P47：修复 P46 现场验收与重连语义缺口（上一轮）

- 重连消息：CLI 在 MCP 创建前发送重连消息，控制台也可能没有 MCP 配置；现只确认上次工具会话已结束、旧页面状态不可沿用，明确本次仅在启用并连接成功后才有新会话。协议测试锁定这两层语义。
- 可重复技术验收：新增 `scripts/verify-browser-mcp.mjs`，以全局安装的 `@playwright/mcp@0.0.82` 的实际 `cli.js` 路径启动本地 stdio server，使用独立临时资料目录和本地 Lab 页，真实经过 `runAction`、watcher、同一 MCP client 六次调用与 `stop.pause()/resume()`；断言待命零动作、四工具存在、页面一次 load、一次 expand、一次 script-verify、同一 UUID 与随机标记、展开态 false→true→true、退出后 server 已关闭且 Windows 外部浏览器进程数为零。外部 server 的快照也写入临时目录，脚本完成后统一清理。实际命令：`$mcpScript = Join-Path (npm root -g) '@playwright/mcp/cli.js'; node scripts/verify-browser-mcp.mjs --mcp $mcpScript`。最终实跑返回 `result=通过`、六次调用、server PID 5948、三条预期 beacon、浏览器残留 0。
- 证据范围：该脚本的动作由验收程序生成，证明真实外部工具与本项目执行链路的状态连续性；P46 的真实网页模型自行构造动作仍是当时的现场摘要，原始运行日志未入库，不能把本脚本称为模型行为的自动复现。README 已分别说明两种证据。
- 文档与记录：README 改为可执行的 PowerShell 命令，用 `npm root -g` 定位真实脚本路径、四次独立 `--mcp-allow`；P46 旧记录纠正包名简写和不存在的验收驱动声明，并将当轮控制台超时与测试通过记录分开表述。
- 验证：`node --test tests/protocol.test.mjs` 19/19；真实 MCP 脚本通过；本轮重新执行完整 `npm test` 203/203（无失败）和 `smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五种浏览器冒烟，全部通过。

### P46：浏览器会话工具正式接入（task 角色现场验收，上一轮；提交 9dbf216 + 4e7cb0b，提交信息里的"P45"编号指本轮）

- 方案输入：把已验证的 @playwright/mcp@0.0.82 接成项目第一个正式有状态工具场景——用户给网页检查任务，模型连续打开/操作/检查页面，暂停恢复后继续用原页面；不新建循环，全部复用现有机制。两个浏览器职责分离：聊天浏览器沿用专用资料目录；MCP server 及其浏览器由本轮 watch 独享（暂停保留、退出释放）。
- protocol（在 P45 的待命规则之上叠加）：taskIntro 增加会话型工具纪律——规则 9（操作前先读页面快照；页面变化后重新获取元素引用，不沿用旧引用；保持页面状态时不擅自刷新/重新导航/重建；暂停恢复后先检查当前状态再继续）、规则 10（结果不明时不重试点击/提交/写入等副作用操作，说明情况等待处理）；done 结论改为三分（已完成 / 失败 / 待人工核对）。task 重连消息说明旧标签页/元素引用/页面内存状态不可信；原文过早声称新工具会话已建立，已由 P47 修正。
- 接入说明（README）：固定验收版本 0.0.82 与独立安装命令；启动参数（--headless --browser chrome --user-data-dir 独立临时目录）；授权四工具及 evaluate 的范围说明（执行能力较宽，仅作本地验收授权项，日常网页检查按任务重选）；示例命令；清理顺序；边界声明（允许列表不限制导航网址，不据此宣称本地网站强制隔离）。
- 现场验收摘要（DeepSeek；实际 `--mcp` 参数为全局安装包 `cli.js` 文件路径，四个工具分别以 `--mcp-allow` 授权，完整可执行示例见 README；任务仅描述目标、无 host JSON、不回传标记）：①待命阶段开场白回复 26 字符纯文本、工具调用次数为零；②记录显示模型自行构造 browser_navigate → browser_snapshot → browser_click → browser_snapshot → 暂停 → 恢复 → browser_evaluate，调用及回填成功；③当时记录的 Lab beacon 为一次 load、一次 expand、一次 model-verify，同一会话 UUID（388b608a…）、同一标记 LAB-em08bgq7、detailsOpen false→true→true；④当时日志记录"MCP server 就绪"一次，退出后进程检查 clean。原始日志和验收驱动未随本提交保存，以上为现场摘要，不能用作独立复跑证明；P47 补交可重复的脚本验收。
- 验证：protocol 断言同步（会话纪律/结果不明不重试/done 三分/重连失效声明）；原轮次曾在完整测试中遇到两例控制台超时，隔离复跑通过，记录未区分随后是否再跑完整套件；五种浏览器冒烟记录为通过。P47 独立重跑完整单测和五种冒烟，证据见新增条目。
- 已验证范围声明：task 角色已接入真实浏览器 MCP，支持在一次 watch 生命周期内连续使用页面状态，并经过暂停恢复和退出清理验证；授权目录不限制导航网址，远程连接与交互式授权仍是独立需求。

### P45：修复 P44 代码复审问题（上一轮）

- 等待明确任务：task 开场白明确声明自身不是任务；网页模型在用户给出明确任务前只能确认待命，不得发送 host 块或调用工具。mock 剧本同步为先返回 `TASK-READY`，收到明确任务后才生成 read 动作。
- 冒烟证据：`smoke:watch` 在启动 task watcher 后先等待稳定窗口并断言动作数为零，再由用户消息送达明确任务；任务完成后断言 task 断点为 `processed`，并反向断言同线程的 code 断点键未被污染。
- 单一角色元数据：`ROLE_DEFINITIONS` 集中维护角色 ID、中文标签及 watch/控制台启动文案；CLI、控制服务 bootstrap 和控制台活动角色显示均从该定义派生，避免后续新增角色时遗漏其中一处。`ROLE_IDS` 保持原导出接口并由统一定义生成。
- 文档：README 的 watch 说明补齐 code/text/task 三种角色，明确 task 等待用户任务；线程章节补齐 task 独立登记、角色隔离断点及任一角色未确认时禁止跨角色绕过。
- 验证：针对性测试 57/57；完整 `npm test` 203/203；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五种浏览器冒烟全过。

### P44：watch 任务执行角色 --role task（上一轮）

- 方案输入：新增 task 角色复用现有 watch 机制，不新建执行循环、不单独 mcp-test 命令——MCP 测试只是该角色的使用场景；角色划分 code（导师）/text（文本问答）/task（连续调用工具完成明确任务）。后续外部 MCP 现场验证统一 `--role task --root dev-root`。
- protocol：`ROLE_IDS` 增补 task；新增 `taskIntroPayload`（仅 watch，chat 下抛错）——明确任务连续执行、按需取材料、工具自主选择（本地 + mcpOpLines 目录）、需要人工决定时停止等待、done 块要求 结论+可验证证据（路径:行号/命令与退出码/工具输出）并区分事实与推测；`feedPayload`/`reconnectPayload` 增加 task 变体（回填注记"收到结果后继续执行"，重连要求汇报任务状态且不自行开始动作）。
- cli：`roleIdArg(argv, allowed)` 作用域化——watch/console 支持全部角色，ask/chat 显式限制 code|text（ask 的代码任务本就是终态执行，task 不重复提供）；用法文案更新，watch 启动日志带角色。
- 独立登记免费获得：线程（threads.json）与 watch 断点本就以「站点+目录+角色」为键，task 与 code/text 互不污染；`assertOtherRoleClear` 跨角色未确认断点拦截自动生效。
- 复用不变：授权（允许列表）、常驻 MCP 会话、暂停/恢复、结果不明停止、收尾顺序全部走既有路径，watcher 零改动；与 P42 的 mcp-client 修复无文件交集。
- 控制台补全 task 下拉选项（P44 复审补遗）：bootstrap roles 数组加入 任务执行，启动日志与活动角色标签三态化；发现并修复 `assertOtherRoleClear` 的双角色硬编码——原实现 task 启动只会查 text 断点，现遍历全部其他角色，task 与 code/text 两两互拦（含反向断言：task 未确认时 code 启动被拒）。
- 验证：protocol 新增 task 开场白/回填/重连断言（含无教学纪律关键词的反向断言、chat 下抛错）；cli 新增 roleIdArg 作用域用例；mock 页新增 task 剧本分支；控制台测试新增 task 角色用例（下拉选项/任务执行开场白/按角色登记/双向跨角色拦截）；`smoke:watch` 新增 task 场景（task 开场白→动作→task 版回填注记→TASK-DONE 结论，断点 processed）；`npm test` 203/203，五种浏览器冒烟全过。

### P43：P42 修复后的外部浏览器 MCP 现场复验（上一轮）

- 环境：`@playwright/mcp@0.0.82` 全局固定版本，项目零新增依赖；本地 stdio、headless Chrome、独立临时浏览器资料目录；watch 使用 DeepSeek 的 `dev-root` 专用测试聊天，显式授权 `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_evaluate` 四个工具，其余 21 个未授权。
- 实际任务：只给网页模型自然语言目标，未提供 host JSON。模型自行构造 `browser_navigate` + `browser_snapshot` 打开本地 lab 页面并读标记，再构造 `browser_click` + `browser_snapshot` 展开详情并复核；watch 终端暂停、恢复后，模型构造 `browser_evaluate` 读取 `window.__lab` 并向同源 `/beacon` 回报。五次工具调用全部成功并回填；首次导航触发的 `tools/list_changed` 后日志显示已同步当前目录，旁观未中断。
- 页面取证：`load` / `expand` / `model-verify` 共三条 beacon，唯一会话 UUID `d5d7b0a7-3393-447a-9c5b-bd4af2b22168`，唯一随机标记 `LAB-gu0kbh5i`，`detailsOpen` 为 `false → true → true`；仅一次 `load`，后续没有导航或刷新。暂停前后外部 MCP server PID 均为 19812；退出后该进程不存在，独立资料目录对应的 Chrome 进程由 7 个降为 0，临时资料目录已清理。专用测试线程登记成功，断点阶段为 `processed`。外部 server 内部握手次数未单独仪表化；本轮只确认日志中一次就绪和同一进程持续运行。
- 结论：支持本地 stdio、串行调用、需要会话内状态的文本结果工具；已验证浏览器连续交互场景。远程连接、交互式授权、多 server 不在本轮验证范围。

### P42：修复 P40 复审的五处缺口（上一轮）

- 目录同步：首次发现前安装变化回调；开场白发送中或首次同步中目录再次变化，会补发直到最新目录。运行中变化先更新 Host 冻结的授权，待当前批次结束、watcher 暂停后串行同步原聊天；失败或发送状态不明立即停止旁观，保存 `catalog-sync` 待核对断点。无 MCP 时续接空目录同步失败也留断点；原聊天人工核对后才可继续。
- 客户端接收：业务调用在等待目录重新发现前抢占串行锁，已有调用在途时立即返回 `mcp-busy`；stderr 尾部按 4096 字节 UTF-8 原始数据保留并在字符边界解码；按帧处理 stdout 后仅复制未完成的残帧，完整帧的底层缓冲即时释放。
- 回归证据：故障 fixture 使目录变化与慢调用重叠，验证第二调用不排队；多字节 stderr、2 MiB 多帧后底层缓冲释放、启动期变化、同步期再次变化、同步失败停止与待核对断点均有针对性测试。`npm test` 199/199；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 全过。真实外部浏览器 MCP 的连续会话记录沿用 P40，本轮未重复外部现场验证。

### P41：工具测试聊天约定（上一轮）

- 动机：P36/P40 的真实网页模型验证此前借用真实项目的聊天线程（pi / file-tool 学习线程）进行，工具测试会污染真实学习上下文。
- 实现：AGENTS.md 新增「工具测试聊天」小节——统一 `watch deepseek --root dev-root`，默认续接专用测试线程、`--new` 需显式；测试聊天同样遵守断点人工核对与结果不明停止规则；专用浏览器 profile 独占提示；验证任务不提供 host JSON。
- `dev-root/`：提交 NOTES.md 与 sample/app.js 作为稳定的检索/读取样例（"审批时限：3天"、greet/formatName 带稳定行号）；Host Root 沙箱仅圈住该目录，聊天读不到仓库其余部分。
- 兼容与验证：纯文档与样例新增，无行为改动；`npm test` 192/192 不受影响。尚未实跑浏览器（首次测试聊天启动时自然验证线程登记与续接路径）。

### P40：接收内存有界性验收 + 真实浏览器会话工具验证（上一轮；提交 7fc9fd3 / b98c010 / 628f1d0，提交信息里的"P39"编号指本轮）

- 第一步（有界接收）：复查发现真实缺口——帧超限判定后 stdout 监听器未摘除，超限到进程退出之间的数据会继续累积，违背有界承诺；已修复（摘除监听器 + 清空接收缓冲 + 顶部停用守卫）。验收样本全部落地（`tests/mcp-bounded.test.mjs` + mcp-state fixture 扩展）：恰达 1MiB 完整帧正常处理、超一字节即拒（协议破坏→结果不明→连接停用）、非 JSON 超大 banner 同样受限、同一数据块序列 20 条消息总量 2MiB 每条未超限不误判、持续无换行洪峰数秒内被拦截（不等超时）、stderr 洪峰后保留 ≤4KiB、中文多字节跨块沿用互操作回归；受限堆子进程（`tests/fixtures/mcp-heap-runner.mjs`，`--max-old-space-size=64` + 运行期 RSS 采样超 256MB 自判失败）验证客户端主动报告超限先于内存失控；watcher 集成验证工具执行中超大消息 → 同批次后续动作次数为零、断点待人工核对。
- 第二步（真实会话工具）：接入外部 server `@playwright/mcp@0.0.82`（全局固定版本安装，项目零新增依赖；stdio；`--headless --browser chrome --user-data-dir <独立临时目录>`）。配套新增：`--mcp-allow` 显式授权工具子集（与探测结果取交集、按用户顺序，未点名/超上限记入 dropped 并提示——playwright-mcp 暴露 25 个工具，本场景显式授权 4 个）；`--mcp-arg=<值>` 等号形式传 server 旗标（空格形式的 `--` 值仍拒绝）；watch REPL 暂停/恢复 命令（MCP 连接与浏览器保留）；`scripts/mock-lab.html` + `scripts/lab-server.mjs`（页面内存随机标记/会话 UUID/展开态，刷新即消失；beacon 上报本地 lab 服务器供事后取证）。
- 真实互操作发现（第一轮验证失败样本）：@playwright/mcp 在首次导航（浏览器会话初始化）时正常发出 tools/list_changed，P38/P39 的"目录变化即停用"语义会把可观察的在途结果变成结果不明并中断整批任务。修订（628f1d0）：list_changed 不杀连接——在途调用照常完成，客户端自动重新发现 tools/list，期间新调用短暂等待、超时按 mcp-catalog-stale 明确拒绝；授权由 Host 冻结（只缩不扩），收缩时向聊天交付 mcpSyncPayload。常驻测试同步更新。此项取代 P38/P39 记录中"目录变化→结果不明/停用"的表述。
- 真实验证记录（DeepSeek 续接既有线程，全程未提供任何 host JSON）：①watch 日志显示 MCP server 就绪一次（协议 2024-11-05，授权 4 个工具，21 个未授权列明）；②模型按开场白目录自行构造并连续执行 browser_navigate → browser_snapshot（读取标记）→ browser_click（展开详情）→ browser_snapshot（复核一致）→ 暂停 → 恢复 → browser_evaluate（读取 window.__lab 并 POST beacon），全部 ok 且逐轮回填成功；③beacon 取证：单一会话 UUID、标记 LAB-tvv6jae9 全程一致、detailsOpen false→true 且保持——前一次交互产生的状态被后续调用实际使用，无重新导航/刷新；④退出后遗留进程检查 clean（专用 profile 的浏览器与 MCP server 均已释放）。过程中借 `.playwright-mcp` 控制台日志定位并修复了 lab 页自身的 beacon 取证 bug（裸变量 ReferenceError）。
- 已验证范围声明：支持本地 stdio、串行调用、需要会话内状态的文本结果工具；已验证浏览器连续交互场景。不泛化为"已支持大部分 MCP"。
- 验证：`npm test` 192/192（新增 mcp-bounded 8 例、cli 参数解析 4 例，常驻目录变化用例改为重新发现语义）；五种浏览器冒烟全过。
- 代码复审结论（提交 `75e3608`）：**有界接收与连续会话主路径有测试及运行记录，但尚有以下缺口待修复**。
  - `src/cli.mjs`：目录收缩后通过 fire-and-forget 发送能力更新；发送失败或状态不明仅记日志并继续旁观，违反失败关闭与人工核对约束。
  - `src/cli.mjs`：`onCatalogUpdate` 在开场白和首次目录同步之后才设置；启动阶段发生的目录变化可能已重新发现但未更新 Host 目录/允许列表。
  - `src/mcp-client.mjs`：`callTool()` / `listTools()` 在检查忙碌锁前等待目录重新发现；新业务请求可能等待后执行，不符合忙时立即拒绝、不排队。
  - `src/mcp-client.mjs`：stderr 尾部按 4000 个字符串字符裁剪，不是 4 KiB 字节；现有测试只用 ASCII，未覆盖多字节内容。
  - `src/mcp-client.mjs`：帧解析后以 `Buffer.subarray()` 保留剩余视图，底层整块缓冲仍被引用。实测 `burst` 返回后 `buf.length=0`，但 `buf.buffer.byteLength=102647`；这不是进程内存无界证据，但未满足“处理后立即释放原始帧”。
  - 复审时针对性测试 `mcp-bounded`、`mcp-resident`、`cli` 共 31/31 通过；上述缺口尚无相应失败关闭、并发目录变化、多字节 stderr 和底层缓冲释放回归样本。

### P39：修复 P38 代码复审问题（上一轮）

- CLI 收尾：将 `mcpClient` 声明移到 `try` 外，并由 `closeWatchResources` 按 signal → 关 MCP → await watcher → 关浏览器收尾；目录处理在 client 创建后抛错时也释放连接。单测验证顺序与在途请求释放后才等待 watcher。
- watcher 停止：页面快照返回后、每项动作开始前及回填前检查停止状态；在途动作已执行但未回填时保留 `executing` 断点供人工核对。回归测试先复现“停止后仍执行第二项并回填”，修复后通过。
- MCP 崩溃与超时：握手成功后清除启动阶段的退出回调，使运行中进程退出立即结束在途调用；连接停用统一清理进程，覆盖超时、超大帧和目录变化，握手阶段的协议破坏也继续终止进程。回归测试先复现崩溃调用等待完整超时、超时后进程仍存活，修复后通过。
- 验证：针对性测试 41/41、完整单测 181/181；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五种浏览器冒烟均通过。`smoke:watch` 覆盖网页到常驻 MCP server 的调用与回填；CLI 收尾顺序由单测覆盖。

### P38：常驻 MCP 会话（实现记录，复审未通过）

- 设计输入：评审方案"一个 watch 进程持有一个 MCP server，会话内持续复用连接"，七条要求逐项落实；范围限定为单 server、单 watch、常驻 stdio、串行调用、异常停止与可靠清理。
- 常驻客户端：`src/mcp-client.mjs` 提供 `createMcpClient()`（完成 initialize + initialized 握手并校验协议版本与 tools 能力后返回，失败自行清理进程）、`client.listTools()/callTool()`（保持 {ok,text,error} 风格）、`client.close()`（幂等、有界：先关 stdin 等自然退出 3s，超时进程树清理）。请求 ID、定时器、stdio、帧解析、进程终止全部封装在客户端内部；`listMcpTools`/`callMcpTool` 保留为一次性兼容包装，内部复用同一实现，不维护两套协议。
- 授权在 Host 执行层：`runAction(action, root, { mcp: { client, allow } })`，顺序=工具名/参数校验 → 显式允许列表 → 连接可用 → callTool；目录发现与调用必须同一个 client。
- 结果语义三分（本轮最重要设计点）：①工具 isError / JSON-RPC error = 普通失败，连接继续可用；②本地校验拒绝 / 连接不可用 / 忙碌 = 明确未执行（mcp-unavailable / mcp-busy / tool-not-allowed），不自动重试；③请求已发出后超时、断线、崩溃、单帧超限、目录变化 = `mcp-outcome-unknown` + `requiresConfirmation:true`。超时尽力发送 notifications/cancelled，但无成功确认、不据此认定未发生；首版对结果不明的连接立即停用并清理，不判断是否仍安全。
- watcher 停止：识别 requiresConfirmation 后停止同批次后续动作、不回填（回填会让模型误以为批次完成）、断点保留在 executing 等人工核对。`stop.signal()` 非阻塞停止，watch 收尾顺序=signal（禁止开始下一项）→ 关 MCP（释放在途请求）→ await stop → 关浏览器，退出不会被在途工具调用拖到超时。
- 常驻防护：串行调用，忙时立即返回 mcp-busy（不排队）；接收上限=单帧 1MiB（超限即协议破坏，连接停用），stderr 只留固定尾部，按字节缓冲整行解码（UTF-8 不跨块损坏）；迟到/重复/杂散响应忽略、不能匹配新调用；服务端请求只应答 ping、其余明确 -32601，绝不与工具响应混淆；tools/list_changed 使连接停用（不自动重新发现/授权）；握手校验版本与 tools 能力，capabilities 声明保持为空（不虚构 sampling/elicitation）。
- 生命周期约束落实：每 watch 独享连接（无全局单例、不跨项目共享）；普通暂停保留 server、退出才关闭；启动后的失败路径（浏览器启动失败、目录同步失败、开场白失败）都经 finally 统一清理；MCP 连接在浏览器启动成功后创建，浏览器启动失败时无进程可泄漏。
- 验证：新增 `tests/fixtures/mcp-state-server.mjs`（内存计数/同 PID/握手计数/崩溃/超时/超大帧/无换行挂起/杂散/重复/目录变化/服务端 ping 与拒绝）与 `tests/mcp-resident.test.mjs` 10 例，覆盖验收 7 条中的 1/2/3/5 及服务端请求；watcher 新增"结果不明停止批次、不回填、断点未确认"测试；一次性接口由原 mcp-client/interop 测试继续覆盖（超时用例更新为结果不明语义，互操作 fixture 的良性主动通知改为 notifications/progress——list_changed 停用语义移至常驻测试）。`npm test` 179/179；五种浏览器冒烟全过。
- 代码复审结论（提交 `6fda081`）：**尚未通过，P38 待修复后复审**。
  - `src/cli.mjs`：`mcpClient` 在 `try` 内声明，却在 `finally` 中引用；引用触发的 `ReferenceError` 被关闭步骤的 `catch` 吞掉，导致退出时跳过 MCP server 关闭。
  - `src/watcher.mjs`：`stop.signal()` 后，在途动作返回仍可能继续执行同批次后续动作并回填，未满足停止信号禁止开始下一项动作/回填的约定。
  - `src/mcp-client.mjs`：握手成功后未清除 `#startupExitReject`；server 随后崩溃时，在途调用不能及时收到结果不明，会等到调用超时才结束。
  - `src/mcp-client.mjs`：调用超时只将连接标记为不可用，未立即清理 server 进程；watcher 停止后 CLI 仍可能继续等待终端输入，server 继续存活。
  - 复现与验证：审核时 `npm test` 179/179 通过，但上述路径未被现有测试锁定。崩溃用例设置 2200ms 超时后约 2207ms 才返回；超时返回后 server 仍存活；在途动作期间发出 `stop.signal()` 后仍执行两项动作并回填一次。以上为待修复缺陷，不作为 P38 完成证据。
- 范围外（未实施）：远程连接、多 server、自动重连、跨进程恢复。

### P37：修复 P36 代码复审问题（上一轮）

- 能力同步：所有旧聊天续接都发送当前目录；关闭 MCP、探测失败或空目录时明确同步“未授权任何 mcp 工具”。同步失败或发送状态不明会在 watcher 启动前停止并提示人工核对，不再出现聊天目录与执行授权不一致。
- 允许列表：`ctx.mcp.allow` 缺失时默认拒绝，目录外工具继续本地拒绝；smoke:watch 的 MCP 场景也改为显式传入 `search_files` 允许列表。
- 调用示例：保留全部必填参数，数组/对象/数字/布尔/null 使用对应 JSON 类型；调用 JSON 本身绝不截断，完整示例超过 560 字符的工具不进入目录或允许列表。参数说明只在 JSON 之后按剩余空间截断。
- 互操作回归：修正测试“跨块”与 fixture“分块”的条件不一致；fixture 在命中分块分支时附加标记，并把 UTF-8 字符的两半跨事件循环写出，测试同时断言标记、完整中文和无 U+FFFD，确保分块路径真实发生。
- 文档与提示：README、AGENTS 和代码注释同步当前规则；用户可见兜底统一为中文。
- 验证：针对性测试先复现失败后转绿；完整单测 168/168 通过；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五条浏览器冒烟全部通过。

### P36：模型能正确认识并使用 MCP 工具（本提交）

- 评审输入：P35 复审指出四个缺口，本轮按建议只做"模型能正确认识并使用工具"；缺口 4（接收内存上限）留待下一轮。
- 工具目录呈现参数结构：`listMcpTools` 保留 inputSchema 的 `required` 与参数类型/描述（`tests/mcp-interop.test.mjs` 锁定）；开场白每个工具渲染调用示例 + 描述 + 参数清单。复审发现数组类型、第五个必填项及 JSON 截断存在缺口，已由 P37 修复。
- 续接同步能力：新增 `mcpSyncPayload`，续接成功并确认线程地址后自动回填能力更新。复审发现关闭 MCP 时未同步空目录、同步失败仍启动旁观，已由 P37 改为全量同步并失败停止。
- 允许列表闭环：`mcpCatalogArg` 把探测结果切片为目录（上限 `MCP_TOOLS_MAX=4`），展示、授权、执行共用同一份——`host-actions` 对 `spec.allow` 外的工具本地拒绝（`tool-not-allowed`），探测失败或目录为空时**不注入桥接执行器**（mcp 动作按未配置处理）。
- 互操作验证（独立实现）：新增 `tests/fixtures/mcp-interop-server.mjs`，覆盖手写缓冲、CRLF、不同 protocolVersion、主动 notification、banner、无 schema 工具和 structuredContent。原中文分块样本因关键词不一致未触发对应分支；P37 已修正 fixture 与断言，重新锁定真实跨块解码。
- 评审修正落档：原"写入门控候选（readOnlyHint === false 拒绝）"表述作废——缺失标记不能自动放行，工具自报只读也不能代替用户授权；真正的门控是用户指定的 server + 本目录允许列表，后续写入类能力须在此之上再加显式用户开关。
- 兼容：四个原有 op 与 `runAction(msg, root)` 调用形式不变；MCP 桥接在 P37 后要求显式允许列表，缺失时失败关闭；不新增依赖。
- 验证：`npm test` 166/166（新增互操作 3、目录切片 1、允许列表 1、协议渲染 1）；五种 smoke 全过。
- 真实网页模型现场验证（DeepSeek，续接 `D:\git-project\pi` 既有线程，桥接 demo server 授权 pi 与 file-tool 两个目录）：①续接后自动送达能力更新（"已向原聊天同步当前 mcp 工具目录"）；②任务以自然语言下达、全程未提供任何 host JSON，模型按开场白/能力更新里的目录自行构造了合法调用（终端记录 `mcp → ok`——tool 名错会得 tool-not-allowed、缺 query 会得 server isError，均未发生）；③结果自动回填成功。验证后 watcher 正常退出，断点 phase=processed。

### P35：watch 桥接本地 MCP server（只读搜索最小版，本提交）

- 动机：验证"网页聊天 → host 动作 → 本地 MCP server 工具 → 结果回填"的跨工具桥接价值。示例工具 `search_files` 一次搜索多个授权目录——内置 `search` 只有单个 Host Root，做不到，这正是桥接的价值样本。
- 实现：`src/mcp-client.mjs` 零依赖实现 MCP stdio transport（换行分隔 JSON-RPC 2.0，initialize → tools/call 单次会话，会话级超时、进程树终止、输出截断、banner 行容忍）；`demo/mcp-search-server.mjs` 只读示例 server（多目录搜索，敏感名/依赖目录过滤）；`host-actions` 新增 `mcp` op（形状与 args 体积校验，`runAction(msg, root, ctx)` 注入桥接配置，未配置时返回明确错误）；watch 命令新增 `--mcp <脚本>` + 可重复 `--mcp-arg`，启动时探测工具列表（失败只降级）并把工具写进开场白；回填标签用 `mcp <tool>`。
- 信任边界：server 脚本由用户经 `--mcp` 指定，模型只能选工具名和参数，永远不能选择 server 或命令；工具入参对 host 不透明，路径语义由 server 自行约束。接入非只读 server 等于扩权（README 已注明）。
- 兼容：现有四 op 行为与双参数 `runAction(msg, root)` 调用形式不变；未配置 `--mcp` 时协议文案不出现 mcp；`terminateProcessTree` 抽到 `src/kill-tree.mjs` 供 run 与 MCP 共用（无行为变化）；不新增 npm 依赖。
- 验证：新增 `tests/mcp-client.test.mjs` 8 例（真实子进程：跨目录命中、isError 映射、未知工具拒绝、超时终止、提前退出、banner 容忍、输出截断）；host-actions/parse/protocol 各补 mcp 用例；`npm test` 160/160 全绿；五种 smoke 全过，其中 `smoke:watch` 新增 `?auto=mcp` 场景验证 网页→host→MCP→回填 全链路（mock 仅在回填同时含 [R1]/[R2] 命中时确认成功）。
- 后续候选（未实施）：① 写入类工具门控——评审修正：不能依赖 `annotations.readOnlyHint`（缺失标记不等于只读、自报属性不等于用户授权），应在 P36 允许列表之上加显式用户开关；② 远程 MCP transport（HTTP/SSE）；③ console/control-server 集成 `--mcp` 会话配置；④ ask/chat 模式接入桥接。

### P34：公开可复现展示版

- 新增 `npm run demo`，复用已有 mock 端到端脚本，覆盖任务、故障诊断和文本问答；新增公开复现说明及 MIT 许可证。
- 将最低 Node 版本与 Playwright 依赖要求对齐为 20，并把锁文件下载源改为 npm 官方源；修复 README 中公开仓库无法访问的相邻项目链接。
- 仅发布源码、脚本、测试与使用文档的全新快照，不包含旧 Git 历史、`PLAN.md`、`AGENTS.md`、本机浏览器资料或运行状态。
- 验证：发布副本从零运行 `npm ci` 成功、146 项测试通过、`npm run demo` 三段全部通过；GitHub 公共仓库 46 个文件与本地发布副本逐一哈希一致。

### P33：修复 P32 代码复审问题（本轮）

- audit 结构校验：不再按任意关键词子串判断；只接受按「文档承诺 → 代码证据 → 验证结果 → 未确认项」顺序出现的行首标题，允许编号或 Markdown 标题，并要求每段正文非空。正文提及四个段名、倒序四段的复现样本均不再误报 complete。
- 协议同步：首轮 audit 提示和补全提示明确要求四个标题按顺序从新行开始，避免模型继续生成无法通过的新格式。
- Receipt 兼容：普通任务及成功任务不增加 `auditMissing` 空字段，保持原有 Receipt 字段形状；只有 audit 校验失败时附加该字段。`audit-incomplete` 仅由显式 `--audit` 任务产生，代码注释和 README 已补齐终态说明。
- 文档修正：README 将矛盾的「一次补全请求（最多 2 次）」统一为「最多尝试 2 次」，并写明结构校验规则。
- 验证：新增正文关键词误判、倒序标题、普通 Receipt 字段形状回归；针对性测试通过，完整单测 146 项通过；`smoke`、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 五条浏览器冒烟全部通过。

### P32：复审新的代码实现（`0e37c7d...b5f6cf4`）

- 结论：P26/P27 的既有问题、P28 URL 路径暴露与 probe 隐藏输入框误判、P29 audit 校验对象和补全耗尽仍报告 complete 等已报告问题均已修复；本轮仍有以下事项待处理。
- Spec 高：`src/loop.mjs` 以任意位置的关键词子串识别 audit 四段，正文只要提及四个段名即可误判为 complete。建议仅识别按顺序出现的行首标题（可允许编号或 Markdown 标题），并要求每段正文非空；需增加正文提及段名但未实际分段的回归测试。
- 兼容性/文档：Receipt 新增 `endReason=audit-incomplete` 与 `auditMissing`，当前缺少旧消费者兼容测试；需确认并锁定既有 Receipt 消费约定，同时同步 `src/loop.mjs` 注释和 README 的 endReason 列表。README 对补全次数存在“一次补全请求（最多 2 次）”的矛盾描述，应按实现统一。
- 流程/记录：`b5f6cf4` 同时包含 audit 终态和 probe 可见性两个独立领域的改动，与每轮单一边界、提交可独立回滚的约定不符；后续修复应分开提交。当前计划曾同时声称问题已清空并列出未完成事项，已在本次记录中更正。
- 待验证：P28 尚无真实站点改版失败样本；目前只有真实站点健康基线和 mock 故障样本，真实失败样本出现前保持待验证，不视为已关闭。
- 结构建议（非阻断）：`src/loop.mjs` 的两条 audit 补全控制流有重复；probe 与 diagnose 可见性判断有重复；audit 布尔配置及段名分散在多个模块。可在后续触及相关模块时集中规则与共用逻辑，不作为本轮已证实的行为缺陷。
- 验证：复审范围 `0e37c7d...b5f6cf4`；`npm test` 144 项通过，`npm run smoke:watch` 通过（含 healthy/hidden/selector-miss/probe-scope）；复现倒序四段仍被判为 complete。此次仅更新维护记录，未修改实现。

### P31：评审 Spec 修复——audit 校验对象/失败语义与 probe 可见性（本提交）

- Spec-1（校验对象，高）：audit 缺段判定改为针对**最终展示的结论**——done 取围栏内文本，不再被围栏外的段落标签满足；且每个标记之后必须有非空正文，仅罗列标签不算合格。评审复现样本（围栏外四标签 + done 内「只有总结」）不再判为 complete。
- Spec-2（失败语义，高）：补全 2 次后仍缺段时，endReason 标记为 `audit-incomplete`（退出码 2），Receipt 新增 `auditMissing` 列出缺失段落，不再报告 complete。
- Spec-3（probe 可见性，中）：健康探测改用与完整诊断一致的样式判定（display/visibility/opacity + 矩形尺寸），`visibility:hidden` / `opacity:0` 输入框不再误判健康；smoke:watch 补 hidden 变体 probe 回归。
- 提交粒度：按评审建议将混合提交 0e37c7d 拆分为 P28、P29 两个独立提交。
- 验证：针对性测试（围栏外标签样本、标签无实体、缺段 audit-incomplete、hidden probe 回归、非 audit 回归）先失败/先红后转绿；完整单测 144 项通过；五条浏览器冒烟通过。

### P30：P26–P29 评审问题修复（已提交）

- 范围：修复评审记录的 6 项代码问题与 1 项流程缺口；1 项低优先结构建议（布尔参数收敛、probe/diagnose 提取共用函数）经判断暂缓，理由：改动面跨 CLI/循环/协议三层且不影响行为，留待下次触碰这些模块时顺势处理。
- P26-1：行号 read 跨块总行数多算（评审复现样本 totalLines 4≠3）——EOF 的 kept 处理加 !done 守卫，done 后同 chunk 残余改经 trailing 计一次。
- P26-2：单行输出超发 16 字符——LINE_KEEP 恰等于 READ_LINE_CHARS。
- P27-1：include 移至收集阶段过滤——不匹配文件不占扫描上限，也不触发「可能不完整」提示；搜索循环冗余判断移除。
- P28-1：diagnose 输出 URL 脱敏为 origin（完整 URL 可能含聊天线程标识）。
- P28-2：probe 范围收窄为仅查输入框选择器，完整普查留给显式 diagnose()；composer 选择器未命中时返回 composer-miss。复审发现不可见输入框仍可能被误判健康，待修。
- P29-1：audit 对缺段结论自动请求补全，最多 2 次；复审发现两次后仍缺段会标记 complete，且校验读的是整条回复而非最终 done 正文，待修。
- P29-2/流程：README 补 --audit 用法与限制；本条目及后续条目记录完整冒烟结果。
- 验证：针对性测试 7 项先失败后转绿（P26×2、P27×1、诊断映射×2 已在 P28 提交、probe 范围×1、audit 校验×3）；完整单测 142 项通过；五条浏览器冒烟（任务/导师/旁观/控制台/profile）全部通过。
- 复审（基线 `e644fc9...HEAD`）：确认 P26 跨块行数/单行长度与 P27 include 扫描上限问题已修复；P28 URL 改为 origin 且 probe 已限定输入框范围。仍发现 probe 把 `visibility:hidden` / `opacity:0` 输入框当健康、audit 校验围栏外标签后可接受不完整 done，以及两次补全后仍标记 complete；细节与复现记录见「已观察、待处理问题」。

### P29：代码与文档核查模板（本提交）

- 需求：产品拓展方向优先级 2——回答「文档说的行为，代码真的实现了吗」，输出四段结构：文档承诺 → 代码证据 → 验证结果 → 未确认项。
- 实现：firstPayload 新增 audit 模板（与 diagnose 互斥，protocol 与 CLI 双重校验）；orchestrate/loop 透传；CLI `ask <站点> --audit` 沿用现有 search/read/run、Receipt 与安全边界，不新增依赖。
- 真实试点（DeepSeek + 本仓库）：任务=核查 README「内容搜索（search）」小节四条承诺。Receipt endReason=complete；导师先 read README 摘承诺、search/read 定位 buildMatcher/wildcardMatch/输出格式（文件:行号），再实际运行 node --test tests/host-actions.test.mjs（exit 0，33/33），按四段输出结论。**试点额外发现 1 条真实不一致**：include 参数在单文件 path 下被静默忽略（已登记为新增候选，未擅自修改）。
- 验证：audit 模板四段断言、audit+diagnose 互斥、askTaskArg --audit 前后解析等单测；完整单测 135 项通过。

### P28：站点故障细分诊断（本提交）

- 纪律：按候选要求未认定现有选择器有缺陷。真实样本以**健康基线**形式采集——用新增的 `scripts/probe-site.mjs` 对已登录 DeepSeek 实测：composer 由 `textarea[placeholder*="给 DeepSeek"]` 命中（matched=1/visible=1），输入框可用；真实"站点改版失败"样本无法凭空制造，须在改版实际发生时用同一脚本采集后再补回归。
- 实现：page-script 新增 `diagnose` 模式——对 composers/sendButtons/messageRoots/markdownBodies/stopButtons 五组选择器逐一统计命中数与可见数（脱敏，无正文）；`interpretDiagnosis`（src/diagnose.mjs）把普查结果映射为细分原因（`composer-ok` / `composer-invisible` 输入框存在但不可见 / `composer-selector-miss` 输入框未命中但回复区正常 / `no-chat-dom` 输入框与回复区都未命中）与对应中文处理建议。
- 接线：`driver.probe()` 升级为三态+细分原因+建议（控制台健康栏直接显示）；`driver.diagnose()` 输出完整普查供取证；`send` 的 no-composer 失败路径改用诊断生成错误信息；smoke:watch 增加脱敏故障样本回归（mock `?broken=hidden` → composer-invisible，`?broken=composer` → composer-selector-miss，健康页 → healthy）。
- 修复：诊断计数器 `visible` 遮蔽外层同名函数导致统计恒为"未命中"（真实运行中发现：mock 页 matched=1/visible=0/invalid=true），重命名后转绿。
- 验证：解释层映射单测 5 项、诊断回归三态冒烟、完整单测 133 项通过。
- 待办遗留：站点真实改版发生时，用 `scripts/probe-site.mjs` 采集失败样本，补对应 sites.mjs 修复的回归用例。

### P27：search 目录扫描达到文件上限时明确提示（本提交）

- 复现：2050 个文件的目录中，只有第 2050 个文件含 pattern；搜索在收集满 `SEARCH_MAX_FILES`（2000）后静默返回，tail 仅报「共搜索 2000 个文件」，无任何截断提示——真实命中被漏掉且输出看起来就是完整无命中；针对性断言（必须有上限提示）先失败。
- 实现：`collect` 两处上限出口置 `filesTruncated`，tail 增加「目录扫描达到 2000 个文件上限，超出部分未参与搜索——结果可能不完整；请用更窄的 path/include 分次搜索」。
- 边界：恰好收集满 2000 且遍历自然结束不提示（新增不误报测试，bulk 1996 + 根目录 4 = 2000）；与 maxResults 命中截断提示可同时出现；node_modules 等依赖目录不计入上限。
- 验证：两条针对性测试先失败后转绿；完整单测 128 项通过。

### P26：行号 read 内存与输出双重上限（本提交）

- 复现：行号模式读取时缓存完整行（2MB 单行文件会在缓冲区构造 2MB 字符串）；400 行 × 500 字符返回约 20 万字符且无总字符上限——针对性测试断言输出 ≤ READ_MAX_CHARS 先失败。
- 实现：超长行只保留输出所需前缀（≤ 500 字符）并继续计行，缓冲区恒有界；输出累计达 `READ_MAX_CHARS`（12k）即停，提示改用 `line` 参数续读且行号衔接；窗口集满或到顶后停止解码，改为字节级换行计数（UTF-8 的 0x0A 不在多字节序列内部，计数精确）直到 EOF——总行数、越界报错与续读语义不变。
- 兼容：行号/行数参数、`N: ` 前缀、目录读、字符 offset 模式及动作协议不变；不新增依赖。
- 验证：总字符上限与续读衔接、2MB 超长单行（前缀裁剪 + totalLines=2）、CRLF 无末尾换行针对性测试先失败后转绿；完整单测 126 项通过；三/五条浏览器冒烟由本提交后的完整回归覆盖。

### P25：统一单文件与目录 search 限制（本提交）

- 复现：1.2 MB 单文件每行包含 `hit` 时，直接搜索即使指定 `maxResults: 1` 仍返回 300,000 行；同一文件通过目录搜索则因超过 `SEARCH_MAX_FILE_BYTES` 被跳过。针对性测试先失败。
- 实现：单文件搜索沿用目录搜索的 `SEARCH_MAX_FILE_BYTES` 上限，超限时给出跳过提示；搜索函数按剩余命中预算收集命中，超过 `maxResults` 时返回截断提示。普通单文件搜索结果格式和目录的递归、过滤行为保持兼容。
- 验证：针对性 host-actions 测试 28 项、完整单测 123 项通过；`smoke`（含排障和文本问答子流程）、`smoke:chat`、`smoke:watch`、`smoke:console`、`smoke:profile` 全部通过。并行执行时有一项派生进程终止测试出现时序失败，停止并行负载后完整单测重跑通过。

### P24：文本目录问答任务角色（本提交）

- 复现：`chat`/`watch` 固定代码导师提示词，要求只教项目源码并反问；用于笔记、规范、日志目录时角色和回答形式不匹配。同一站点与目录仅有一条聊天登记，直接切换角色还会混用旧对话。针对性协议、CLI、登记和断点测试先失败。
- 实现：`ask`/`chat`/`watch` 增加 `--role text`，控制台提供任务角色选择。文本角色以 `ls/search/read` 检索文本并引用文件行号；默认 `code` 保留原提示词与旧登记键。文本角色使用独立线程登记和 watch 断点，但另一角色存在未确认动作时禁止切换旁观，必须回原聊天人工核对；Host Root、敏感路径过滤及现有动作协议不变。
- 验证：针对性测试先失败后转绿；完整 122 项单测与五条浏览器冒烟通过。任务和导师 mock 浏览器冒烟覆盖文本搜索、按行读取与来源引用；控制台测试覆盖角色切换后不续接另一角色的对话及跨角色断点门禁。并行回归曾暴露原 watcher 测试依赖固定轮询次数，已改为等待实际回填后重测通过。

### P23：`ask` 故障排查任务模板（本提交）

- 复现：普通 `ask` 的开场协议只有通用任务说明，缺少排障所需的假设验证、文件行号、测试结果及事实/推测区分；针对性协议、循环和 CLI 测试先失败。
- 实现：新增 `--diagnose`，为 `ask` 选择排障模板；沿用现有动作、回填、Receipt 与安全边界。支持选项位于任务前后，`--` 后仍按原样作为任务正文。
- 验证：针对性单测先失败后转绿；完整 114 项单测与五条浏览器冒烟通过。任务冒烟覆盖普通 `ls/read/run` 流程及排障 `search → read → run → 带证据结论` 流程；其余冒烟覆盖导师、旁观、控制台及浏览器资料目录占用。

### P22：控制台网页连接三态诊断（本提交）

- 复现：旧状态只有运行/暂停/错误，网页输入框暂时不可见与浏览器关闭无法在会话信息中区分；新增诊断测试先因缺少 `health` 失败。启动失败清理还会把原始错误覆盖成“浏览器已关闭”，回归测试先失败。
- 实现：只读检查专用标签页与可见输入框，单独显示健康/已停止/状态不明及中文原因；探测失败只提示，保留浏览器。主动清理与用户手动关窗分开处理，保留启动失败原始原因。检查不读取聊天正文或登录信息。
- 验证：三态与错误保留的针对性测试、控制台浏览器界面冒烟及 watch 真实浏览器驱动的 mock 输入框检查；完整 111 项单测与五条浏览器冒烟通过。

### P21：watcher 中断断点与人工核对恢复（dd6c6e3）

- 复现：watcher 的待回填结果和已处理回复只在内存，进程退出后无法区分动作未做、执行中或回填中；故障测试先因无断点模块失败。
- 实现：按网站+项目存放原子替换的最小断点，只有阶段、回复指纹及动作计数，不存正文/结果/地址。动作执行前落盘，页面发送函数返回成功后标记已处理；重启时未确认状态先打开原聊天并停在人工核对，不发重连消息、不重跑 `run` 或重发结果。发送状态无法证明未发送时也停止，而明确未发送仍可在本进程重试。
- 验证：中断、去重、写入失败、文件损坏与控制台确认的针对性测试；完整 109 项单测、五条浏览器冒烟，其中 watch 与控制台冒烟实际覆盖断点落盘及人工确认路径。真实站点断电重启尚未执行。

### P20：项目内敏感路径统一拒绝（f6ab3c6）

- 复现：临时项目中的 `.env` 可被直接 `read`/`search` 返回，`.ssh` 与 `.env.local` 会进入目录清单及递归搜索；针对性测试先失败。
- 实现：统一按请求路径和真实路径拒绝常见凭据、私钥及敏感目录；目录清单与搜索在遍历前隐藏这些条目。`.env.example` 等样例保留可读，依赖目录原有递归跳过与显式读取语义不变；协议和 README 说明限制及 `run` 间接读取的剩余风险。
- 验证：四组敏感路径回归测试、完整 102 项单测及五条浏览器冒烟通过；未读取真实凭据。

### P19：专用浏览器资料目录占用时保留原会话（本提交）

- 复现：隔离临时资料目录中的第一个真实 Chrome 仍运行时，第二次启动失败会触发旧逻辑的进程清理，原浏览器被结束；真实浏览器冒烟先失败。
- 实现：启动前只读检查资料目录是否已被浏览器使用；占用或无法确认时提示用户检查，不启动第二个浏览器，也不自动结束任何进程。全部渠道失败时不再尝试按资料目录清理进程；Chrome→Edge→Chromium 回退保持不变。
- 验证：注入故障单测覆盖占用时零次启动、全部渠道失败仅尝试一次；隔离真实浏览器冒烟确认第二次启动被拒且原窗口仍可用；完整单测与五条浏览器冒烟。

### P18：历史聊天登记原子保存并显示所选项目状态（本提交）

- 复现：原登记文件损坏时读取被当作空表，下一次保存可能直接覆盖原数据；写入直接覆写原文件。失败测试覆盖损坏文件、替换失败和控制台缺失状态提示。
- 实现：旧 JSON 格式保持不变；同目录临时文件写入并同步后替换，失败保留原件；仅文件不存在才按空表处理。控制台对所选网站+项目显示已登记/未登记/地址无效，不暴露线程 URL；登记异常停止启动新聊天。
- 验证：旧格式兼容、故障注入与控制接口测试；控制台浏览器冒烟覆盖未登记→绑定→已登记；完整单测和四条浏览器冒烟。

### P17：绑定旧聊天时指出所选网站不匹配（本提交）

- 复现：控制台选 ChatGPT、粘贴 DeepSeek 的 HTTPS 旧会话地址时只提示泛化的“不是所选网站”，无法直接看出应改哪个选项；针对性测试先失败。
- 实现：仅当链接属于另一已支持网站的有效会话地址时，明确给出链接网站和当前选择，并提示切换；仍拒绝保存，其他非法链接沿用原错误，不自动跨站切换。
- 验证：绑定接口回归测试和控制台浏览器冒烟均覆盖错误提示及登记未被覆盖；完整单测与四条浏览器冒烟。

### P16：watch 诊断流水脱敏（本提交）

- 复现：注入测试诊断接收器后，包含私密文本的网页回复会以 `head=` 原样进入流水；同长度的新回复也可能因仅截前 100 字而漏记变化。
- 实现：仅在内存比较回复签名；落盘保留 busy、字符数、变化标记与 10 秒心跳，不保存正文或指纹。旧日志保留，文档提示分享前检查。控制台测试隔离本机历史登记，避免用户状态影响单测。
- 验证：脱敏回归测试经历失败与通过；完整单测及四条浏览器冒烟。

### P15：旧线程未登记时提供可验证的本地绑定恢复入口（本提交）

- 复现与范围：用户在 DeepSeek 旧项目重启后看到新聊天，控制台没有“已打开历史聊天”提示。用临时项目在专用 Chrome 和真实 DeepSeek 实测两次正常登记与重启续接均通过；因此不能将用户旧项目的缺失原因写成确定的代码缺陷。旧线程仍可从网站历史列表打开。
- 实现：控制台找不到所选网站+项目的登记时明确提示将新建聊天；新增「找回以前的聊天」折叠入口，让用户自行粘贴旧聊天地址并绑定到当前项目，再启动续接。地址只在本机处理，需为所选网站同源 HTTPS 且非首页，运行中不能改绑。
- 验证：绑定接口失败测试转绿，覆盖来源校验、跨站拒绝、绑定不提前启动浏览器及启动后使用旧地址；控制台浏览器冒烟覆盖绑定操作；专用 Chrome 与真实 DeepSeek 的临时项目实测完成“建立聊天→关闭程序→绑定到另一临时项目→打开同一旧聊天”。未读取/打印凭据或聊天正文，临时项目及其本地登记已清理。

### P14：控制台重启后按项目真正续接旧网页聊天（本提交）

- 复现：同站点、同项目已登记历史线程时，控制台创建驱动未传 `startUrl`；回归测试看到 `undefined`，实际先打开站点首页。首次在控制台启动的新项目也未保存线程 URL。
- 实现：选中同一项目启动时先查历史登记，将同站点 HTTPS 线程 URL 传给驱动并核对导航结果，再发送短重连消息；首次聊天取得线程地址后登记。历史线程未打开或重连失败时保留登记并明确报错，不再把新聊天冒充续连。
- 安全与兼容：拒绝跨站/非 HTTPS 历史 URL；不读取聊天内容或浏览器凭据；不改变动作协议、Host Root 或已有 CLI 调用。
- 验证：两条原始失败回归测试转绿，覆盖导航重定向与跨站 URL；模拟控制台进程重启的单测及浏览器冒烟。真实电脑重启和已登录外部站点未自动执行。

### P13：本地控制台暂停并复用 watch 会话（本提交）

- 需求：用户希望从本地控制台暂停旁观执行，之后继续使用同一网页聊天，而不重新登录或重发开场白。
- 实现：新增仅监听 `127.0.0.1` 的控制台；watcher 在当前动作和回填尝试结束后进入暂停门，继续时沿用原驱动、浏览器与回复判定器；结束会话才关闭浏览器。控制接口校验请求来源与随机令牌。
- 边界：暂停只保留当前进程中的会话；进程退出不持久化运行状态。恢复时读取最后一条可见回复，不回放暂停期间的全部历史消息。
- 验证：watcher 暂停时序单测、控制接口与来源校验单测、模拟会话浏览器冒烟、真实本地控制台页面与错误提示检查、完整回归测试。

### P0：阻止通过符号链接或目录联接逃逸 Host Root（本提交）

- 复现：修复前，root 内指向外部目录的链接可被 `read` 成功读取，针对性测试失败。
- 实现：文本路径校验后对 root 和目标执行真实路径解析，再次检查边界；解析异常失败关闭；root 内链接保持可用。
- 兼容：沿用 `host-path` 错误类型和动作协议；执行白名单仍按请求路径扩展名判断。
- 验证：针对性单测、完整单测、两种 mock 端到端冒烟及浏览器页面冒烟。

### P1：run 超时时终止整个派生进程树（本提交）

- 复现：父脚本确认派生后台子进程后被超时终止，子进程仍会延迟写出标记文件。
- 实现：Windows 使用系统 `taskkill /T /F`；类 Unix 平台为被测脚本建立独立进程组并按组终止；失败时退回强制终止父进程。
- 兼容：动作协议、超时错误和输出格式不变；不新增依赖。
- 验证：覆盖“父进程已启动子进程”的回归测试，并执行完整单测与两种浏览器端到端冒烟。

### P2：mock 端口冲突时自动回退（本提交）

- 复现：占用 `127.0.0.1:8642` 后运行 smoke，服务器触发未处理的 `EADDRINUSE` 事件并直接崩溃。
- 实现：mock 服务器优先使用指定端口，冲突时回退到系统分配端口；把实际 URL 显式传入页面驱动。
- 兼容：保留默认端口、`MOCK_URL` 和原有 `createDriver` 调用方式；真实站点不受影响；不新增依赖。
- 验证：端口冲突单测、占用默认端口时的完整任务模式冒烟、导师模式冒烟及应用内浏览器交互。

### P3：CLI 数值预算参数启动前校验（本提交）

- 证据：参数直接经 `Number()` 使用；`NaN` 会让轮数/时长比较永远为假，缺值则静默采用默认值。
- 实现：轮数要求正整数，时长与等待秒数要求有限正数；非法输入在浏览器启动前终止。
- 体验：参数错误仅输出一行中文原因，非用法异常仍保留完整堆栈用于诊断。
- 验证：覆盖缺省、正小数、缺值、NaN、无穷、零、负数和非整数，并运行真实 CLI 错误路径。

### P4：目录 read 与 ls 使用一致的条目上限（本提交）

- 复现：含 510 个新增文件的目录经 `read` 返回全部条目，而 `ls` 已有 500 条上限。
- 实现：目录 `read` 保持排序与目录斜杠语义，只返回前 500 项并附带收窄路径提示。
- 兼容：文件 `read`、offset/length、单层目录格式及动作协议不变；不新增依赖。
- 验证：大目录回归测试、完整单测、两种端到端冒烟及应用内浏览器交互。

### P5：并行 smoke 使用隔离的临时浏览器 profile（本提交）

- 复现：并行启动任务与导师 smoke 时，共享 profile 的锁恢复会清理另一条测试的浏览器进程，导致上下文中途关闭。
- 实现：两条 smoke 分别创建独立临时 profile，并在浏览器关闭后递归清理。
- 兼容：真实 `setup` / `ask` / `chat` 仍使用持久化专用 profile，登录态与安全模型不变；不新增依赖。
- 验证：两条完整 smoke 并行通过，随后执行完整单测及应用内浏览器交互。

### P6：Host Root 启动前校验（本提交）

- 证据：不存在路径、普通文件或缺失的 `--root` 值会继续启动浏览器，动作阶段才以低层错误失败。
- 实现：解析 CLI 时确认 root 存在且为目录；非法输入沿用一行中文用法错误。
- 兼容：默认仍为当前目录，合法绝对/相对目录和符号链接目录保持可用；不新增依赖。
- 验证：覆盖合法目录、缺值、不存在路径和普通文件，并运行真实 CLI 错误路径。

### P7：大文件 read 使用固定内存窗口（本提交）

- 证据：文件读取先用 `readFile(..., "utf8")` 构造完整字符串，再切片到 12k；文件越大峰值内存越高。
- 实现：使用 Node 流与 `StringDecoder` 扫描 UTF-8，只保留最多 12k 返回窗口，同时继续计数以保持完整 `size` 和截断提示。
- 兼容：UTF-16 字符 offset/length、跨块多字节字符、返回 size、续读 offset 和错误结构保持不变；不新增依赖。
- 验证：跨 64KB 块的 emoji/中文回归测试；24MB V8 堆限制下成功读取并统计 48MB 文件；完整单测与浏览器冒烟。

### P8：watch smoke 隔离动态端口与浏览器 profile（本提交）

- 复现：默认 8642 端口被占用时，mock 服务回退到空闲端口，但 watch smoke 仍固定访问 8642；实测服务地址与驱动地址不一致。
- 实现：从已监听的 server 读取实际地址，并为 watch smoke 创建、清理独立临时浏览器 profile。
- 兼容：只调整测试脚本；真实 watch、持久化登录 profile 与默认端口策略不变；不新增依赖。
- 验证：在 8642 已被占用时运行 watch smoke，并与任务、导师 smoke 并行验证。

### P9：未知站点在浏览器启动前失败（本提交）

- 复现：`ask definitely-not-a-site` 先启动专用浏览器，随后才报未知站点；错误还提示无效的 `npm run ask -- list`。
- 实现：CLI 在解析阶段统一校验站点名，列出所有可用站点，并指向真实的 `node src/cli.mjs list` 命令。
- 兼容：所有正式站点与内部 mock 保持可用，页面驱动仍保留防御性校验；不新增依赖。
- 验证：站点参数单测、真实 CLI 错误路径、完整单测与三种浏览器冒烟。

### P10：watch 回填失败安全重试（本提交）

- 复现：网页首次拒绝回填后，watch 已把回复标记为处理完成；后续不再发送结果，针对性测试仅记录 1 次回填尝试。
- 实现：动作执行后保留待回填 payload；失败或抛错时按间隔重试同一 payload，成功前暂停处理新回复。
- 安全：本地动作仍只执行一次，避免重试造成重复运行；停止 watcher 会同时停止后续回填尝试。
- 验证：覆盖“首次失败、第二次成功”，断言执行 1 次、回填 2 次且 payload 相同；完整单测与 watch 浏览器冒烟。

### P11：分段 read 回填标明实际请求区间（本提交）

- 复现：网页数组动作 `read src/requests/sessions.py offset=120 length=180` 已正确返回第 120–299 个 UTF-16 字符单位，但回填标题仅显示路径，无法区分从头读取；原样测试因此失败。
- 实现：分段 read 的回填标题保留 offset/length，并在协议与 README 说明它们是从 0 开始的 UTF-16 字符单位，不是行号。
- 兼容：read 内容、动作字段、Receipt 与未分段回填格式不变；不新增依赖。
- 验证：真实数组解析→watcher→本地 read→回填测试，协议单测、完整单测和三种浏览器冒烟。

### P12：watch 网页回复逐条选择取材料或教学互动（本提交）

- 复现：watch 共用终端导师开场白，同时要求“每条讲解必须反问”与按需发 host；其中“正文用户看不到”在网页模式下也不成立，模型容易同条发动作又要求用户回答。
- 实现：watch 使用专属开场白，明确每条回复只选取材料轮或教学互动轮；自动回填再次提醒该规则。终端导师开场白保持原样。
- 兼容：动作协议、watcher 执行逻辑与 chat/ask 模式不变；不新增依赖。
- 验证：专属提示与回填协议失败回归测试转绿；watch 冒烟先在浏览器发送专属开场白，再验证网页动作自动执行回填；完整单测及三种冒烟通过。
