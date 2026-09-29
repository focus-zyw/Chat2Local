# Chat2Local

把用户**已经在用的网页聊天**连接到本地项目工具：网页模型提出动作，本地 Host 校验、执行并把结果回填到原对话。Node.js + Playwright 驱动专用浏览器；不要求浏览器扩展，也不把用户的聊天迁移到自建前端。

项目曾用名 `file-tool`。GitHub 仓库现名为 `Chat2Local`。现有 `node src/cli.mjs` 命令、`~/.file-tool` 状态目录、控制台请求头和历史回填消息继续兼容，无需迁移聊天、登录资料或断点。

**求职项目快速阅读：**[项目介绍与技术取舍](docs/PORTFOLIO.md) · [无账号复现](docs/SHOWCASE.md) · [真实模型的浏览器 MCP 现场记录](docs/runs/P48-field-run.md) · [第二个 MCP server 的兼容记录](docs/runs/P50-cross-server-field-run.md)。公开演示只证明本地 mock 聊天页的流程；真实网站兼容性取决于当前页面结构。

**快速复现：**Windows + Node.js 20+，运行 `npm ci`、`npx playwright install chromium`、`npm run demo`。无需登录聊天网站；预期出现 `SMOKE PASSED`、`SMOKE DIAGNOSE PASSED`、`SMOKE TEXT PASSED`。完整步骤见[展示与复现说明](docs/SHOWCASE.md)。

让**网页聊天**（ChatGPT / Claude / DeepSeek / 豆包 / 千问 / Kimi / Grok / Gemini / Z.ai）具备四个本机能力，外加一个可选的 MCP 桥接：

- **读取文件**（`read`，双坐标：字符 `offset/length` 分段，或 **行号** `line/lines` 开窗——输出每行带 `N: ` 前缀，可直接引用行号）
- **内容搜索**（`search`，单文件或目录递归；默认子串+忽略大小写、可选正则与 `include` 文件名过滤；返回 `文件:行号: 内容`，命中行号可直接作 read 的 `line` 参数——**先 search 定位、再 read 精读**）
- **读取目录结构**（`ls`，单层或递归树；递归自动跳过 `node_modules`、`.git`、`dist` 等依赖/构建目录——目录名保留但不下钻，协议同时禁止模型读依赖包内部文件）
- **运行测试文件**（`run`，真实执行 .js/.mjs/.cjs/.py/.ps1/.bat/.cmd/.exe，返回 exit code 与输出）
- **MCP 工具桥接**（`mcp`，watch 模式可选 `--mcp` 启用）：调用用户指定的本地 MCP server 工具，结果同样回填进对话——网页模型由此获得 Host Root 之外的本机能力，而不放宽自身沙箱。仓库自带只读示例 server（`demo/mcp-search-server.mjs`，跨多个授权目录搜索）

三种玩法：

- **watch 旁观执行（推荐，最自然）**：启动后**你直接在网页上**和导师聊，随便问；工具盯着页面，导师回复里出现 ```host 动作块就自动执行、把结果回填进对话。终端只显示执行日志。
- **ask 任务模式**：派一件活到终态，拿 Receipt 验收——适合"跑测试并总结失败原因"这类一次离手的事。
- **chat 导师模式**：终端 REPL 里和导师对话（导师按需读代码，讲解回给你）；适合不想盯网页的时候。

`ask`、`chat`、`watch` 可用 `--role text` 切换为**文本目录问答**：对笔记、规范、日志等文本目录进行检索、归纳和追问，回答引用相对路径及行号。`watch` 还可用 `--role task` 切换为**任务执行角色**：

| 角色 | 用途 |
| --- | --- |
| `code` | 代码导师，逐步讲解并反问（ask 的代码任务也用此默认） |
| `text` | 文本材料问答与来源引用 |
| `task` | 连续调用工具（含 MCP）完成明确任务：接到任务后自主选择工具连续执行，按需取材料，直到完成或需要人工决定；结束输出 ```done 结论与可验证证据。线程与 watch 断点按角色独立登记，复用全部授权、常驻会话、暂停恢复与结果不明停止机制 |

默认角色仍为代码任务/代码导师；本地控制台的角色选择框同样提供三个角色。

watch 也可通过本地控制台使用：在浏览器里选择项目和站点，再暂停、继续或结束会话。

零浏览器扩展、零 Native Messaging 注册。架构沿用 Chat Broadcast 的本地动作协议思路，把「扩展 + Native Host」替换为「**Playwright 驱动专用浏览器实例**」。

## 架构

```
node src/cli.mjs ask deepseek "跑一遍测试并总结失败原因"
  │
  ├─ src/loop.mjs          Agent Loop：发任务 → 解析动作 → 执行 → 结果回填 → …… → done
  ├─ src/host-actions.mjs  本地执行器：read / ls / search / run（Host Root 路径边界）+ mcp 桥接
  ├─ src/mcp-client.mjs    最小 MCP stdio 客户端：JSON-RPC 2.0 / 超时 / 进程树终止
  ├─ src/control-server.mjs 本地控制台：watch 会话启停与暂停/继续
  ├─ src/protocol.mjs      payload 构造（协议说明 / 结果回填 / 收尾请求）
  ├─ src/page-driver.mjs   Playwright 驱动：打开站点页、注入脚本
  ├─ src/page-script.mjs   页面端脚本：填输入框 → 点发送 → 观看生成 → 提取回复
  └─ src/sites.mjs         各站点选择器配置（移植自 web-tool content/*.js）
```

