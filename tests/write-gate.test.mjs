import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpClient } from "../src/mcp-client.mjs";
import { runAction } from "../src/host-actions.mjs";
import { createWriteGate } from "../src/write-gate.mjs";

const SERVER = fileURLToPath(new URL("../demo/mcp-fs-server.mjs", import.meta.url));

async function makeFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-writegate-"));
  await fs.writeFile(path.join(root, "existing.md"), "旧内容第一行\n旧内容第二行\n", "utf8");
  return root;
}

/** 组装真实 server client + 门控 + 可变模式；confirm 由测试注入并记录。 */
async function makeHarness(t) {
  const root = await makeFixtureRoot();
  const WRITE_TOOLS = ["write_file", "create_directory", "undo_write"];
  const client = await createMcpClient(
    { command: process.execPath, args: [SERVER, root] },
    { startupTimeoutMs: 20000 }
  );
  let mode = "ask";
  const confirmCalls = [];
  const gate = createWriteGate({
    isMcpWriteTool: (name) => WRITE_TOOLS.includes(name),
    runWithWrite: (action, rootDir) =>
      runAction(action, rootDir, { mcp: { client, allow: WRITE_TOOLS, allowWrite: true } }),
    getMode: () => mode,
    confirm: async (info) => {
      confirmCalls.push(info);
      return t.confirmDecisions.shift() ?? "no";
    },
  });
  const exec = async (action) =>
    (await gate.intercept(action, root)) ??
    (await runAction(action, root, { mcp: { client, allow: WRITE_TOOLS, allowWrite: false } }));
  t.after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    client,
    gate,
    confirmCalls,
    get confirmDecisions() {
      return t.confirmDecisions;
    },
    set decisions(list) {
      t.confirmDecisions = list;
    },
    setMode(m) {
      mode = m;
    },
    exec,
  };
}

test("写入门控 ask：同意后同一调用直执，diff 预览含风险分级与 +/- 行", async (t) => {
  t.confirmDecisions = ["yes"];
  const h = await makeHarness(t);
  const r = await h.exec({ op: "mcp", tool: "write_file", args: { path: "existing.md", content: "旧内容第一行\n新内容第二行\n" } });
  assert.equal(r.ok, true, r.text);
  assert.equal(await fs.readFile(path.join(h.root, "existing.md"), "utf8"), "旧内容第一行\n新内容第二行\n");
  assert.equal(h.confirmCalls.length, 1);
  assert.match(h.confirmCalls[0].preview, /^风险: 覆盖已有内容/m);
  assert.match(h.confirmCalls[0].preview, /- 旧内容第二行/);
  assert.match(h.confirmCalls[0].preview, /\+ 新内容第二行/);
});

test("写入门控 ask：拒绝不落盘且回填拒绝原因；会话同意后同类不再询问", async (t) => {
  t.confirmDecisions = ["no", "session"];
  const h = await makeHarness(t);
  const rejected = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "hi" } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "write-rejected");
  assert.ok(!await fs.stat(path.join(h.root, "new.txt")).then(() => true, () => false), "拒绝不得落盘");
  // 会话同意：再次询问一次并选择后，同一工具后续写入不再询问、直接执行
  const second = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "hi" } });
  assert.equal(second.ok, true, second.text);
  assert.equal(h.confirmCalls.length, 2, "第二次仍询问一次（用户选择会话同意）");
  const third = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "hi3" } });
  assert.equal(third.ok, true, third.text);
  assert.equal(h.confirmCalls.length, 2, "会话同意后不得再次询问");
  assert.ok(h.gate.sessionApproved.has("write_file"));
});

test("写入门控 risk：新建与无变化自动放行，仅覆盖已有内容询问", async (t) => {
  t.confirmDecisions = ["yes"];
  const h = await makeHarness(t);
  h.setMode("risk");
  // 新建文件：自动放行，不询问
  const created = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "brand new" } });
  assert.equal(created.ok, true, created.text);
  assert.equal(h.confirmCalls.length, 0);
  // 覆盖本会话写过的文件：仍自动（数据只会是本会话内容）
  const rewritten = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "brand new 2" } });
  assert.equal(rewritten.ok, true, rewritten.text);
  assert.equal(h.confirmCalls.length, 0);
  // 覆盖预置文件：数据丢失风险 → 询问
  const overwrote = await h.exec({ op: "mcp", tool: "write_file", args: { path: "existing.md", content: "替换" } });
  assert.equal(overwrote.ok, true, overwrote.text);
  assert.equal(h.confirmCalls.length, 1);
  assert.match(h.confirmCalls[0].preview, /^风险: 覆盖已有内容/m);
});

test("写入门控 auto 与 deny；dryRun 失败（敏感路径）直接回填错误不打扰确认", async (t) => {
  t.confirmDecisions = [];
  const h = await makeHarness(t);
  h.setMode("auto");
  const auto = await h.exec({ op: "mcp", tool: "write_file", args: { path: "auto.txt", content: "x" } });
  assert.equal(auto.ok, true, auto.text);
  assert.equal(h.confirmCalls.length, 0);

  h.setMode("deny");
  const denied = await h.exec({ op: "mcp", tool: "write_file", args: { path: "denied.txt", content: "x" } });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "write-not-allowed", "deny 模式由 host 门控统一拒绝");

  h.setMode("ask");
  const sensitive = await h.exec({ op: "mcp", tool: "write_file", args: { path: ".env", content: "x" } });
  assert.equal(sensitive.ok, false);
  assert.match(sensitive.text, /敏感/);
  assert.equal(h.confirmCalls.length, 0, "确定性失败不得进入确认");
});

