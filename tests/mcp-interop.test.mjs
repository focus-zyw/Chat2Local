/**
 * MCP 互操作验证 —— 用一个刻意独立实现的 fixture server
 * （tests/fixtures/mcp-interop-server.mjs）验证 mcp-client 没有依赖自带
 * demo server 的特殊假设：不同 protocolVersion、CRLF 行尾、主动 notification、
 * 非 JSON banner、schema 缺失、structuredContent、跨块多字节字符。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { callMcpTool, listMcpTools } from "../src/mcp-client.mjs";

const FIXTURE_SERVER = fileURLToPath(new URL("./fixtures/mcp-interop-server.mjs", import.meta.url));

function fixtureSpec() {
  return { command: process.execPath, args: [FIXTURE_SERVER], cwd: os.tmpdir() };
}

test("互操作：不同 protocolVersion / CRLF / 主动通知 / banner 下完成工具发现", async () => {
  const res = await listMcpTools(fixtureSpec(), { timeoutMs: 15000 });
  assert.equal(res.ok, true, res.text || "listMcpTools 应成功");
  assert.deepEqual(res.tools.map((t) => t.name), ["echo_cn", "bare_tool"]);
  // schema 完整的工具：目录保留必填项与参数类型/描述
  const echo = res.tools[0];
  assert.deepEqual(echo.required, ["text"]);
  const textProp = echo.props.find((p) => p.name === "text");
  assert.equal(textProp.type, "string");
  assert.equal(textProp.required, true);
  assert.ok(textProp.description.includes("回声"));
  // schema 缺失的工具：字段为空数组而不是报错
  assert.deepEqual(res.tools[1].required, []);
  assert.deepEqual(res.tools[1].props, []);
});

test("互操作：tools/call 正常返回；未知工具得到 server 的 JSON-RPC 拒绝", async () => {
  const spec = fixtureSpec();
  const ok = await callMcpTool(spec, "echo_cn", { text: "hello" }, { timeoutMs: 15000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "回声：hello");

  const denied = await callMcpTool(spec, "no_such", {}, { timeoutMs: 15000 });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "mcp-error");
  assert.match(denied.text, /未知工具/);
});

test("互操作：中文输出在字节块内部切开仍完整解码（跨块多字节字符）", async () => {
  const res = await callMcpTool(
    fixtureSpec(),
    "echo_cn",
    { text: "分块中文字符完整性验证——这一段会被 server 在多字节字符内部切开分两次写出。" },
    { timeoutMs: 15000 }
  );
  assert.equal(res.ok, true);
  assert.equal(
    res.text,
    "回声：分块中文字符完整性验证——这一段会被 server 在多字节字符内部切开分两次写出。\n[fixture:split-write]",
    "客户端不得在 UTF-8 块边界产生 U+FFFD 或丢字"
  );
  assert.ok(!res.text.includes("\ufffd"), "不应出现替换字符");
});