一轮的完整流程：

1. 首条 payload = 协议说明 + 你的任务，由页面脚本填进聊天输入框并发送。
2. 网页 AI 若需要操作文件，在回复里嵌 ```host 围栏块（JSON 数组）：

   ````
   ```host
   [{"op":"ls","path":"src","recursive":true},
    {"op":"read","path":"package.json"},
    {"op":"run","path":"tests/app.test.js","args":[]}]
   ```
   ````

3. 本地执行（工作目录 = Host Root），结果作为下一轮消息发回。
4. 循环，直到 AI 输出 ```done 总结块，或预算耗尽（轮数 / 时长 / 停滞）。

页面端提取回复时会把 `<pre>` 代码块重建为 ``` 围栏（语言取自 `language-xxx` 类名），因此 ```host 动作块能完整存活；解析器对没有围栏的裸 JSON 动作数组也有兜底。

## 安装

```powershell
npm ci
```

需要 Node ≥ 20。浏览器按顺序回退：系统 Chrome → 系统 Edge → Playwright 自带 Chromium（都没有时 `npx playwright install chromium`）。

## 用法

### 1. 一次性初始化（登录）

```powershell
npm run setup
```

会打开一个**专用浏览器实例**（profile 在 `~\.file-tool\chrome-profile`，与你日常浏览器完全隔离）。在里面登录你要用的聊天网站，然后关窗。登录态持久化，之后免登录。

### 2. 派任务

```powershell
node src/cli.mjs ask deepseek "运行 tests/parse.test.mjs，说明测试结果和关键断言"
node src/cli.mjs ask chatgpt "读 package.json 和 src/，给出项目结构说明" --root D:\my-project
node src/cli.mjs ask claude "运行 tests/host-actions.test.mjs，分析失败用例并给出修复建议"
```

选项：

| 选项 | 默认 | 说明 |
|---|---|---|
| `--root <dir>` | 当前目录 | 已存在的 Host Root 目录；AI 只能读/运行其中的文件 |
| `--rounds <N>` | 12 | 最大轮数，须为正整数 |
| `--minutes <N>` | 20 | 总时长上限，须大于 0 |
| `--watch <N>` | 240 | 单轮等待回复的秒数，须大于 0 |
| `--headless` | 关 | 无头运行（真实站点有反自动化风险，慎用） |
| `--role <code\|text>` | `code` | 选择代码任务或文本目录问答；`text` 与 `--diagnose`/`--audit` 不同时使用 |

### 故障排查任务

在 `ask` 后加 `--diagnose`，会使用排障模板，引导网页模型先定位代码证据、验证少量假设，再给出含相对文件路径与行号、测试运行结果、原因判断和下一步的结论。普通 `ask` 的行为不变。

```powershell
node src/cli.mjs ask chatgpt "启动时报错 E42，请定位原因" --root D:\my-project --diagnose
```

排障模板只使用现有 `search` / `read` / `ls` / `run` 动作，不新增文件写入入口。`run` 会真实执行获准的测试文件，测试本身可能修改文件或读取其他内容；应在任务描述中指定可安全运行的测试。测试无法运行或故障无法复现时，结论应明确区分已验证事实与推测。最终回复由网页模型生成，仍需结合 Receipt 中的动作记录和退出码核对。

### 文档核查任务

在 `ask` 后加 `--audit`（或 `--root` 指向目标项目后直接核查其 README 承诺），会使用文档核查模板：引导网页模型按**四段结构**输出结论——**①文档承诺**（引用文档原文与出处）→ **②代码证据**（`文件:行号` + 实现要点）→ **③验证结果**（分「已运行验证 / 仅代码确认 / 无法验证」三档，各附证据）→ **④未确认项**（不一致处、待人工确认点，明确区分事实与推测）。

```powershell
node src/cli.mjs ask deepseek "核查 README『内容搜索（search）』小节的承诺" --root D:\my-project --audit
```

约束与行为：

- `--audit` 与 `--diagnose` **互斥**，且仅适用于代码任务角色（`--role code`，默认）；
- 发现文档与代码不一致时，模板要求**不修改任何文件**，差异写入④并附建议；
- 循环会校验结论的四段完整性：缺段时自动请求补全，最多尝试 2 次；补全后仍缺段，任务以 `audit-incomplete` 结束（退出码 2），Receipt 的 `auditMissing` 列出缺失段落，不视为成功。四个标题必须按顺序从新的一行开始（可带编号或 Markdown 标题），每段都要有正文。

### 文本目录问答

把 `--root` 指向需要查阅的文本目录，并选择 `--role text`：

```powershell
node src/cli.mjs ask chatgpt "审批时限是多少？请引用出处" --root D:\notes --role text
node src/cli.mjs chat chatgpt --root D:\notes --role text
node src/cli.mjs watch chatgpt --root D:\notes --role text
```