test("写入门控 undo：覆盖型恢复原内容，新建型删除，空栈报错", async (t) => {
  t.confirmDecisions = ["yes", "yes"];
  const h = await makeHarness(t);
  await h.exec({ op: "mcp", tool: "write_file", args: { path: "existing.md", content: "被覆盖了" } });
  const undo1 = await h.client.callTool("undo_write", {}, { timeoutMs: 10000 });
  assert.equal(undo1.ok, true, undo1.text);
  assert.equal(await fs.readFile(path.join(h.root, "existing.md"), "utf8"), "旧内容第一行\n旧内容第二行\n");

  const undoEmpty = await h.client.callTool("undo_write", {}, { timeoutMs: 10000 });
  assert.equal(undoEmpty.ok, false, "空栈必须报错");

  await h.exec({ op: "mcp", tool: "write_file", args: { path: "fresh.txt", content: "临时" } });
  const undo2 = await h.client.callTool("undo_write", {}, { timeoutMs: 10000 });
  assert.equal(undo2.ok, true, undo2.text);
  assert.ok(!await fs.stat(path.join(h.root, "fresh.txt")).then(() => true, () => false), "新建文件撤销后应删除");
});

test("写入门控 create_directory：dryRun 风险分级 + undo 非空目录拒绝", async (t) => {
  t.confirmDecisions = ["yes"];
  const h = await makeHarness(t);
  const preview = await h.exec({ op: "mcp", tool: "create_directory", args: { path: "sub/dir", dryRun: true } });
  assert.equal(preview.ok, true, preview.text);
  assert.match(preview.text, /^风险: 新建/m);
  const created = await h.exec({ op: "mcp", tool: "create_directory", args: { path: "sub/dir" } });
  assert.equal(created.ok, true, created.text);
  // 目录内放文件后撤销：拒绝且目录保留
  await fs.writeFile(path.join(h.root, "sub", "dir", "f.txt"), "x", "utf8");
  const undo = await h.client.callTool("undo_write", {}, { timeoutMs: 10000 });
  assert.equal(undo.ok, false);
  assert.match(undo.text, /非空|撤销失败/);
  assert.ok(await fs.stat(path.join(h.root, "sub", "dir")).then(() => true, () => false));
});

test("写入门控 undo_write：模型调用经审批，dryRun 预览不弹栈，确认后恰好撤销一笔", async (t) => {
  t.confirmDecisions = ["yes", "yes"];
  const h = await makeHarness(t);
  // 预置：一笔已批准的覆盖写入进入撤销栈
  await h.exec({ op: "mcp", tool: "write_file", args: { path: "existing.md", content: "被覆盖了" } });
  // 模型 dryRun 自查：纯预览不进入确认、不弹出撤销栈、文件不变
  const preview = await h.exec({ op: "mcp", tool: "undo_write", args: { dryRun: true } });
  assert.equal(preview.ok, true, preview.text);
  assert.match(preview.text, /^风险: 覆盖已有内容/m);
  assert.match(preview.text, /write_file existing\.md/);
  assert.equal(h.confirmCalls.length, 1, "dryRun 预览不得触发新的确认（1 次来自预置写入）");
  assert.equal(await fs.readFile(path.join(h.root, "existing.md"), "utf8"), "被覆盖了", "预览不得改动文件");
  // 确认后执行：恰好撤销一笔（覆盖型恢复原内容）
  const undone = await h.exec({ op: "mcp", tool: "undo_write", args: {} });
  assert.equal(undone.ok, true, undone.text);
  assert.equal(await fs.readFile(path.join(h.root, "existing.md"), "utf8"), "旧内容第一行\n旧内容第二行\n");
  // 栈中只有一笔：再次撤销必须报错，不得连退或静默成功
  const empty = await h.exec({ op: "mcp", tool: "undo_write", args: {} });
  assert.equal(empty.ok, false, "撤销栈已空，第二次必须失败而不是连退");
});

test("写入门控 undo_write：host 写入清单按名拦截，未开放写入时 fail-closed 不产生副作用", async (t) => {
  t.confirmDecisions = ["yes"];
  const h = await makeHarness(t);
  await h.exec({ op: "mcp", tool: "write_file", args: { path: "existing.md", content: "被覆盖了" } });
  // 真实 isMcpWriteTool（非测试注入谓词）：allowWrite 关闭时必须拒绝且文件不变
  const denied = await runAction(
    { op: "mcp", tool: "undo_write", args: {} },
    h.root,
    { mcp: { client: h.client, allow: ["undo_write"], allowWrite: false } }
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "write-not-allowed");
  assert.equal(await fs.readFile(path.join(h.root, "existing.md"), "utf8"), "被覆盖了", "拒绝后文件不得变化");
});

test("写入门控：resetApprovals 收回会话同意，同工具再次写入重新询问", async (t) => {
  t.confirmDecisions = ["session", "yes"];
  const h = await makeHarness(t);
  const first = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "hi" } });
  assert.equal(first.ok, true, first.text);
  assert.equal(h.confirmCalls.length, 1);
  assert.ok(h.gate.sessionApproved.has("write_file"), "会话同意应记录在案");
  // 用户切换审批模式时 cli 调用 resetApprovals：收紧后旧授权不得继续生效
  h.gate.resetApprovals();
  assert.ok(!h.gate.sessionApproved.has("write_file"));
  const second = await h.exec({ op: "mcp", tool: "write_file", args: { path: "new.txt", content: "hi2" } });
  assert.equal(second.ok, true, second.text);
  assert.equal(h.confirmCalls.length, 2, "收回会话同意后必须重新询问");
});
