/**
 * MCP 客户端单测 —— 全部走真实子进程（demo server / 内联 fixture server），
 * 不 mock 协议层：帧解析、超时、进程终止都要在真实 stdio 上验证。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callMcpTool, listMcpTools, mcpResultText, MCP_RESULT_MAX_CHARS } from "../src/mcp-client.mjs";

const DEMO_SERVER = fileURLToPath(new URL("../demo/mcp-search-server.mjs", import.meta.url));

async function makeRoots() {
  const r1 = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-c1-"));
  const r2 = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-c2-"));
  await fs.mkdir(path.join(r1, "notes"), { recursive: true });
  await fs.writeFile(path.join(r1, "notes", "a.md"), "第一行\nMARKER alpha\n第三行\n");
  await fs.writeFile(path.join(r2, "b.md"), "MARKER beta\n");
  return { r1, r2 };
}

function demoSpec(...roots) {
  return { command: process.execPath, args: [DEMO_SERVER, ...roots], cwd: roots[0] };
}

test("listMcpTools: 返回 demo server 的 search_files 工具", async () => {
  const { r1, r2 } = await makeRoots();
  try {
    const res = await listMcpTools(demoSpec(r1, r2), { timeoutMs: 15000 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.tools.map((t) => t.name), ["search_files"]);
    assert.match(res.tools[0].description, /R1/);
  } finally {
    await fs.rm(r1, { recursive: true, force: true });
    await fs.rm(r2, { recursive: true, force: true });
  }
});

test("callMcpTool: 一次调用搜出两个授权目录的命中（内置 search 做不到）", async () => {
  const { r1, r2 } = await makeRoots();
  try {
    const res = await callMcpTool(demoSpec(r1, r2), "search_files", { query: "MARKER" }, { timeoutMs: 15000 });
    assert.equal(res.ok, true);
    assert.match(res.text, /\[R1\] notes\/a\.md:2: MARKER alpha/);
    assert.match(res.text, /\[R2\] b\.md:1: MARKER beta/);
  } finally {
    await fs.rm(r1, { recursive: true, force: true });
    await fs.rm(r2, { recursive: true, force: true });
  }
});

test("callMcpTool: server 报告 isError 时映射为失败", async () => {
  const { r1 } = await makeRoots();
  try {
    const bad = await callMcpTool(demoSpec(r1), "search_files", { query: "[", regex: true }, { timeoutMs: 15000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "tool-error");
    assert.match(bad.text, /非法正则/);
    const noQuery = await callMcpTool(demoSpec(r1), "search_files", {}, { timeoutMs: 15000 });
    assert.equal(noQuery.ok, false);
    assert.match(noQuery.text, /query/);
  } finally {
    await fs.rm(r1, { recursive: true, force: true });
  }
});

test("callMcpTool: 未知工具返回 server 的可读拒绝", async () => {
  const { r1 } = await makeRoots();
  try {
    const res = await callMcpTool(demoSpec(r1), "no_such_tool", { query: "x" }, { timeoutMs: 15000 });
    assert.equal(res.ok, false);
    assert.equal(res.error, "mcp-error");
    assert.match(res.text, /未知工具/);
  } finally {
    await fs.rm(r1, { recursive: true, force: true });
  }
});

test("callMcpTool: 无响应 server 超时——请求已发出，结果不明（常驻语义）", async () => {
  const { dir, script } = await makeFixtureServer();
  try {
    const spec = { command: process.execPath, args: [script], cwd: dir };
    const t0 = Date.now();
    const res = await callMcpTool(spec, "echo", { echo: "__HANG__" }, { timeoutMs: 800 });
    assert.equal(res.ok, false);
    assert.equal(res.error, "mcp-outcome-unknown");
    assert.equal(res.requiresConfirmation, true, "请求已发出但未收到完整结果，必须人工核对");
    assert.match(res.text, /超时/);
    assert.ok(Date.now() - t0 < 10000, "超时后应尽快返回，而不是挂死");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("callMcpTool: server 提前退出返回含 stderr 的可读错误", async () => {
  const spec = { command: process.execPath, args: ["-e", "process.stderr.write('boom reason');process.exit(3)"], cwd: os.tmpdir() };
  const res = await callMcpTool(spec, "any", {}, { timeoutMs: 15000 });
  assert.equal(res.ok, false);
  assert.match(res.text, /提前退出/);
  assert.match(res.text, /boom reason|退出码 3/);
});

// 内联 fixture server：先打 banner 再说话（验证非 JSON 行容忍）+ echo 工具（验证截断）。
// echo 收到 "__HANG__" 时不响应，用于验证调用超时的"结果不明"语义。
async function makeFixtureServer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fix-"));
  const script = path.join(dir, "fixture-server.mjs");
  await fs.writeFile(
    script,
    [
      'process.stdout.write("== demo banner，不是 JSON ==\\n");',
      'let buf = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => {',
      "  buf += d;",
      "  let nl;",
      '  while ((nl = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, nl);",
      "    buf = buf.slice(nl + 1);",
      "    if (!line.trim()) continue;",
      "    let msg; try { msg = JSON.parse(line); } catch { continue; }",
      '    if (msg.method === "initialize") {',
      '      reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture" } });',
      '    } else if (msg.method === "tools/call") {',
      "      const text = String(msg.params?.arguments?.echo ?? '');",
      '      if (text === "__HANG__") return; // 收到挂起标记：保持进程存活但不响应',
      '      reply(msg.id, { content: [{ type: "text", text }] });',
      "    } else if (msg.id !== undefined) {",
      '      reply(msg.id, {}, { code: -32601, message: "method not found: " + msg.method });',
      "    }",
      "  }",
      "});",
      "function reply(id, result, error) {",
      '  const payload = { jsonrpc: "2.0", id };',
      "  if (error) payload.error = error; else payload.result = result;",
      '  process.stdout.write(JSON.stringify(payload) + "\\n");',
      "}",
    ].join("\n")
  );
  return { dir, script };
}

test("callMcpTool: 容忍 stdout 的非 JSON banner 行；超长输出按上限截断", async () => {
  const { dir, script } = await makeFixtureServer();
  try {
    const spec = { command: process.execPath, args: [script], cwd: dir };
    const big = "x".repeat(MCP_RESULT_MAX_CHARS + 500);
    const res = await callMcpTool(spec, "echo", { echo: big }, { timeoutMs: 15000 });
    assert.equal(res.ok, true);
    assert.ok(res.text.length < MCP_RESULT_MAX_CHARS + 200, "输出应被截断到上限附近");
    assert.match(res.text, /truncated/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("mcpResultText: content 文本优先，非文本项注明省略；退回 structuredContent", () => {
  assert.equal(mcpResultText({ content: [{ type: "text", text: "a" }, { type: "image" }] }), "a\n[image 内容已省略]");
  assert.equal(mcpResultText({ structuredContent: { k: 1 } }), '{\n  "k": 1\n}');
  assert.equal(mcpResultText({}), "");
});