文本角色默认只用 `ls`、`search`、`read` 取材，按文件行号引用来源；找不到答案或材料相互矛盾时应说明不确定性。现有 Host Root 沙箱、敏感路径过滤和返回长度上限同样适用。目录内的代码文件、测试文件及 `run` 执行器没有被移除；文本角色的提示词不会主动要求运行它们。

代码导师、文本问答和任务执行三个角色分别登记聊天与 watch 断点。若另一角色仍有未确认的 watch 动作，切换角色启动旁观会被拒绝；应先返回原角色和原聊天完成人工核对。目录中的单个文件超过 1 MB 时，`search` 会跳过该文件；可用 `read` 分段查看。

结束时输出 Receipt（JSON）：`endReason`（complete / round-limit / time-limit / stalled / driver-error；`--audit` 还可能返回 audit-incomplete）、每轮动作清单、run 的 exit code 与输出尾巴、最终总结。普通任务保持原有字段；只有 audit 校验失败时才增加 `auditMissing`。

### 3. watch 旁观执行（在网页上聊，工具当"手"）

```powershell
node src/cli.mjs watch deepseek --root D:\my-project
```

默认 `--role code` 时，启动后工具会自动发送导师开场白（教会网页模型 host 动作协议），然后你**直接在网页输入框里**和导师聊天。每条导师回复按二选一规则：取材料时只发 ```host 动作块，不要求你回答；教学时只讲解并提问，不发动作块。`--role text` 发送文本问答开场白；`--role task` 发送任务执行开场白并等待你给出明确任务，任务到达前不调用工具，之后连续执行到完成、无法完成或需要你决定。三种角色的动作结果都以「[Chat2Local 自动回填]」消息发回对话。网页回填瞬时失败时会保留同一份结果并自动重试，不会重复执行本地动作。终端显示执行日志；Ctrl+C 退出。回填时请勿同时在网页输入框打字。

**压缩续接（线程过长时换新线程）**。网页线程越长质量越退化，而线程本身不受工具控制；压缩续接把旧线程的状态搬进新线程，分三步、全程人在环：

1. watch 终端输入 `压缩`（compact）：向当前线程发一条压缩请求，模型输出 ```summary 围栏摘要（不调用任何工具）。watcher 捕获摘要后终端提示待确认——此时什么都没保存。
2. 终端输入 `保存摘要`（save-summary）：确认后才把摘要存进该目录与角色的线程登记；不确认可忽略，或重新 `压缩` 再来一次。
3. 之后对该目录与角色 `watch --new` 开新线程时：检测到已存摘要则随开场白注入新线程（开场白注明"事实来源仍以本对话与实际工具结果为准"），取出即清除，一个摘要只注入一次。新线程 URL 覆盖旧线程登记——原线程仍在网站上，可手动回看。

摘要只保存你确认过的内容，且只存本机 `threads.json`；不自动触发、不自动发送。

**MCP 工具桥接（可选）**：加 `--mcp <脚本>` 把本地 MCP server（Node 脚本，stdio JSON-RPC）的工具暴露给网页模型，`--mcp-arg` 可重复传参（如多个授权目录）：

```powershell
node src/cli.mjs watch deepseek --root D:\my-project `
  --mcp D:\ai-project\file-tool\demo\mcp-search-server.mjs `
  --mcp-arg D:\other-project
```

启动时会探测 server 的工具列表（失败只降级、不注入执行器，不影响其他动作），并把**工具目录**写进开场白：每个工具一条，含全部必填参数的调用示例与参数说明（来自 server 的 inputSchema；数组、对象、数字、布尔等保持对应 JSON 类型）。调用 JSON 不会被字符上限截断；若完整示例本身超过单行上限，该工具不会进入目录或获得授权。工具目录同时是**执行允许列表**——展示多少个（上限 12 个，超出不授权），执行端就只放行多少个；未配置允许列表或调用目录外工具都会被本地拒绝。**续接旧聊天时总会补发一条能力更新**，声明当前目录为准；中途启用、更换或关闭 `--mcp` 都会覆盖旧目录。能力更新发送失败或状态不明时会在启动 watcher 前停止，等待人工核对，不会在目录尚未确认时开放 MCP 执行。

**常驻会话**：每个 watch 进程独享一个 MCP server 进程（目录发现与所有调用走同一连接，server 的内存状态与会话状态跨调用保留）；控制台暂停时保留连接，退出时统一释放。调用按**串行**执行，忙时的调用立即返回忙碌、不排队。两类失败严格区分：工具自身报错是**普通失败**，照常回填后连接继续可用；而**请求已发出但结果不明**（超时、断线、崩溃、单帧超过 1MiB 接收上限）会立即停用连接、停止本批次后续动作与自动回填、保留未确认断点等人工核对——不会自动重连或重放。stderr 诊断尾部最多保留 4 KiB 原始字节。server 通知目录变化（tools/list_changed）时不杀连接：在途调用照常完成，工具目录自动重新发现，**授权保持冻结（只缩不扩）**；目录更新会在当前批次结束后同步到原聊天，同步失败或发送状态不明则停止旁观并留下待人工核对断点。退出顺序经过设计（停 watcher 信号 → 关 MCP → 等 watcher 收尾 → 关浏览器），Ctrl+C 不会被在途的工具调用拖住。

