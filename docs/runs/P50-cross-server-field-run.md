# P50 Chrome DevTools MCP 跨 server 现场记录

本文件依据 2026-09-27 的本地 `dev-root` task 角色现场输出整理，是人工核对后的脱敏摘录，不是完整聊天记录或原始终端日志。本地原始 `.log` 受 `.gitignore` 排除，仍保留在原机器；本文件作为可跟踪的复核材料。下文的 `sessionUuid` 是本地 Lab 页生成的测试标识，不是网页账号会话。

## 被测范围与复跑步骤

- 被测桥接代码：P49 后的实现，文档提交 `694c90d` 的父提交 `67cc68d`。原始终端输出没有打印 Git SHA，归属依据为当轮提交记录。
- 外部 server：本地全局安装的 `chrome-devtools-mcp@1.10.1`，其 npm `bin.chrome-devtools-mcp` 入口为 `build/src/bin/chrome-devtools-mcp.js`。当轮终端日志记录了 MCP 协议 `2024-11-05`，没有独立打印 npm 包版本；固定版本依据当轮安装记录，复跑前应核对本机包版本。
- 环境：Windows、PowerShell、Chrome headless、`--isolated` 临时浏览器资料目录、DeepSeek 专用测试聊天、`dev-root` Host Root。默认续接该目录和 task 角色登记的测试线程。
- 启动 Lab（终端 A，从仓库根目录）：`node scripts/lab-server.mjs 8765`。确认实际端口；若 8765 被占用，Lab 可能使用其他端口，须同步调整测试任务网址。
- 安装与启动 watch（终端 B，从仓库根目录）：

```powershell
npm install -g chrome-devtools-mcp@1.10.1
$mcpScript = Join-Path (npm root -g) 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'
node src/cli.mjs watch deepseek --root (Join-Path (Get-Location) 'dev-root') --role task `
  --mcp $mcpScript --mcp-arg=--headless --mcp-arg=--isolated `
  --mcp-allow new_page --mcp-allow take_snapshot `
  --mcp-allow click --mcp-allow evaluate_script
```

- 自然语言复跑任务范本：请打开本地 Lab 页 `http://127.0.0.1:8765/`，读出页面随机标记与会话短 ID，点击「展开详情」，再次检查两者不变且详情已展开；暂停并恢复 watch 后，再读取当前页的 `window.__lab`，将 `event=model-verify` 的 JSON 发送到本页 `/beacon`，最后报告观察结果。让模型根据目录自行构造调用，不提供 host JSON，也不把标记传回给模型。**这是依据当轮验收目标整理的复跑任务，原始聊天任务逐字文本未保存。**
- 暂停发生在第四次工具结果回填之后，终端输入「暂停」再输入「恢复」；第五次调用在恢复后执行。结束 watch 后查询 Lab 的 `/beacons`，并检查本轮新建的浏览器进程是否退出。复跑期间不并行运行其他 watch 会话。

## 现场输出摘录

| 顺序 | Host 可见记录 | 能证明的范围 |
| --- | --- | --- |
| 待命 | 重连说明后回复 176 字符，无动作；`MCP server 就绪`出现一次，授权 4 个工具、其余 26 个未授权 | 明确任务前没有工具调用；连接成功并同步目录 |
| 1 | `new_page`，参数键仅显示 `url`，其值省略；`ok`，回填 1 成功 | 建页并导航 |
| 2 | `take_snapshot`，1 个字段名及全部值省略；`ok`，回填 2 成功 | 读取页面 |
| 3 | `click`，3 个字段名及全部值省略；`ok`，回填 3 成功 | 点击页面元素 |
| 4 | `take_snapshot`，1 个字段名及全部值省略；`ok`，回填 4 成功 | 再次读取页面 |
| 暂停 | 终端显示「已暂停」与「已恢复旁观」 | watch 会话跨暂停继续 |
| 5 | `evaluate_script`，参数键仅显示 `function`，另 1 个字段名及全部值省略；`ok`，回填 5 成功 | 恢复后读取页面内存并发送取证请求 |
| 收尾 | 最终回复 1306 字符，无动作；`Watcher 已停止，浏览器已关闭`；新建浏览器进程检查为 `clean` | 本轮没有第六次调用，浏览器资源已清理 |

动作日志按固定字段名白名单脱敏，未保存 `pageId`、`uid` 或函数体。模型依照该 server 的参数结构自行构造调用，是由目录、成功调用及页面效果共同支持的判断；本记录不能独立还原完整动作 JSON，也不能证明模型内部决策。

## Lab beacon 取证

| event | sessionUuid | marker | detailsOpen |
| --- | --- | --- | --- |
| load | 同一 Lab 测试 UUID（前缀 `edb448f7`） | `LAB-m1k7b50c` | false |
| expand | 同上 | `LAB-m1k7b50c` | true |
| model-verify | 同上 | `LAB-m1k7b50c` | true |

原始取证恰有上述三条记录；只有一次 `load`，后两条沿用同一页面内存标记，详情在暂停恢复后仍展开。终端仅记录一次「MCP server 就绪」；server 内部握手次数未独立测量，不能从就绪日志推定。退出后浏览器进程检查以本轮新建进程的创建时间为口径，结果为 `clean`；日志没有单独保存 server PID 的退出检查，因此不将 `clean` 解释为独立的 server 进程测量。server 释放由 watch 既有收尾路径负责。

本次是第二个真实 MCP server 的现场兼容证据。运行代码未因该 server 修改；结果支持本地 stdio、单 server、串行文本工具在该浏览器场景下可复用，不推出远程传输、多 server 或任意 MCP server 的兼容结论。
