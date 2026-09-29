/**
 * 接收内存有界性验收 —— 帧上限按原始字节作用于完整消息（含未换行残帧），
 * 不依赖结果文本截断。覆盖方案要求的全部故障样本：
 * 恰达上限 / 超一字节 / 超大 banner / 同块多条消息 / 持续无换行 / stderr 洪峰，
 * 外加受限堆子进程验证（主动报告先于内存失控）与 watcher 集成（超大响应 →
 * 后续动作次数为零、断点待核对）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpClient, MCP_FRAME_MAX_BYTES, MCP_STDERR_TAIL_CHARS } from "../src/mcp-client.mjs";
import { runAction } from "../src/host-actions.mjs";
import { startWatcher } from "../src/watcher.mjs";
import { createWatchCheckpointStore } from "../src/watch-checkpoint.mjs";

const STATE_SERVER = fileURLToPath(new URL("./fixtures/mcp-state-server.mjs", import.meta.url));
const HEAP_RUNNER = fileURLToPath(new URL("./fixtures/mcp-heap-runner.mjs", import.meta.url));

const spec = () => ({ command: process.execPath, args: [STATE_SERVER], cwd: os.tmpdir() });

test("有界：恰好达到单帧上限的完整消息正常处理", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("exact_frame", { bytes: MCP_FRAME_MAX_BYTES }, { timeoutMs: 15000 });
    assert.equal(r.ok, true, r.text?.slice(0, 120));
    assert.ok(r.text.length <= 8200, "结果文本仍按上限截断回传");
  } finally {
    await client.close();
  }
});

test("有界：超过上限一字节即拒绝（协议破坏，结果不明）", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("exact_frame", { bytes: MCP_FRAME_MAX_BYTES + 1 }, { timeoutMs: 15000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
    assert.match(r.text, /接收上限/);
    const after = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(after.error, "mcp-unavailable", "超限后连接停用，后续调用明确未执行");
  } finally {
    await client.close();
  }
});

test("有界：非 JSON 的超大 banner 行同样受单帧上限约束", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("oversize_banner", {}, { timeoutMs: 15000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
    assert.match(r.text, /接收上限/);
  } finally {
    await client.close();
  }
});

test("有界：同一数据块序列包含多条消息且总量超 1MiB，每条未超限则正常处理", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("burst", {}, { timeoutMs: 15000 });
    assert.equal(r.ok, true, r.text?.slice(0, 120));
    assert.match(r.text, /burst ok/);
    assert.equal(client.buf.length, 0);
    assert.equal(client.buf.buffer.byteLength, 0, "完整帧处理后不保留原始块的底层缓冲");
    const after = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(after.ok, true, "数据块总量超限不误伤连接");
  } finally {
    await client.close();
  }
});

test("有界：持续无换行输出在超过上限后及时终止连接（不等超时）", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const t0 = Date.now();
    // 不设短超时：由帧上限触发，而不是由超时触发
    const r = await client.callTool("flood_nonl", {}, { timeoutMs: 120000 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
    assert.match(r.text, /接收上限/);
    assert.ok(elapsed < 30000, `洪峰应在数秒内被上限拦截，实际 ${Math.round(elapsed / 1000)}s`);
    const after = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(after.error, "mcp-unavailable");
  } finally {
    await client.close();
  }
});

test("有界：大量 stderr 输出后，保留内容仍受限且连接不受影响", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("stderr_flood", {}, { timeoutMs: 30000 });
    assert.equal(r.ok, true, r.text?.slice(0, 120));
    assert.ok(client.stderrTail.length <= MCP_STDERR_TAIL_CHARS, "stderr 保留不超过固定尾部");
    assert.ok(client.stderrTail.length > 0, "保留的是最后的内容而非空");
    const after = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(after.ok, true);
  } finally {
    await client.close();
  }
});

test("有界：多字节 stderr 尾部按 UTF-8 字节保留且可读", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("stderr_unicode", {}, { timeoutMs: 10000 });
    assert.equal(r.ok, true);
    assert.ok(Buffer.byteLength(client.stderrTail, "utf8") <= 4096);
    assert.ok(client.stderrTail.endsWith("终点"));
    assert.doesNotMatch(client.stderrTail, /\uFFFD/, "字节裁剪不应留下半个字符");
  } finally {
    await client.close();
  }
});

test("有界：受限堆子进程洪峰下主动报告超限，先于内存失控", async () => {
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", HEAP_RUNNER, STATE_SERVER],
    { encoding: "utf8", timeout: 90000, windowsHide: true }
  );
  assert.equal(result.status, 0, `受限堆运行失败：${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /HEAP-RUNNER-OK 超限已主动报告/);
  assert.doesNotMatch(result.stdout + result.stderr, /Reached heap limit|Allocation failed|JavaScript heap out of memory/);
  // 辅证：运行期采样的 RSS 峰值有界（runner 自身持续监控并打印）
  const rss = result.stdout.match(/maxRss=(\d+)MB/);
  assert.ok(rss && Number(rss[1]) < 256, `RSS 峰值应远低于安全阈值，实际 ${rss?.[1]}MB`);
});

test("有界：工具执行中返回超大消息——后续动作次数为零，断点待人工核对", async () => {
  const reply =
    '取两次材料。\n```host\n[{"op":"mcp","tool":"huge","args":{}},{"op":"mcp","tool":"state","args":{"op":"inc"}}]\n```';
  const executed = [];
  const fatal = [];
  const checkpointFile = path.join(os.tmpdir(), `mcp-bounded-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const checkpoint = createWatchCheckpointStore(checkpointFile).forThread("mock", os.tmpdir(), "https://mock/bounded");
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  const stop = await startWatcher({
    driver: { async snapshot() { return { busy: false, text: reply }; } },
    root: os.tmpdir(),
    checkpoint,
    intervalMs: 5,
    stableMs: 30,
    log: () => {},
    onFatal: (message) => fatal.push(message),
    execAction: async (action, rootDir) => {
      const r = await runAction(action, rootDir, { mcp: { client, allow: ["huge", "state"] } });
      executed.push(action.tool);
      return r;
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 400));
    await stop();
    assert.deepEqual(executed, ["huge"], "超大响应触发结果不明后，同批次后续动作不再开始");
    assert.equal(fatal.length, 1);
    assert.match(fatal[0], /结果不明/);
    assert.notEqual(checkpoint.read()?.phase, "processed");
  } finally {
    await client.close();
    await fs.rm(checkpointFile, { force: true });
  }
}, 30000);