watch 的动作日志与结果不明停批提示只显示 MCP 工具名及固定的参数字段名，不显示参数值或其他字段名。需要保留具体调用证据时，应在专用测试聊天中人工核对并整理脱敏记录；P48 的现场记录见 `docs/runs/P48-field-run.md`。

**工具较多或需要会话状态的外部 server**：`--mcp-allow <工具名>` 可重复，显式授权一个工具子集（如浏览器 server 只授权 navigate/snapshot/click/evaluate）；`--mcp-arg=<值>` 等号形式可传以 `--` 开头的 server 旗标（如 `--headless`）。watch 终端里输入 暂停/恢复 可控制旁观而不释放 server 会话——外部工具的会话内状态（如浏览器页面）跨暂停保留。

**自带只读 git server（`demo/mcp-git-server.mjs`）**。让网页模型查看 Host Root 所在 git 仓库的状态、未暂存/已暂存 diff 与提交历史，也为后续写入类操作提供"diff 先行"的审查兜底。四个工具全部只读：`git_status` / `git_diff_unstaged` / `git_diff_staged` / `git_log`：

```powershell
node src/cli.mjs watch deepseek --root D:\my-project --role task `
  --mcp D:\ai-project\file-tool\demo\mcp-git-server.mjs
```

仓库范围在**启动时冻结**：缺省取 Host Root，也可 `--mcp-arg <其他仓库路径>` 指定；工具入参一律不接受路径（官方 reference git server 允许调用时传 repo_path 覆盖作用域，且为 Python 包，故自带 Node 实现）。模型字符串不进入 git 参数——`git_log` 的 max/skip 只认数字。前置条件：git 在 PATH 且目录是 git 工作区，否则 server 启动即退出，桥接按探测失败降级（不注入执行器，其余动作不受影响）。输出超过 7000 字符截断并提示。

Git 状态和差异不会展示现有敏感路径规则覆盖的凭据文件；Git 识别为重命名时，只要任一端是敏感路径，整项差异都会隐藏。server 禁用 Git 外部 diff、textconv、fsmonitor 与可选索引写入；成功输出和失败诊断均有回填上限。若只有敏感文件改动，差异工具会给出隐藏提示。

**外部 server：官方 filesystem server 只读接入（`@modelcontextprotocol/server-filesystem`）**。给网页模型批量读、递归目录树、按大小列目录、文件元数据等内置四动作没有的能力：

- **固定验收版本**：`2026.8.31`，独立安装（`npm install -g @modelcontextprotocol/server-filesystem@2026.8.31`），项目零新增依赖；`--mcp` 传全局 node_modules 下其 `dist/index.js` 路径（node 直跑，与 Playwright MCP 同款接法），升级版本前先重跑现场验收。
- **必须显式 `--mcp-allow` 圈只读工具**：该 server 共 14 个工具，含 `write_file` / `edit_file` / `create_directory` / `move_file` 四个写入工具——不圈定就默认授权目录前 12 个，等于接入非只读 server（扩权，需你明确决定）。只读用法授权这九个：`read_text_file`、`read_multiple_files`、`read_media_file`、`list_directory`、`list_directory_with_sizes`、`directory_tree`、`search_files`、`get_file_info`、`list_allowed_directories`（另有 `read_file`，是 `read_text_file` 的旧别名，语义重复不重复授权；`read_media_file` 返回 base64，文本聊天场景可不授权）。
- **作用域启动冻结**：授权目录来自启动参数（`--mcp-arg <目录>`，可重复传多个），每次调用的路径越界会被 server 拒绝（2026-09-27 探测验证：读取授权目录外的 `C:/Windows/win.ini` 被拒）。这层目录与 Host Root 相互独立，由你在启动时决定圈哪个。
- **敏感路径不经过滤（与内置动作的差异）**：该 server 按 server 自身语义工作，**没有**本工具 host 动作那套敏感文件名/凭据过滤——授权目录里的 `.env`、私钥等会照常被读出。授权目录即唯一边界：不要把含凭据或会话数据的目录圈进去；它的实现是纯文件系统操作，不存在 Git server 那类外部程序执行面。需要凭据过滤时，改用下方的自带过滤版。

```powershell
node src/cli.mjs watch deepseek --root D:\my-project --role task `
  --mcp C:\Users\<你>\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js `
  --mcp-arg D:\my-project `
  --mcp-allow read_text_file --mcp-allow read_multiple_files --mcp-allow directory_tree `
  --mcp-allow list_directory --mcp-allow list_directory_with_sizes --mcp-allow search_files `
  --mcp-allow get_file_info --mcp-allow list_allowed_directories --mcp-allow read_media_file
```

**自带过滤版文件 server（`demo/mcp-fs-server.mjs`，推荐日常用法）**。与官方 server 同类能力（批量读、递归树、按大小列目录、元数据），但敏感路径语义与内置 host 动作同源——目录列举**隐藏**敏感文件并提示隐藏数量，显式读取/查看敏感路径**拒绝**（`isSensitivePath` 同一套规则，`.env.example` 等示例名不误伤）；授权根目录启动时经 realpath 冻结，符号链接/目录联接逃逸与越界一律拒绝；依赖/构建目录（`node_modules`、`.git` 等）目录树不展开；批量读对缺失/越界/敏感/超大/二进制文件逐项报错、不影响其余文件；输出超 7000 字符截断。仅需读取时用 `--mcp-allow` 授权下方四个只读工具。

