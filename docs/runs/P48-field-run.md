# P48 真实网页模型浏览器 MCP 现场记录

本文件依据 2026-09-27 的专用 `dev-root` 测试日志整理。保留调用顺序、状态变化和清理结果；删除本机路径、浏览器资料目录和聊天地址。它是人工核对后的脱敏摘录，不是完整聊天或原始终端日志。以下 `sessionUuid` 是本地 Lab 页随机生成的测试值，不是网站登录会话。

## 版本与复跑步骤

- 被测代码：P48 动作日志实现提交 `cd4e6ea`。原始终端输出没有打印 Git SHA，此处根据当轮提交记录归属，不能把它当作终端独立测量值。
- 外部 server：按本轮固定安装方案使用 `@playwright/mcp@0.0.82`，本次终端日志只记录 MCP 协议版本 `2024-11-05`，没有独立打印 npm 包版本；脚本生成动作的技术验收另由 `scripts/verify-browser-mcp.mjs` 读取并断言包版本。
- 环境：Windows、PowerShell、headless Chrome、DeepSeek 专用测试聊天、`dev-root` Host Root、独立临时浏览器资料目录。网页聊天续接已有 task 角色线程。
- 启动 Lab（终端 A）：`node scripts/lab-server.mjs 8765`。确认输出端口为 `8765`；如端口被占用，Lab 会选择其他端口，须同步替换下述任务网址。
- 启动 watch（终端 B，从仓库根目录）：

```powershell
$mcpScript = Join-Path (npm root -g) '@playwright/mcp/cli.js'
$profileDir = Join-Path $env:TEMP ('file-tool-mcp-' + [guid]::NewGuid().ToString('N'))
node src/cli.mjs watch deepseek --root (Join-Path (Get-Location) 'dev-root') --role task `
  --mcp $mcpScript --mcp-arg=--headless --mcp-arg=--browser --mcp-arg chrome `
  --mcp-arg=--user-data-dir --mcp-arg $profileDir `
  --mcp-allow browser_navigate --mcp-allow browser_snapshot `
  --mcp-allow browser_click --mcp-allow browser_evaluate
```

- 在专用测试聊天下达的自然语言任务（无 host JSON，也不传回随机标记）：

> 明确任务（此前会话已失效，请重新打开页面）：用浏览器检查页面 http://127.0.0.1:8765/ 。①打开页面并读取「会话标记：」后面 LAB- 开头的标记和括号里的会话短 ID；②点击「展开详情」按钮；③再次读取页面，核对标记与会话短 ID 和第一次一致、详情已展开；④用 browser_evaluate 在页面里执行代码：读取 window.__lab 的全部字段，以 JSON 为 body、event 字段填 model-verify，POST 到本页 /beacon；⑤用 done 块给出结论与证据。每条回复只发一个 host 块。

- 暂停与恢复：第四次调用回填后，在 watch 终端输入「暂停」，确认暂停，再输入「恢复」。结束时退出 watch，查询 Lab 的 `http://127.0.0.1:8765/beacons`，并按专用资料目录核对本轮 server 与浏览器进程是否退出。

## 现场输出摘录

| 顺序 | Host 可见记录 | 取证意义 |
| --- | --- | --- |
| 待命 | 重连汇报回复 165 字符，无动作；MCP server 就绪 1 次，授权 4 个工具、其余 21 个未授权 | 明确任务前零调用；旧工具会话失效说明已送达 |
| 1 | `browser_navigate`：参数含本地 Lab URL → ok，回填 1 成功 | 打开页面 |
| 2 | `browser_snapshot`：`{}` → ok，回填 2 成功 | 模型读取页面及元素引用 |
| 3 | `browser_click`：`element=展开详情 按钮`、`target=e4` → ok，回填 3 成功 | 模型使用页面快照中的引用点击 |
| 4 | `browser_snapshot`：`{}` → ok，回填 4 成功 | 模型复核展开后的页面 |
| 暂停 | 终端确认「已暂停」后「已恢复旁观」 | 原 watch 会话继续 |
| 5 | `browser_evaluate`：函数开头为 `async () => { const lab = window.__lab ? JSON.parse(JSON.stringify(window.__lab)) : null; …` → ok，回填 5 成功 | 模型读取当前页面内存并发送 `model-verify` beacon |
| 收尾 | 最终回复 1060 字符，无动作；watcher 与浏览器关闭；遗留进程检查 `clean` | 未发生额外工具调用；本轮资源释放 |

上表的工具参数值仅保留本地 Lab 的已核对测试内容。模型动作的完整 JSON 和最终回答未保存；此记录能复核 Host 观察到的动作顺序与参数形状，不能独立重建模型内部决策。

## Lab beacon 取证

| event | sessionUuid | marker | detailsOpen |
| --- | --- | --- | --- |
| load | `a681634f-0787-4368-a8cc-5d6d1b76ed3a` | `LAB-e68r37f1` | false |
| expand | `a681634f-0787-4368-a8cc-5d6d1b76ed3a` | `LAB-e68r37f1` | true |
| model-verify | `a681634f-0787-4368-a8cc-5d6d1b76ed3a` | `LAB-e68r37f1` | true |

三条记录来自一次 Lab 页面加载；后两条沿用同一页面内存状态，暂停恢复后展开状态仍为 true。原始时间戳与本机路径未收录。终端仅有一次「MCP server 就绪」记录；server 内部握手次数未独立测量，不能由此推定为一次。

另有脚本生成动作的技术验收：`node scripts/verify-browser-mcp.mjs --mcp $mcpScript` 当轮通过，记录为 `serverStarts=1`、`actionCount=6`、`load → expand → script-verify`、同会话同标记、浏览器残留 0。该脚本的动作由程序生成，与上述模型现场任务分开计算。
