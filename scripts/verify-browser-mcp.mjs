/**
 * 真实浏览器 MCP 的可重复验收：使用仓库的 watch 执行器与本地 Lab 页，
 * 逐次调用外部 @playwright/mcp@0.0.82。工具动作由本脚本生成；真实网页模型
 * 自行构造动作的现场记录另见 PLAN.md，不由本脚本冒充。
 *
 * 用法：node scripts/verify-browser-mcp.mjs --mcp <全局安装包的 cli.js 路径>
 */

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpClient } from "../src/mcp-client.mjs";
import { runAction } from "../src/host-actions.mjs";
import { startWatcher } from "../src/watcher.mjs";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LAB_SERVER = fileURLToPath(new URL("./lab-server.mjs", import.meta.url));
const TOOLS = ["browser_navigate", "browser_snapshot", "browser_click", "browser_evaluate"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check, label, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
}

function startLab() {
  const proc = spawn(process.execPath, [LAB_SERVER], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-2000); });
  const ready = new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("Lab 启动超时")), 10000);
    proc.on("error", reject);
    proc.on("close", (code) => reject(new Error(`Lab 提前退出（${code}）：${stderr}`)));
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
      const match = stdout.match(/LAB-SERVER (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
  return { proc, ready };
}

async function browserProcessCount(profile) {
  if (process.platform !== "win32") return null;
  const command = "$n=(Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like ('*' + $env:FILE_TOOL_MCP_PROFILE + '*') } | Measure-Object).Count; Write-Output $n";
  return Number(execFileSync("powershell", ["-NoProfile", "-Command", command], {
    env: { ...process.env, FILE_TOOL_MCP_PROFILE: profile }, encoding: "utf8", timeout: 15000,
  }).trim());
}

async function main() {
  const index = process.argv.indexOf("--mcp");
  assert.ok(index >= 0 && process.argv[index + 1], "用法：node scripts/verify-browser-mcp.mjs --mcp <cli.js 路径>");
  const script = path.resolve(process.argv[index + 1]);
  const packageInfo = JSON.parse(await readFile(path.join(path.dirname(script), "package.json"), "utf8"));
  assert.equal(packageInfo.name, "@playwright/mcp");
  assert.equal(packageInfo.version, "0.0.82", "验收固定版本必须为 0.0.82");

  const profile = await mkdtemp(path.join(os.tmpdir(), "file-tool-mcp-verify-"));
  const lab = startLab();
  let client;
  let stop;
  let serverPid;
  try {
    const origin = await lab.ready;
    client = await createMcpClient({
      command: process.execPath,
      args: [script, "--headless", "--browser", "chrome", "--user-data-dir", profile],
      // 外部 server 的快照文件也写入本次临时目录，避免污染专用测试目录。
      cwd: profile,
    }, { startupTimeoutMs: 30000 });
    serverPid = client.proc.pid;
    const listed = await client.listTools({ timeoutMs: 30000 });
    assert.equal(listed.ok, true, listed.text);
    const names = listed.tools.map((tool) => tool.name);
    for (const name of TOOLS) assert.ok(names.includes(name), `外部 server 缺少工具 ${name}`);

    let reply = "已准备，等待明确任务。";
    const feeds = [];
    let actionCount = 0;
    const driver = {
      snapshot: async () => ({ text: reply, busy: false, changedAgoMs: 1000 }),
      deliver: async (text) => { feeds.push(text); return { ok: true }; },
    };
    stop = await startWatcher({
      driver, root: path.join(REPO, "dev-root"), role: "task", stableMs: 50, intervalMs: 50,
      traceSink: () => {},
      execAction: async (action, root) => {
        actionCount += 1;
        return runAction(action, root, { mcp: { client, allow: TOOLS } });
      },
    });
    await delay(250);
    assert.equal(actionCount, 0, "明确任务前不得执行动作");

    let sequence = 0;
    async function call(tool, args = {}) {
      const before = feeds.length;
      reply = `步骤 ${++sequence}\n\`\`\`host\n${JSON.stringify([{ op: "mcp", tool, args }])}\n\`\`\``;
      const feed = await eventually(() => feeds.length > before && feeds.at(-1), `${tool} 回填`, 60000);
      assert.match(feed, new RegExp(`mcp ${tool}[^\\n]*→ ok`), `${tool} 回填异常：${feed}`);
      return feed;
    }

    await call("browser_navigate", { url: origin });
    const before = await call("browser_snapshot");
    const ref = before.match(/button\s+"展开详情"[^\n]*?\[ref=([^\]]+)\]/)?.[1]
      || before.match(/button\s+"展开详情"[^\n]*?ref=([\w-]+)/)?.[1];
    assert.ok(ref, "页面快照未包含展开详情按钮的元素引用");
    await call("browser_click", { element: "展开详情", target: ref });
    const after = await call("browser_snapshot");
    assert.match(after, /详情已展开/);

    await stop.pause();
    assert.equal(stop.isPaused(), true);
    const pausedCount = actionCount;
    reply = `暂停期间请求\n\`\`\`host\n${JSON.stringify([{ op: "mcp", tool: "browser_snapshot", args: {} }])}\n\`\`\``;
    await delay(250);
    assert.equal(actionCount, pausedCount, "暂停期间执行了新动作");
    stop.resume();
    await eventually(() => actionCount > pausedCount, "恢复后的页面快照");
    await eventually(() => feeds.length >= 5, "恢复后的回填");

    await call("browser_evaluate", {
      function: "async () => { const s = window.__lab; await fetch('/beacon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'script-verify', sessionUuid: s.sessionUuid, marker: s.marker, detailsOpen: s.detailsOpen }) }); return { sessionUuid: s.sessionUuid, marker: s.marker, detailsOpen: s.detailsOpen }; }",
    });
    const events = await eventually(async () => {
      const values = await (await fetch(`${origin}/beacons`)).json();
      return values.length >= 3 && values;
    }, "Lab 取证事件");
    assert.deepEqual(events.map((event) => event.event), ["load", "expand", "script-verify"]);
    assert.equal(new Set(events.map((event) => event.sessionUuid)).size, 1);
    assert.equal(new Set(events.map((event) => event.marker)).size, 1);
    assert.deepEqual(events.map((event) => event.detailsOpen), [false, true, true]);
    assert.equal(actionCount, 6, "应完成六次工具调用");

    stop.signal();
    await client.close();
    await stop();
    stop = null;
    assert.equal(client.exitSeen, true, "MCP server 退出后仍存活");
    const remaining = await eventually(async () => {
      const count = await browserProcessCount(profile);
      return count === null || count === 0 ? { count } : null;
    }, "外部浏览器进程退出");
    process.stdout.write(JSON.stringify({
      result: "通过", serverPid, serverStarts: 1, actionCount,
      events: events.map((event) => ({ event: event.event, detailsOpen: event.detailsOpen })),
      sameSession: true, sameMarker: true, browserProcessesAfterExit: remaining.count,
    }, null, 2) + "\n");
  } finally {
    stop?.signal();
    await client?.close().catch(() => {});
    await stop?.().catch(() => {});
    lab.proc.kill();
    const temp = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(profile).startsWith(temp), "临时资料目录越界，拒绝清理");
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`浏览器 MCP 验收失败：${error.stack || error}\n`);
  process.exitCode = 1;
});