读取前会分别核对**请求路径**和解析后的真实路径；目录大小清单不跟随链接查询目标。每个文件使用同一句柄、最多读取 1 MB 加 1 字节来判定上限，并检查所读内容中的全部 NUL 字节。目录仅含敏感项时仍提示隐藏数量。启动示例：

```powershell
node src/cli.mjs watch deepseek --root D:\my-project --role task `
  --mcp D:\ai-project\Chat2Local\demo\mcp-fs-server.mjs `
  --mcp-arg D:\my-project `
  --mcp-allow list_directory --mcp-allow directory_tree `
  --mcp-allow read_multiple_files --mcp-allow get_file_info
```

该 server 的默认目录也包含写入工具，仅读取时必须显式圈定上述四个工具。`--mcp-arg` 可重复传多个目录（多目录时结果带 `[R1]`/`[R2]` 标签）。跨目录内容搜索由 `demo/mcp-search-server.mjs` 提供，两者可按需任选。

**自带符号地图 server（`demo/mcp-map-server.mjs`，repo-map 式）**。一次调用给网页模型整个项目的"函数/类/方法 + 行号"紧凑地图（aider repo-map 思想的零依赖实现：行级启发式抽取 + 出现次数排序 + 字符预算），替代"反复 ls + read 摸结构"的多轮往返：

```powershell
node src/cli.mjs watch deepseek --root D:\my-project --role task `
  --mcp D:\ai-project\file-tool\demo\mcp-map-server.mjs `
  --mcp-arg D:\my-project
```

- **行号与 `read` 的 `line` 参数同坐标**（同 search 的 `文件:行号:` 约定）：地图里的 `L12` 就是 `read` 按行号读到的第 12 行——拿到地图后可直接行级精读，无需再盲读全文。
- 输出每文件一行（如 `src/foo.mjs: L3 fn alpha ×3 · L7 class Widget · L11 method run(Widget)`），被引用最多的文件排在预算前列（`×N` 为全库标识符出现次数，含声明）；预算默认 4000 字符（`maxChars` 可调，500–7000），超出截断并提示。
- 支持 `.js/.mjs/.cjs/.ts/.tsx/.jsx/.py`；行级启发式抽取可能有个别误报/漏报，行号以 `read` 实读为准。敏感路径与依赖/构建目录不进地图；请求路径与真实路径双重核对（P56 fs server 同款纪律），目录联接/符号链接不跟随遍历；授权根启动时 realpath 冻结、越界拒绝，与其他自带 server 同一套边界。

**写入与分级审批（P60 立门、P61 分级）**。自带过滤版文件 server 提供 `write_file`（`dryRun:true` 返回风险分级与新旧内容 diff，不落盘；覆盖已有文件自动留 `.bak` 备份）、`create_directory`（幂等，支持 dryRun）和 `undo_write`（逐笔撤销本会话写入，`dryRun:true` 只预览将撤销哪一笔）。`write_file` / `create_directory` / `undo_write` 受**双层门**约束：

- **server 层**（所有审批模式下强制）：拒敏感路径、越界、符号链接与二进制覆盖，单次写入上限 1 MB；
- **host 层**（Codex 式审批模式，`写入模式` 命令切换，仅本次 watch 会话有效）：
  - **逐笔询问**（默认）：每笔写入先展示 diff 预览与风险分级，等你在终端决定——`同意(y)` 执行本次 / `会话同意(a)` 本会话此工具不再询问（切换审批模式即收回；Codex 的"帮我批准"）/ `拒绝(n)` 回填拒绝原因。确认期间调用被**持有**而非拒绝：同意后同一调用直接执行，模型不消耗额外轮次；只有拒绝才回填一次。
  - **风险询问**：仅对"覆盖已有内容"（数据丢失风险）询问；新建文件、本会话已写过的文件、无变化自动放行。
  - **自动批准**（帮我批准 / `允许写入` 别名）：不再逐笔询问，备份与撤销记录仍保留。
  - **禁止**（`禁止写入`）：全部拒绝，fail-closed。

```powershell
node src/cli.mjs watch deepseek --root D:\my-project --role task `
  --mcp D:\ai-project\Chat2Local\demo\mcp-fs-server.mjs `
  --mcp-arg D:\my-project `
  --mcp-allow list_directory --mcp-allow directory_tree `
  --mcp-allow read_multiple_files --mcp-allow get_file_info `
  --mcp-allow write_file --mcp-allow create_directory
