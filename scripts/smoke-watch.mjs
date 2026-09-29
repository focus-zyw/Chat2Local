/**
 * watch（旁观执行）模式端到端自测：先在 mock 页发送 watch 专属开场白，
 * 再用 ?auto=1 模拟"用户已在网页上提问、导师回复带 host 动作块"，
 * 验证 watcher 发现动作、执行并自动回填。随后用 ?auto=mcp 验证
 * 网页 → host 动作 → 本地 MCP server（只读跨目录搜索）→ 结果回填 的桥接。
 * 不需要账号。跑法：npm run smoke:watch
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer, mockServerUrl } from "./mock-server.mjs";
import { launchBrowser } from "../src/browser.mjs";
import { createDriver } from "../src/page-driver.mjs";
import { startWatcher } from "../src/watcher.mjs";
import { watchIntroPayload, conversationIntroPayload } from "../src/protocol.mjs";
import { runAction } from "../src/host-actions.mjs";
import { createMcpClient } from "../src/mcp-client.mjs";
import { createWatchCheckpointStore } from "../src/watch-checkpoint.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO_MCP_SERVER = fileURLToPath(new URL("../demo/mcp-search-server.mjs", import.meta.url));

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "watch-fixture", type: "module" }, null, 2) + "\n"
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export default 1;\n");
  // mcp 桥接场景：root1 与 root2 各放一个 MARKER 文件，
  // 一次 search_files 调用应同时命中两处（内置 search 只有单 Host Root，做不到）
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "mcp.md"), "MARKER in root1\n");
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch2-"));
  await fs.writeFile(path.join(root2, "other.md"), "MARKER in root2\n");
  return { root, root2 };
}

async function main() {
  const { root: fixture, root2 } = await makeFixture();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-profile-"));
  const server = await startMockServer();
  const mockUrl = mockServerUrl(server);
  let context;
  try {
    ({ context } = await launchBrowser({ headless: true, profileDir }));
    const log = (m) => process.stderr.write(`[smoke:watch] ${m}\n`);
    const introDriver = await createDriver({ context, siteId: "mock", siteUrl: mockUrl, watchMs: 20000, log });
    const intro = await introDriver.send(watchIntroPayload(fixture));
    await introDriver.close();
    if (!intro.ok || !intro.text.includes("```host")) {
      throw new Error(`SMOKE-WATCH FAILED: watch 开场白未触发动作回复：${intro.error || intro.text}`);
    }
    const driver = await createDriver({
      context,
      siteId: "mock",
      siteUrl: mockUrl + "?auto=1",
      watchMs: 20000,
      log,
    });
    await driver.markTab();
    const watchedPage = context.pages().at(-1);
    await watchedPage.evaluate(() => { document.title = "〔file-tool〕旧聊天"; });
    await driver.markTab();
    if ((await watchedPage.title()) !== "〔Chat2Local〕旧聊天") {
      throw new Error("SMOKE-WATCH FAILED: 旧聊天窗口标记未更新为 Chat2Local");
    }
    if ((await driver.probe()).state !== "healthy") {
      throw new Error("SMOKE-WATCH FAILED: 已打开 mock 网页却未检测到可用输入框");
    }
    const checkpoint = createWatchCheckpointStore(path.join(profileDir, "watch-checkpoints.json"))
      .forThread("mock", fixture, mockUrl + "?auto=1");
    const logs = [];
    const stop = await startWatcher({
      driver,
      root: fixture,
      checkpoint,
      intervalMs: 400,
      stableMs: 800,
      log: (m) => {
        logs.push(m);
        log(m);
      },
    });

    // 等 watcher 完成闭环：mock 收到回填后回复 WATCHER-FEED-OK
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await sleep(500);
      const snap = await driver.snapshot();
      if (snap.text.includes("WATCHER-FEED-OK")) ok = true;
    }
    await stop();
    if (!ok) throw new Error("SMOKE-WATCH FAILED: 20s 内未见回填后的讲解\n" + logs.join("\n"));
    if (checkpoint.read()?.phase !== "processed") throw new Error("SMOKE-WATCH FAILED: 动作完成后断点未落盘");

    // ── mcp 桥接场景：?auto=mcp 回复带 {"op":"mcp",...}，经常驻 MCP client
    // 桥接 demo server（授权 root1+root2 跨目录搜索）后回填，mock 断言两个
    // 目录的命中都出现在回填里才回 MCP-FEED-OK ──
    const mcpUrl = mockUrl + "?auto=mcp";
    const mcpDriver = await createDriver({ context, siteId: "mock", siteUrl: mcpUrl, watchMs: 20000, log });
    await mcpDriver.markTab();
    const mcpCheckpoint = createWatchCheckpointStore(path.join(profileDir, "watch-checkpoints.json"))
      .forThread("mock", fixture, mcpUrl);
    const mcpClient = await createMcpClient(
      { command: process.execPath, args: [DEMO_MCP_SERVER, fixture, root2], cwd: fixture },
      { startupTimeoutMs: 15000 }
    );
    const listed = await mcpClient.listTools({ timeoutMs: 15000 });
    if (!listed.ok || listed.tools.length === 0) {
      await mcpClient.close();
      throw new Error("SMOKE-WATCH FAILED: 常驻 MCP client 未取得工具目录\n" + (listed.text || ""));
    }
    const mcpStop = await startWatcher({
      driver: mcpDriver,
      root: fixture,
      checkpoint: mcpCheckpoint,
      intervalMs: 400,
      stableMs: 800,
      log: (m) => log(`[mcp] ${m}`),
      execAction: (action, rootDir) =>
        runAction(action, rootDir, { mcp: { client: mcpClient, allow: listed.tools.map((t) => t.name) } }),
    });
    let mcpOk = false;
    let mcpSnap = { text: "" };
    for (let i = 0; i < 60 && !mcpOk; i++) {
      await sleep(500);
      mcpSnap = await mcpDriver.snapshot();
      if (mcpSnap.text.includes("MCP-FEED-OK")) mcpOk = true;
    }
    await mcpStop();
    await mcpClient.close();
    if (!mcpOk) throw new Error("SMOKE-WATCH FAILED: 30s 内未见 mcp 桥接回填\n" + mcpSnap.text + "\n" + logs.join("\n"));
    if (mcpCheckpoint.read()?.phase !== "processed") throw new Error("SMOKE-WATCH FAILED: mcp 场景断点未落盘");
    // mock 只在回填里同时看到 [R1]/[R2] 命中时才回 MCP-FEED-OK（否则 MCP-FEED-FAIL）

    // ── task 角色场景：开场白只待命且零动作 → 显式任务 → 动作 → task 版
    // 回填注记 → mock 输出 done 结论 + 证据（TASK-DONE）──
    const taskUrl = mockUrl + "?task=1";
    const taskDriver = await createDriver({ context, siteId: "mock", siteUrl: taskUrl, watchMs: 20000, log });
    await taskDriver.markTab();
    const taskCheckpointStore = createWatchCheckpointStore(path.join(profileDir, "watch-checkpoints.json"));
    const taskCheckpoint = taskCheckpointStore.forThread("mock", fixture, taskUrl, "task");
    const taskCodeCheckpoint = taskCheckpointStore.forThread("mock", fixture, taskUrl, "code");
    const taskIntro = await taskDriver.send(conversationIntroPayload(fixture, "task", true));
    if (!taskIntro.ok) throw new Error("SMOKE-WATCH FAILED: task 开场白发送失败：" + (taskIntro.error || ""));
    if (!taskIntro.text.includes("TASK-READY") || taskIntro.text.includes("```host")) {
      throw new Error("SMOKE-WATCH FAILED: task 开场白应只确认待命，不得主动调用工具\n" + taskIntro.text);
    }
    let taskActionCount = 0;
    const taskStop = await startWatcher({
      driver: taskDriver,
      root: fixture,
      role: "task",
      checkpoint: taskCheckpoint,
      execAction: async (action, rootDir) => {
        taskActionCount += 1;
        return runAction(action, rootDir);
      },
      intervalMs: 400,
      stableMs: 800,
      log: (m) => log(`[task] ${m}`),
    });
    await sleep(1200);
    if (taskActionCount !== 0) throw new Error("SMOKE-WATCH FAILED: 明确任务送达前不得执行动作");
    const taskRequest = await taskDriver.deliver("明确任务：读取 package.json，报告项目名并给出可验证证据。");
    if (!taskRequest.ok) throw new Error("SMOKE-WATCH FAILED: task 明确任务发送失败：" + (taskRequest.error || ""));
    let taskOk = false;
    let taskSnap = { text: "" };
    for (let i = 0; i < 60 && !taskOk; i++) {
      await sleep(500);
      taskSnap = await taskDriver.snapshot();
      if (taskSnap.text.includes("TASK-DONE")) taskOk = true;
    }
    await taskStop();
    if (!taskOk) throw new Error("SMOKE-WATCH FAILED: 30s 内未见 task 角色的 done 总结\n" + taskSnap.text + "\n" + logs.join("\n"));
    if (taskSnap.text.includes("TASK-FAIL")) throw new Error("SMOKE-WATCH FAILED: task 回填缺少任务版续行注记\n" + taskSnap.text);
    if (taskCheckpoint.read()?.phase !== "processed") throw new Error("SMOKE-WATCH FAILED: task 场景断点未落盘");
    if (taskCodeCheckpoint.read() !== null) throw new Error("SMOKE-WATCH FAILED: task 场景污染了 code 角色断点键");

    // 诊断回归（脱敏故障样本）：细分原因映射必须与页面状态一致
    const healthy = await driver.diagnose();
    if (healthy.state !== "healthy") {
      throw new Error(`SMOKE-WATCH FAILED: 健康页诊断应为 healthy，实际 ${healthy.cause}`);
    }
    await driver.openUrl(mockUrl + "?broken=hidden");
    const hidden = await driver.diagnose();
    if (hidden.cause !== "composer-invisible") {
      throw new Error(`SMOKE-WATCH FAILED: hidden 变体应为 composer-invisible，实际 ${hidden.cause}`);
    }
    // probe 可见性判定（评审 Spec-3）：hidden 输入框不得误判为健康
    const probeHidden = await driver.probe();
    if (probeHidden.state !== "unknown" || probeHidden.cause !== "composer-invisible") {
      throw new Error(`SMOKE-WATCH FAILED: hidden 变体的 probe 应为 composer-invisible，实际 ${probeHidden.state}/${probeHidden.cause || "—"}`);
    }
    await driver.openUrl(mockUrl + "?broken=composer");
    const missed = await driver.diagnose();
    if (missed.cause !== "composer-selector-miss") {
      throw new Error(`SMOKE-WATCH FAILED: composer 变体应为 composer-selector-miss，实际 ${missed.cause}`);
    }
    // probe 范围收窄（评审 P28）：只查输入框，不因回复区正常而误判健康
    const probeScoped = await driver.probe();
    if (probeScoped.cause !== "composer-miss" || !probeScoped.advice) {
      throw new Error(`SMOKE-WATCH FAILED: 收窄后的 probe 在 composer 变体应为 composer-miss，实际 ${probeScoped.cause || "—"}`);
    }
    process.stdout.write(
      "SMOKE-WATCH PASSED — 旁观执行全链路 OK（诊断回归 + mcp 桥接 + task 角色连续执行到 done）\n"
    );
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
    await fs.rm(root2, { recursive: true, force: true }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke:watch] ${err?.stack || err}\n`);
  process.exit(1);
});
