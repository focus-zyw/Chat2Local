# file-tool：公开展示与复现

file-tool 让网页聊天通过本地协议请求读取文件、列目录、搜索内容和运行测试。它由本地 Node.js 进程执行动作，再把结果回填到浏览器中的对话。项目由郑焱文设计、验收，借助 AI 完成代码实现。

## 60 秒复现核心流程

环境：Windows 10/11、Node.js 20 或更新版本，以及 Chrome、Edge 或 Playwright Chromium。无需聊天网站账号或 API Key。

```powershell
git clone https://github.com/focus-zyw/file-tool.git
cd file-tool
npm ci
npx playwright install chromium
npm run demo
```

`npm run demo` 会启动本地模拟聊天页和浏览器，创建临时示例文件，走完任务、故障诊断和文本问答三条流程，并清理临时文件。成功时应看到：

```text
SMOKE PASSED — ls / read / run 全链路 OK
SMOKE DIAGNOSE PASSED — search / read / run / 证据结论全链路 OK
SMOKE TEXT PASSED — 文本问答及来源行号全链路 OK
```

其中故障诊断示例会故意执行失败测试，以验证搜索、定位、引用代码行号和报告退出码的过程；演示命令整体成功时退出码为 0。

运行完整测试：

```powershell
npm test
```

## 实际网站使用

根据 [README 安装与用法](../README.md#安装) 先运行 `npm run setup`，在专用浏览器中自行登录支持的聊天网站，再以 `--root` 指定要授权读取的项目目录。真实网站的页面结构会变化，自动化兼容性取决于当前站点版本和登录状态；公开演示用本地模拟页固定复现核心流程。

`--root` 限制文件动作的目标范围，但这不是操作系统级隔离。特别是 `run` 会以当前用户身份执行文件；只对可信项目启用，并先确认工作目录及脚本内容。不要把密钥、私人文档或浏览器登录资料放入公开仓库。

## 代码入口

- `src/loop.mjs`：对话、动作执行、结果回填与完成回执。
- `src/host-actions.mjs`：`read`、`ls`、`search`、`run` 的本地实现。
- `src/page-driver.mjs`、`src/page-script.mjs`：浏览器与网页对话交互。
- `src/sites.mjs`：各聊天站点的页面适配配置。
- `scripts/smoke.mjs`、`scripts/mock-chat.html`：无需外部账号的可复现演示。

本仓库以 MIT 许可证发布。演示验证的是本地模拟页面，不代表所有聊天网站在任意时间都通过实测。