# 会话内：模型请求写入 → 终端弹出 diff 预览 → 同意(y)/会话同意(a)/拒绝(n) → 同意后同一调用直执
# 终端 撤销写入 逐笔回退（覆盖型恢复原内容、新建型删除）；写入模式 命令随时切换审批级别（切换即收回会话同意）
```

沙箱边界（授权根、敏感路径、越界、符号链接）**不随审批模式放宽**——Codex 的"完全访问"在这里等价于自动批准，这是刻意差异。建议配套使用自带 git server：写入后用 `git_diff_unstaged` 审查模型改了什么。`undo_write` 同样经过审批（逐笔询问默认展示将撤销哪一笔）；不希望模型撤销时，用 `--mcp-allow` 排除该工具即可（终端「撤销写入」不受影响）。接入**外部** server 的写入工具前，还须核实其 `dryRun` 是否真的不产生副作用；当前 host 无法验证这一点。

**首个正式有状态场景：浏览器网页检查（@playwright/mcp，`--role task`）**。让网页模型在本地测试页面上连续执行"打开 → 操作 → 检查 → 暂停恢复后继续"，接入要点：

- **固定验收版本**：`@playwright/mcp@0.0.82`，独立安装（`npm install -g @playwright/mcp@0.0.82`），项目零新增依赖；升级版本前先重跑现场验收。
- **启动参数**：`--headless --browser chrome --user-data-dir <独立临时目录>`。这里有两个浏览器，职责分开：网页聊天浏览器沿用项目专用资料目录；MCP server 及其浏览器由本轮 watch 独享（暂停保留，退出释放）。进程退出后再次启动属于**新工具会话**——即使续接原聊天，重连消息也会向模型说明：旧标签页、元素引用和页面内存状态已失效，需重新打开页面并重新获取引用。
- **授权工具**：`browser_navigate`（首次打开页面）、`browser_snapshot`（读取页面与元素引用）、`browser_click`（按当前页面引用点击）、`browser_evaluate`（读取页面内存状态并回报本地证据；执行能力较宽，仅作为本地验收的授权项，日常网页检查请按任务重新选择工具子集）。
- **示例**（从仓库根目录运行，PowerShell）：`--mcp` 必须传已安装的 Node 脚本路径，四个 `--mcp-allow` 分别传入。

  ```powershell
  $mcpScript = Join-Path (npm root -g) '@playwright/mcp/cli.js'
  $profileDir = Join-Path $env:TEMP ('file-tool-mcp-' + [guid]::NewGuid().ToString('N'))
  node src/cli.mjs watch deepseek --root (Join-Path (Get-Location) 'dev-root') --role task `
    --mcp $mcpScript --mcp-arg=--headless --mcp-arg=--browser --mcp-arg chrome `
    --mcp-arg=--user-data-dir --mcp-arg $profileDir `
    --mcp-allow browser_navigate --mcp-allow browser_snapshot `
    --mcp-allow browser_click --mcp-allow browser_evaluate
  ```

  真实 MCP 及 watch 暂停/恢复的本地可重复验收：`node scripts/verify-browser-mcp.mjs --mcp $mcpScript`。脚本启动临时 Lab 页面、独立外部浏览器，并核对页面只加载一次、会话与标记不变、展开态跨暂停恢复保留、server 退出；在 Windows 上还核对外部 Chrome 进程数为零。脚本生成工具动作，用于验证执行链路；网页模型自行构造调用的现场记录另见 `PLAN.md`。
- **清理**：退出 watch 时按序释放（停 watcher 信号 → 关 MCP client（终止 server 进程树）→ 关聊天浏览器），外部浏览器随 server 进程树一并退出。
- **边界**：工具允许列表不限制导航网址；本轮以本地页面验收，不据此宣称已具备"仅访问本地网站"的强制隔离。
- **跨 server 兼容**：同一桥接已用第二个独立实现复验——`chrome-devtools-mcp@1.10.1`（官方 TypeScript SDK 实现，`--headless --isolated`，授权 new_page/take_snapshot/click/evaluate_script 四工具），同一 Lab 流程通过：模型按该 server 的工具目录（pageId/uid 参数方案，与 Playwright 不同）自行构造调用，页面状态跨调用与暂停恢复保持，本轮新建浏览器进程检查 clean。复跑步骤与脱敏现场摘录见 `docs/runs/P50-cross-server-field-run.md`。桥接机制不绑定单一 server。

模型用 `{"op":"mcp","tool":"search_files","args":{"query":"关键词"}}` 调用，结果照常回填。信任边界：server 脚本由你指定（模型永远不能选择 server 或命令），工具入参的路径语义由 server 自行约束——接入非只读 server 等于扩权，请只桥接受信 server。仓库自带的示例 server 只提供只读的 `search_files`：一次调用可搜索多个授权目录（内置 `search` 只有单个 Host Root，做不到），输出 `[R1] 相对路径:行号: 内容`。互操作性由独立实现的 fixture server 回归验证（`tests/mcp-interop.test.mjs`）：不同 protocolVersion、CRLF 行尾、主动 notification、schema 缺失、跨块多字节字符都能正确处理；常驻语义（状态保留、结果不明、串行、接收上限等）由 `tests/mcp-resident.test.mjs` 锁定。

旁观诊断文件 `~/.file-tool/watch-trace.txt` 只记录生成状态、字符数和变化标记，不再记录聊天正文；旧版本留下的历史日志不会自动删除，分享日志前请检查并脱敏。

**按项目和角色续接对话**：线程按「站点 + 目录 + 角色」登记在 `~\.file-tool\threads.json`。默认代码导师沿用旧版登记键；文本问答和任务执行分别使用独立登记，切换角色不会续接另一角色的聊天。watch 断点也按同样的角色键隔离；任一角色存在未确认动作时，其他角色不能绕过人工核对。再次启动同一组合时打开上次对话并发对应角色的短重连消息；新组合开新聊天。命令行模式下旧线程失效会清对应角色的登记并改开新聊天；想强制重开可加 `--new`。

如果想随时暂停，改用本地控制台启动 watch：

```powershell
npm run console          # 或直接双击仓库根目录的 控制台.bat
```

控制台启动后会**自动用默认浏览器打开页面**（固定地址 `http://127.0.0.1:3210/`，可收藏；端口被占用时自动换随机端口）。页面会**预填上次使用的目录、站点和角色**——通常只需点一下「启动旁观执行」。想省掉这一次点击：

