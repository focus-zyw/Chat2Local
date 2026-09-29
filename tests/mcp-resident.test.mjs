/**
 * 常驻 MCP 客户端验收 —— 有状态 fixture server
 * （tests/fixtures/mcp-state-server.mjs）逐条验证设计约束：
 * 状态保留与单次握手、普通错误后复用、串行忙碌、崩溃/超时/超大帧/无换行
 * 的"结果不明"语义、杂散与重复响应、服务端请求应答、close 幂等与回收。
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpClient } from "../src/mcp-client.mjs";

const STATE_SERVER = fileURLToPath(new URL("./fixtures/mcp-state-server.mjs", import.meta.url));

const spec = () => ({ command: process.execPath, args: [STATE_SERVER], cwd: os.tmpdir() });

test("常驻：握手仅一次，发现与调用同一进程，内存状态跨调用保留", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const listed = await client.listTools({ timeoutMs: 15000 });
    assert.equal(listed.ok, true, listed.text || "listTools 应成功");
    const names = listed.tools.map((t) => t.name);
    for (const expected of ["stats", "state", "fail", "slow", "crash", "huge", "hang_nonl", "noisy", "dup", "announce_change"]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`);
    }
    const inc1 = await client.callTool("state", { op: "inc" }, { timeoutMs: 10000 });
    assert.equal(inc1.text, "1");
    const inc2 = await client.callTool("state", { op: "inc" }, { timeoutMs: 10000 });
    assert.equal(inc2.text, "2", "server 内存状态应跨调用保留");
    const s1 = JSON.parse((await client.callTool("stats", {}, { timeoutMs: 10000 })).text);
    const s2 = JSON.parse((await client.callTool("stats", {}, { timeoutMs: 10000 })).text);
    assert.equal(s1.pid, s2.pid, "发现与所有调用都在同一进程");
    assert.equal(s1.initializes, 1, "握手只发生一次");
    assert.equal(s1.sawPingReply, true, "服务端 ping 应得到 {} 应答");
    assert.equal(s1.sawSamplingReject, true, "未实现的服务端请求应被明确拒绝");
  } finally {
    await client.close();
  }
});

test("常驻：普通工具错误后连接继续可用（不重启、不重放）", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const failed = await client.callTool("fail", {}, { timeoutMs: 10000 });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "tool-error");
    assert.ok(!failed.requiresConfirmation, "工具级错误不是结果不明");
    const after = await client.callTool("state", { op: "inc" }, { timeoutMs: 10000 });
    assert.equal(after.ok, true, "工具错误后同一连接继续可用");
    assert.equal(after.text, "1");
  } finally {
    await client.close();
  }
});

test("常驻：串行调用——忙时立即返回 mcp-busy 且本次未执行", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const slow = client.callTool("slow", { ms: 800 }, { timeoutMs: 10000 });
    const busy = await client.callTool("state", { op: "inc" }, { timeoutMs: 10000 });
    assert.equal(busy.ok, false);
    assert.equal(busy.error, "mcp-busy");
    const done = await slow;
    assert.equal(done.ok, true);
    const get = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(get.text, "0", "忙碌期间被拒绝的调用不应已执行");
  } finally {
    await client.close();
  }
});

test("常驻：调用中崩溃——结果不明、不重启、后续调用明确未执行", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const startedAt = Date.now();
    const r = await client.callTool("crash", {}, { timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
    assert.equal(r.requiresConfirmation, true);
    assert.match(r.text, /结果不明|人工核对/);
    assert.ok(Date.now() - startedAt < 3000, "server 已退出时应立即结束在途调用，不得等到工具超时");
    const r2 = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(r2.ok, false);
    assert.equal(r2.error, "mcp-unavailable", "崩溃后不自动重启，新调用明确未执行");
    assert.ok(!r2.requiresConfirmation, "未发出的调用不是结果不明");
  } finally {
    await client.close();
  }
});

test("常驻：调用超时——尽力取消但结果不明，连接按约定停用", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("slow", { ms: 10000 }, { timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
    assert.equal(r.requiresConfirmation, true);
    for (let i = 0; i < 100 && !client.exitSeen; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(client.exitSeen, true, "超时后应立即清理 server，不得等到 watch 退出");
    const r2 = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(r2.error, "mcp-unavailable", "超时后首版不再复用连接");
  } finally {
    await client.close();
  }
});

test("常驻：单帧超过 1MiB 上限——协议破坏，结果不明", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("huge", {}, { timeoutMs: 10000 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
    assert.match(r.text, /接收上限/);
    const r2 = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(r2.error, "mcp-unavailable");
  } finally {
    await client.close();
  }
});

test("常驻：无换行且不结束的输出按超时处理（结果不明）", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const r = await client.callTool("hang_nonl", {}, { timeoutMs: 600 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "mcp-outcome-unknown");
  } finally {
    await client.close();
  }
});

test("常驻：杂散/重复响应被忽略，不影响在途与后续调用", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const noisy = await client.callTool("noisy", {}, { timeoutMs: 10000 });
    assert.equal(noisy.ok, true);
    assert.equal(noisy.text, "noisy ok", "返回的是本请求的响应，不是杂散响应");
    const dup = await client.callTool("dup", {}, { timeoutMs: 10000 });
    assert.equal(dup.ok, true);
    assert.equal(dup.text, "dup first", "重复响应只取第一个");
    const after = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(after.ok, true, "后续调用不受杂散/重复响应影响");
  } finally {
    await client.close();
  }
});

test("常驻：目录变化通知触发重新发现——在途调用完成、连接可用、授权由 Host 冻结", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  const updates = [];
  client.onCatalogUpdate = (tools) => updates.push(tools.map((t) => t.name));
  try {
    const r = await client.callTool("announce_change", {}, { timeoutMs: 15000 });
    assert.equal(r.ok, true, `在途调用不受目录变化影响：${r.text?.slice(0, 80)}`);
    assert.equal(r.text, "目录已变化");
    const after = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
    assert.equal(after.ok, true, "重新发现完成后连接继续可用");
    assert.ok(updates.length >= 1, "重新发现后回调最新目录");
    assert.ok(updates[0].includes("state"));
  } finally {
    await client.close();
  }
});

test("常驻：目录重发现期间有业务调用在途，新调用立即返回忙碌且不排队", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  try {
    const first = client.callTool("change_slow", {}, { timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const t0 = Date.now();
    const second = await client.callTool("state", { op: "inc" }, { timeoutMs: 5000 });
    const listed = await client.listTools({ timeoutMs: 5000 });
    assert.equal(second.error, "mcp-busy");
    assert.equal(listed.error, "mcp-busy");
    assert.ok(Date.now() - t0 < 350, "忙时不等待 500ms 目录重发现");
    assert.equal((await first).ok, true);
    const state = await client.callTool("state", { op: "get" }, { timeoutMs: 5000 });
    assert.equal(state.text, "0", "被拒绝的调用未在之后执行");
  } finally {
    await client.close();
  }
});

test("常驻：close 幂等、有时限；关闭后调用明确未执行", async () => {
  const client = await createMcpClient(spec(), { startupTimeoutMs: 15000 });
  const t0 = Date.now();
  await client.close();
  await client.close(); // 幂等
  assert.ok(Date.now() - t0 < 15000, "close 应有界返回");
  const r = await client.callTool("state", { op: "get" }, { timeoutMs: 10000 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "mcp-unavailable");
});
