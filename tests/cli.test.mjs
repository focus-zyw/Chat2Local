import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  positiveNumberArg,
  rootDirArg,
  siteIdArg,
  askTaskArg,
  roleIdArg,
  mcpCatalogArg,
  mcpAllowArg,
  mcpSpecArg,
  syncMcpCatalog,
  createMcpCatalogController,
  closeWatchResources,
} from "../src/cli.mjs";
import { MCP_TOOLS_MAX } from "../src/mcp-client.mjs";

test("CLI 正数选项：缺省、正整数与正小数", () => {
  assert.equal(positiveNumberArg([], "--watch", 240), 240);
  assert.equal(positiveNumberArg(["--watch", "1.5"], "--watch", 240), 1.5);
  assert.equal(
    positiveNumberArg(["--rounds", "3"], "--rounds", 12, { integer: true }),
    3
  );
});

test("CLI 正数选项：拒绝缺值、NaN、无穷、零、负数和非整数轮数", () => {
  for (const argv of [
    ["--watch"],
    ["--watch", "--headless"],
    ["--watch", "nope"],
    ["--watch", "Infinity"],
    ["--watch", "0"],
    ["--watch", "-1"],
  ]) {
    assert.throws(() => positiveNumberArg(argv, "--watch", 240), /--watch 必须是大于 0 的数字/);
  }
  assert.throws(
    () => positiveNumberArg(["--rounds", "1.5"], "--rounds", 12, { integer: true }),
    (err) => err.code === "CLI_USAGE" && /--rounds 必须是正整数/.test(err.message)
  );
});

test("CLI Host Root：接受目录，拒绝缺值、不存在路径和普通文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-cli-root-"));
  const file = path.join(root, "file.txt");
  await fs.writeFile(file, "x");

  assert.equal(rootDirArg(["--root", root]), path.resolve(root));
  for (const argv of [
    ["--root"],
    ["--root", "--headless"],
    ["--root", path.join(root, "missing")],
    ["--root", file],
  ]) {
    assert.throws(
      () => rootDirArg(argv),
      (err) => err.code === "CLI_USAGE" && /Host Root|--root/.test(err.message)
    );
  }
});

test("CLI 站点：接受正式站点与 mock，未知站点在启动浏览器前拒绝", () => {
  assert.equal(siteIdArg("chatgpt"), "chatgpt");
  assert.equal(siteIdArg("mock"), "mock");
  assert.throws(
    () => siteIdArg("definitely-not-a-site"),
    (err) =>
      err.code === "CLI_USAGE" &&
      /未知站点/.test(err.message) &&
      /node src\/cli\.mjs list/.test(err.message)
  );
});

test("CLI 排障标志不进入任务正文，保留 -- 后的原样任务", () => {
  assert.equal(askTaskArg(["chatgpt", "启动失败", "--diagnose", "--root", "D:\\demo"]), "启动失败");
  assert.equal(askTaskArg(["chatgpt", "--diagnose", "启动失败"]), "启动失败");
  assert.equal(askTaskArg(["chatgpt", "--diagnose", "--", "启动失败", "--root"]), "启动失败 --root");
  assert.equal(askTaskArg(["chatgpt", "审批时限", "--role", "text", "--root", "D:\\notes"]), "审批时限");
});

test("CLI 角色：默认代码导师，拒绝未知角色", () => {
  assert.equal(roleIdArg([]), "code");
  assert.equal(roleIdArg(["--role", "text"]), "text");
  assert.throws(() => roleIdArg(["--role", "other"]), /角色/);
  assert.throws(() => roleIdArg(["--role"]), /角色/);
});

test("askTaskArg/--audit：audit 位于任务前后均可解析，互斥 --diagnose", () => {
  assert.equal(askTaskArg(["chatgpt", "核查 search 承诺", "--audit"]), "核查 search 承诺");
  assert.equal(askTaskArg(["chatgpt", "--audit", "--", "核查 search 承诺"]), "核查 search 承诺");
});

test("mcpCatalogArg：目录切片即允许列表；探测失败/空目录返回 null", () => {
  const many = Array.from({ length: MCP_TOOLS_MAX + 1 }, (_, i) => ({ name: `t${i + 1}`, description: "", required: [], props: [] }));
  const catalog = mcpCatalogArg({ ok: true, tools: many });
  assert.equal(catalog.tools.length, MCP_TOOLS_MAX, "目录与展示同为上限个数");
  assert.deepEqual(catalog.allow, many.slice(0, MCP_TOOLS_MAX).map((t) => t.name));
  assert.equal(MCP_TOOLS_MAX, 12, "上限数值有意变更时须同步 README 与帮助文案");
  assert.equal(mcpCatalogArg({ ok: false, error: "timeout" }), null, "探测失败不得产生目录");
  assert.equal(mcpCatalogArg({ ok: true, tools: [] }), null, "空目录不得产生授权");
  assert.equal(mcpCatalogArg(undefined), null);

  const required = Array.from({ length: 30 }, (_, i) => `required_parameter_${i}`);
  const tooLong = {
    name: "too_long",
    description: "",
    required,
    props: required.map((name) => ({ name, type: "string", required: true, description: "" })),
  };
  assert.equal(mcpCatalogArg({ ok: true, tools: [tooLong] }), null, "无法完整展示调用 JSON 的工具不得进入允许列表");
});