```powershell
npm run console -- --root D:\my-project --site deepseek --autostart
```

控制台同样**按项目续接**：电脑或控制台重启后，选中同一网站和项目目录，页面会显示是否已有历史聊天登记；点击「启动旁观执行」，会打开该项目上次的聊天线程并发短重连消息；不会仅因打开控制台就自动续连（除非显式使用 `--autostart`）。首次使用的新项目会在网页产生线程地址后登记下来。登记文件写入时先保存临时文件再替换；若既有文件损坏或无法读取，会提示错误并保留文件，不把它当作空登记覆盖。若旧线程被网站重定向到首页或续接失败，控制台会报错并保留原登记，**不会悄悄开新聊天**；可检查登录状态后重试，或在命令行用 `watch --new` 明确新建。点击「暂停」后，当前正在执行的动作及本次结果回填尝试会先结束，随后停止处理新的网页回复；专用浏览器和聊天页面继续保留。如果回填暂时失败，结果会保留，继续后重试。点击「继续」会在**同一页面、同一聊天上下文**中恢复，并处理暂停期间最后一条尚未处理的回复。暂停期间不要依赖自动回填；若网页产生多条回复，恢复时不会逐条补处理历史消息。点击「结束会话」会关闭专用浏览器。控制台进程退出后，运行中的旁观会话会结束，但下次选择同项目可续接已登记的网页聊天。请勿同时运行控制台和另一条使用同一专用浏览器资料目录的命令。

**中断动作恢复**：watch 会把“执行中／回填中／目录同步待核对／已处理”的最小断点保存在本机 `~/.file-tool/watch-checkpoints.json`，只含阶段、回复指纹与计数，不保存聊天正文、动作参数或结果。若程序在动作、回填或目录同步期间退出且结果未确认，下次打开原聊天会停在「等待人工核对」，不会先发重连消息或重跑上次的 `run`。请在专用浏览器查看原聊天和本地实际结果，再点击「已核对，继续旁观（不重试上次动作）」；未收到的结果不会由程序凭猜测补发，可在网页明确要求导师重新提出所需动作。命令行 `watch` 则需核对后显式加 `--confirm-recovery`。断点未确认时 `watch --new` 不能绕过。运行中只有明确未发送的回填失败才自动重试；发送状态不明时停止并等待人工核对。此机制防止中断后静默重放，不承诺对网页消息严格“恰好一次”。

控制台的「网页连接」与「会话状态」分开显示：**健康**表示专用网页仍有可用输入框，**已停止**表示浏览器或标签页已关闭，**状态不明**表示暂时无法确认（例如找不到输入框、探测超时）。状态不明不会自动关闭浏览器或新建聊天；请先检查登录状态和专用窗口。此检查只看页面控件是否存在，不读取聊天正文或登录信息。

如果提示“专用浏览器资料目录正在被使用”，可能是另一个控制台仍在运行，也可能是上次退出后浏览器窗口仍未关闭。请先确认并关闭占用该专用目录的窗口，再重试。工具不会为了启动新会话自动结束已有浏览器，以免打断正在进行的聊天。

若控制台提示「未找到所选网站和项目的历史聊天登记」，但旧聊天仍在网站的历史列表中：先在该网站打开原聊天，复制地址栏链接；回到控制台确认网站和项目目录，展开「找回以前的聊天」，粘贴地址并点击「绑定旧聊天」，然后再点击「启动旁观执行」。绑定只替换**所选网站 + 项目目录**的线程登记；仅接受该网站自己的 HTTPS 聊天地址。若链接属于另一个受支持的网站，控制台会明确提示切换聊天网站，不会自动改动选择或保存登记。绑定请求只发给本机控制台，日志不会显示该地址。旧版本未登记或覆盖掉的线程无法由程序自动推断，需这样手动绑定一次。

### 4. chat 导师模式（终端 REPL）

```powershell
node src/cli.mjs chat deepseek --root D:\my-project
```

终端 REPL：你提问 → 网页 AI 按需读代码/跑测试 → 讲解直接回给你 → 你继续追问。聊天上下文保持在同一页面（它记得前面聊过什么），浏览器保持打开直到你退出（`exit` / `退出` / Ctrl+C）。

```
导师正在熟悉项目……
导师> 这个项目是 ESM 布局：src/index.js 是入口，tests/ 有三组用例……
你> 入口里为什么要先初始化配置？
导师> 因为 src/config.js 在启动时做了环境探测……
你> exit
```

要点：

- **结束时机在你手里**：协议明确告诉导师"不要输出 done、不要问是否继续"，每条回复都面向你；
- **内置带教纪律**：开场白把导师人设和教学规则写死——每轮只讲一小步、讲解必须以反问结尾、你答上一轮反问前不推进新知识点、源码先给路径+行号再拆解、关键代码先让你猜再揭晓、说"没懂/太快"就退回换讲法、严禁编造不存在的代码。想调整教学风格，改 `src/protocol.mjs` 里的 `chatIntroPayload` 即可；
- 每个提问默认最多 6 个动作轮（`--turn-rounds` 可调），超限会提示回复可能不完整；
- 显示时自动剥掉 ```host / ```done 块，只给你看讲解正文；代码讲解用的 ```js 等围栏保留。

## 安全模型

这是本项目与 web-tool 的关键差异，也是选型时确认过的决策：

1. **专用浏览器实例**：Playwright `launchPersistentContext` + 独立 `--user-data-dir`，使工具使用的聊天登录态与日常浏览资料分开。独立资料目录能减少数据交叉，不构成操作系统隔离；**不要在这个实例里登录聊天网站以外的账号。**
2. **root 沙箱**：所有路径必须是 Host Root 下的相对路径；绝对路径、`..`、盘符、UNC 一律拒绝。动作执行前还会解析真实路径，阻止通过符号链接或 Windows 目录联接跳到 root 外；指向 root 内部的链接仍可正常读取和运行。
   项目内的 `.env`、`.env.*`（`.env.example` 等样例除外）、`.ssh`、常见私钥与凭据文件也会被 `read` / `ls` / `search` 拒绝或从清单中隐藏；请求路径与链接解析后的路径都检查。依赖/构建目录只是在递归时跳过，不等同于敏感文件禁读。此规则不能阻止获准运行的脚本自行读取或打印凭据；运行陌生脚本前仍需人工判断。
3. **内置动作与可选写入**：`read` / `ls` / `search` / `run` 没有文件写入动作；`run` 仅接受白名单扩展名，默认 120s 超时（超时终止派生进程树），输出封顶截断。运行即以当前用户身份真实执行，Host Root 不是进程隔离。另行启用 MCP 写入工具时，host 默认逐笔审批；自带 server 还实施路径约束，外部 server 的路径和副作用语义由其自身决定。
4. **上下文防爆**：文件 read 使用流式 UTF-8 解码且 12k 字符截断（可 offset 续读，不把大文件整体载入内存）、read/ls 目录清单 500 条目封顶、run 输出 8k 封顶、每轮最多 6 个动作、回填 payload 总量 16k 封顶。`read` 的 `offset`/`length` 从 0 开始按 UTF-16 字符单位计数，并非行号；分段回填会显示请求的区间。

## 测试

```powershell
npm test        # 单元测试：CLI / 沙箱 / mock 服务 / 解析 / 协议 / 控制台 / 任务、导师与旁观循环（无需浏览器）
npm run smoke    # 端到端自测：mock 聊天页 + 无头浏览器，验证任务模式 ls/read/run 全链路
npm run smoke:chat # 端到端自测：验证导师模式（开场白 → 动作 → 讲解 → 追问）
npm run smoke:watch # 端到端自测：验证旁观执行（网页动作 → 自动执行 → 回填）
npm run smoke:console # 浏览器自测：暂停/继续 + 重启后绑定旧聊天续接（模拟后端）
```

smoke 不需要任何账号：`scripts/mock-chat.html` 仿真实站点（输入框/发送/流式生成/stop 按钮/`<pre>` 渲染围栏），分别内置任务、导师与旁观执行剧本；控制台冒烟使用模拟会话。每次运行使用独立临时浏览器 profile；聊天页冒烟默认尝试本地 8642 端口，若已被占用会自动切换到空闲端口，因此这些 smoke 可以并行执行。

## 站点改版怎么办

症状是 `no-composer`（找不到输入框）或 `watch-timeout`（等不到回复）。改 `src/sites.mjs` 里对应站点的选择器列表即可；填充/观看/提取的骨架逻辑在 `src/page-script.mjs`，一般不用动。

**故障定位器**：控制台健康栏和终端错误会显示**细分原因**（输入框不可见 / 输入框选择器未命中但回复区正常 / 输入框与回复区都未命中）并附带处理建议（弹窗遮挡→关弹窗重试；未登录→`npm run setup`；改版→更新 sites.mjs 对应字段）。需要更详细的结构取证时运行：

```powershell
node scripts/probe-site.mjs deepseek
```

它输出脱敏普查 JSON（各组选择器的命中数/可见数 + 细分原因，**不含任何聊天正文**）——留存健康基线、或在站点改版时采集失败样本都靠它。

**「导师明明发了动作块，工具却说没有」**：多半是站点渲染把 JSON 的引号/冒号转成了中文标点（“ ” ： ，），解析失败后被当成纯讲解。解析器已内置归一化兜底（弯引号/全角标点转 ASCII 后重试）。如果还遇到：终端会提示并把原始回复存到 `~/.file-tool/last-reply.txt`，打开看 JSON 到底长什么样，据此再调 `src/parse.mjs`。

## 已知限制

- 站点反自动化：以真实 Chrome 指纹 + 持久登录态 + 有头模式运行，风控最弱；`--headless` 或高频使用可能触发站点验证码。
- 一次一个任务一个站点；没有 web-tool 的多 Target 群发/编排。
- 模型不守协议（不输出合法 JSON、伪造操作格式）时，靠回填的错误信息自纠错；连续 2 轮相同回复判定停滞终止。