test("syncMcpCatalog：续接时同步当前目录，关闭 MCP 也发送空目录", async () => {
  const delivered = [];
  const driver = {
    async deliver(payload) {
      delivered.push(payload);
      return { ok: true };
    },
  };
  assert.deepEqual(await syncMcpCatalog(driver, false, null), { ok: true, synced: false });
  assert.equal(delivered.length, 0, "新聊天由开场白声明能力，无需额外同步");

  assert.deepEqual(await syncMcpCatalog(driver, true, null), { ok: true, synced: true });
  assert.match(delivered[0], /本次未授权任何 mcp 工具/);

  const failed = await syncMcpCatalog({ deliver: async () => ({ ok: false, error: "fill-failed" }) }, true, {
    tools: [{ name: "search_files", required: [], props: [] }],
  });
  assert.deepEqual(failed, { ok: false, synced: false, error: "fill-failed" });
});

test("MCP 目录：首次发现前的变化与开场白发送中的收缩进入最新授权和同步", async () => {
  const client = {};
  const sent = [];
  const controller = createMcpCatalogController({
    client, explicitAllow: ["a", "b"],
    driver: { async deliver(payload) { sent.push(payload); return { ok: true }; } },
  });
  const tool = (name) => ({ name, description: name, required: [], props: [] });
  client.onCatalogUpdate([tool("a"), tool("b")]); // 首次 listTools 返回前
  controller.initialize({ ok: true, tools: [tool("a")] });
  assert.deepEqual(controller.catalog.allow, ["a", "b"]);
  const introRevision = controller.revision;
  client.onCatalogUpdate([tool("a")]); // 开场白发送期间
  await controller.syncBeforeWatch(false, introRevision);
  assert.deepEqual(controller.catalog.allow, ["a"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /"a"|工具 a/);
  assert.doesNotMatch(sent[0], /"b"|工具 b/);
});

test("MCP 目录：运行中同步状态不明停止 watcher、保留断点，不再恢复", async () => {
  const client = {};
  const records = [];
  const events = [];
  const tool = (name) => ({ name, description: name, required: [], props: [] });
  const controller = createMcpCatalogController({
    client, explicitAllow: ["a", "b"],
    driver: { async deliver() { events.push("deliver"); return { ok: false, error: "send-unknown" }; } },
    checkpoint: { read: () => null, write: (record) => records.push(record) },
    onFailure: () => events.push("failed"),
  });
  controller.initialize({ ok: true, tools: [tool("a"), tool("b")] });
  await controller.syncBeforeWatch(false, controller.revision);
  const watcher = async () => { events.push("await watcher"); };
  watcher.pause = async () => { events.push("pause"); };
  watcher.resume = () => { events.push("resume"); };
  watcher.signal = () => { events.push("signal"); };
  watcher.isPaused = () => false;
  controller.attachWatcher(watcher);
  client.onCatalogUpdate([tool("a")]);
  await controller.waitForSync();
  assert.deepEqual(controller.catalog.allow, ["a"]);
  assert.equal(controller.failed, true);
  assert.deepEqual(events, ["pause", "deliver", "signal", "await watcher", "failed"]);
  assert.equal(records[0].phase, "catalog-sync");
});

test("MCP 目录：同步期间再次变化，继续同步到最终目录后才恢复", async () => {
  const client = {};
  const events = [];
  let deliveries = 0;
  const tool = (name) => ({ name, description: name, required: [], props: [] });
  const controller = createMcpCatalogController({
    client, explicitAllow: ["a", "b"],
    driver: { async deliver(payload) {
      events.push(payload);
      if (++deliveries === 1) client.onCatalogUpdate([]);
      return { ok: true };
    } },
  });
  controller.initialize({ ok: true, tools: [tool("a"), tool("b")] });
  await controller.syncBeforeWatch(false, controller.revision);
  const watcher = async () => {};
  watcher.pause = async () => { events.push("pause"); };
  watcher.resume = () => { events.push("resume"); };
  watcher.isPaused = () => false;
  controller.attachWatcher(watcher);
  client.onCatalogUpdate([tool("a")]);
  await controller.waitForSync();
  assert.deepEqual(controller.catalog.allow, []);
  assert.equal(controller.failed, false);
  assert.equal(events.length, 4);
  assert.equal(events[0], "pause");
  assert.match(events[2], /未授权任何 mcp 工具/);
  assert.equal(events[3], "resume");
});

test("MCP 目录：续接启动同步失败留下核对断点，不启动 watcher", async () => {
  const client = {};
  const records = [];
  const controller = createMcpCatalogController({
    client,
    driver: { async deliver() { return { ok: false, error: "send-unknown" }; } },
    checkpoint: { read: () => null, write: (record) => records.push(record) },
  });
  controller.initialize({ ok: true, tools: [{ name: "a", required: [], props: [] }] });
  await assert.rejects(controller.syncBeforeWatch(true, controller.revision), /人工核对/);
  assert.equal(controller.failed, true);
  assert.equal(records[0].phase, "catalog-sync");
});

test("watch 收尾：先停止新动作，释放 MCP 在途请求，再等待 watcher 和关闭浏览器", async () => {
  const events = [];
  let releaseStop;
  const mcpReleased = new Promise((resolve) => { releaseStop = resolve; });
  const stopWatcher = async () => {
    events.push("await watcher");
    await mcpReleased;
  };
  stopWatcher.signal = () => { events.push("signal"); };
  await closeWatchResources({
    stopWatcher,
    mcpClient: { async close() { events.push("close mcp"); releaseStop(); } },
    rl: { close() { events.push("close input"); } },
    context: { async close() { events.push("close browser"); } },
  });
  assert.deepEqual(events, ["signal", "close mcp", "await watcher", "close input", "close browser"]);
});

test("mcpAllowArg：可重复收集工具名；等号形式可用；未提供返回 null", () => {
  assert.equal(mcpAllowArg([]), null);
  assert.equal(mcpAllowArg(["--root", "x"]), null);
  assert.deepEqual(mcpAllowArg(["--mcp-allow", "a", "--mcp-allow", "b"]), ["a", "b"]);
  assert.deepEqual(mcpAllowArg(["--mcp-allow=browser_navigate"]), ["browser_navigate"]);
  assert.throws(() => mcpAllowArg(["--mcp-allow"]), /需要工具名/);
  assert.throws(() => mcpAllowArg(["--mcp-allow", "--root"]), /需要工具名/);
});

test("mcpSpecArg：--mcp-arg= 等号形式可传以 -- 开头的 server 旗标", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-mcp-"));
  try {
    const script = path.join(dir, "server.js");
    await fs.writeFile(script, "// fixture\n");
    const root = path.join(dir, "root");
    await fs.mkdir(root);
    const spec = mcpSpecArg(["--mcp", script, "--mcp-arg=--headless", "--mcp-arg=path-value"], root);
    assert.deepEqual(spec.args.slice(1), ["--headless", "path-value"]);
    // 空格形式的 -- 值仍然拒绝（防止误把我方旗标喂给 server）
    assert.throws(() => mcpSpecArg(["--mcp", script, "--mcp-arg", "--headless"], root), /--mcp-arg=<值>/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("mcpCatalogArg：显式授权取交集并按用户顺序；未点名与超上限的记入 dropped", () => {
  const probed = { ok: true, tools: ["t5", "t1", "t2", "t3", "t4"].map((name) => ({ name, description: "", required: [], props: [] })) };
  const catalog = mcpCatalogArg(probed, ["t3", "t9", "t1"]);
  assert.deepEqual(catalog.allow, ["t3", "t1"], "按用户给出的顺序授权");
  assert.deepEqual(catalog.dropped.sort(), ["t2", "t4", "t5", "t9"]);
  // 显式授权同样受目录上限约束
  const overProbed = {
    ok: true,
    tools: Array.from({ length: MCP_TOOLS_MAX + 1 }, (_, i) => ({ name: `u${i + 1}`, description: "", required: [], props: [] })),
  };
  const over = mcpCatalogArg(overProbed, overProbed.tools.map((t) => t.name));
  assert.equal(over.allow.length, MCP_TOOLS_MAX);
  assert.ok(over.dropped.includes(`u${MCP_TOOLS_MAX + 1}`));
  // 全部点名不存在的工具 → 无目录
  assert.equal(mcpCatalogArg(probed, ["nope"]), null);
});

test("roleIdArg：watch 支持全部角色（含 task）；ask/chat 作用域拒绝 task", () => {
  assert.equal(roleIdArg(["--role", "task"]), "task", "watch 默认作用域含 task");
  assert.equal(roleIdArg(["--role", "text"]), "text");
  assert.equal(roleIdArg([]), "code");
  assert.throws(() => roleIdArg(["--role", "task"], ["code", "text"]), /不受支持的任务角色/);
  assert.throws(() => roleIdArg(["--role", "nope"]), /不受支持的任务角色/);
});
