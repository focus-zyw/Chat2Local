import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpClient } from "../src/mcp-client.mjs";

const SERVER = fileURLToPath(new URL("../demo/mcp-fs-server.mjs", import.meta.url));

async function makeFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-fs-fixture-"));
  await fs.writeFile(path.join(root, "a.md"), "# A\n内容A\n", "utf8");
  await fs.writeFile(path.join(root, "big.txt"), "x".repeat(30000), "utf8");
  await fs.writeFile(path.join(root, ".env"), "SECRET=dummy\n", "utf8");
  await fs.writeFile(path.join(root, ".env.example"), "# 示例，不是敏感项\n", "utf8");
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(path.join(root, "sub", "b.txt"), "内容B\n", "utf8");
  return root;
}

function clientFor(...roots) {
  return createMcpClient(
    { command: process.execPath, args: [SERVER, ...roots] },
    { startupTimeoutMs: 20000 }
  );
}

test("mcp-fs-server：目录列举与树隐藏敏感项，保留示例文件", async () => {
  const root = await makeFixtureRoot();
  let client;
  try {
    client = await clientFor(root);
    const listed = await client.callTool("list_directory", {}, { timeoutMs: 10000 });
    assert.equal(listed.ok, true, listed.text);
    assert.ok(listed.text.includes("a.md") && listed.text.includes("[DIR] sub"), listed.text);
    assert.ok(!listed.text.includes("\n.env\n") && !listed.text.startsWith(".env\n"), `.env 必须隐藏：${listed.text}`);
    assert.ok(listed.text.includes(".env.example"), "示例文件不是敏感项，应展示");
    assert.ok(listed.text.includes("已隐藏 1 个敏感"), listed.text);

    const tree = await client.callTool("directory_tree", {}, { timeoutMs: 10000 });
    assert.equal(tree.ok, true, tree.text);
    assert.ok(tree.text.includes("sub") && tree.text.includes("b.txt"), tree.text);
    assert.ok(!tree.text.includes(".env\n"), `树里不得出现 .env：${tree.text}`);
    assert.ok(tree.text.includes("已隐藏"), tree.text);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-fs-server：批量读逐项容错——正常读出、敏感拒绝、越界拒绝、缺失报错", async () => {
  const root = await makeFixtureRoot();
  let client;
  try {
    client = await clientFor(root);
    const r = await client.callTool(
      "read_multiple_files",
      { paths: ["a.md", "sub/b.txt", ".env", path.dirname(root), "missing.md"] },
      { timeoutMs: 10000 }
    );
    assert.equal(r.ok, true, r.text);
    assert.ok(r.text.includes("内容A") && r.text.includes("内容B"), `正常文件应读出：${r.text}`);
    assert.ok(r.text.includes("敏感路径"), `.env 必须被拒绝：${r.text}`);
    assert.ok(r.text.includes("越界"), `目录外的真实路径必须按越界拒绝：${r.text}`);
    assert.ok(r.text.includes("不存在"), `缺失文件逐项报错：${r.text}`);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-fs-server：元数据可用但敏感路径拒绝；多根目录带标签", async () => {
  const root1 = await makeFixtureRoot();
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-fs-fixture2-"));
  await fs.writeFile(path.join(root2, "c.md"), "内容C\n", "utf8");
  let client;
  try {
    client = await clientFor(root1, root2);
    const info = await client.callTool("get_file_info", { path: "sub/b.txt" }, { timeoutMs: 10000 });
    assert.equal(info.ok, true, info.text);
    assert.ok(info.text.includes("文件") && info.text.includes("修改:"), info.text);

    const denied = await client.callTool("get_file_info", { path: ".env" }, { timeoutMs: 10000 });
    assert.equal(denied.ok, false, "敏感路径元数据也必须拒绝");
    assert.match(denied.text, /敏感/);

    const multi = await client.callTool("read_multiple_files", { paths: [path.join(root2, "c.md")] }, { timeoutMs: 10000 });
    assert.equal(multi.ok, true, multi.text);
    assert.ok(multi.text.includes("[R2] c.md") && multi.text.includes("内容C"), `多根应带标签：${multi.text}`);
  } finally {
    await client?.close();
    await fs.rm(root1, { recursive: true, force: true });
    await fs.rm(root2, { recursive: true, force: true });
  }
});

test("mcp-fs-server：超大输出按上限截断并提示", async () => {
  const root = await makeFixtureRoot();
  let client;
  try {
    client = await clientFor(root);
    const huge = await client.callTool("read_multiple_files", { paths: ["big.txt"] }, { timeoutMs: 10000 });
    assert.equal(huge.ok, true, huge.text);
    assert.ok(huge.text.includes("已截断"), `缺截断提示：${huge.text.slice(-200)}`);
    assert.ok(huge.text.length <= 7400, `截断后仍超限：${huge.text.length}`);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-fs-server：不存在的授权目录启动即退出，握手按探测失败处理", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-fs-empty-"));
  try {
    await assert.rejects(clientFor(path.join(dir, "no-such-dir")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("mcp-fs-server：请求路径含敏感目录时，根内目录联接也不能绕过拒绝", async () => {
  const root = await makeFixtureRoot();
  let client;
  try {
    const alias = path.join(root, ".ssh");
    await fs.symlink(path.join(root, "sub"), alias, process.platform === "win32" ? "junction" : "dir");
    client = await clientFor(root);
    for (const requested of [".ssh/b.txt", path.join(alias, "b.txt")]) {
      const read = await client.callTool("read_multiple_files", { paths: [requested] }, { timeoutMs: 10000 });
      assert.equal(read.ok, true, read.text);
      assert.match(read.text, /敏感路径/);
      assert.doesNotMatch(read.text, /内容B/);
      const info = await client.callTool("get_file_info", { path: requested }, { timeoutMs: 10000 });
      assert.equal(info.ok, false, info.text);
      assert.match(info.text, /敏感路径/);
    }
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-fs-server：仅有敏感文件时仍报告隐藏数量", async () => {
  const root = await makeFixtureRoot();
  let client;
  try {
    await fs.mkdir(path.join(root, "only-secret"));
    await fs.writeFile(path.join(root, "only-secret", ".env"), "FAKE=fixture\n");
    client = await clientFor(root);
    const result = await client.callTool("list_directory", { path: "only-secret" }, { timeoutMs: 10000 });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /已隐藏 1 个敏感/);
    assert.doesNotMatch(result.text, /\.env/);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-fs-server：列目录大小不跟随指向授权根外的联接", async () => {
  const root = await makeFixtureRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-fs-outside-"));
  let client;
  try {
    await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    client = await clientFor(root);
    const result = await client.callTool("list_directory", { path: ".", withSizes: true }, { timeoutMs: 10000 });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /escape/);
    assert.doesNotMatch(result.text, /escape \([^\n]+\)/);
    const info = await client.callTool("get_file_info", { path: "escape" }, { timeoutMs: 10000 });
    assert.equal(info.ok, false, info.text);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("mcp-fs-server：请求路径在根外，即使链接指回根内也拒绝", async () => {
  const root = await makeFixtureRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-fs-alias-"));
  let client;
  try {
    const alias = path.join(outside, "back-inside");
    await fs.symlink(path.join(root, "sub"), alias, process.platform === "win32" ? "junction" : "dir");
    client = await clientFor(root);
    const result = await client.callTool(
      "read_multiple_files", { paths: [path.join(alias, "b.txt")] }, { timeoutMs: 10000 }
    );
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /越界/);
    assert.doesNotMatch(result.text, /内容B/);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("mcp-fs-server：全文 NUL 检测与单文件字节上限", async () => {
  const root = await makeFixtureRoot();
  let client;
  try {
    await fs.writeFile(path.join(root, "late-nul.bin"), Buffer.concat([
      Buffer.alloc(8192, 0x61), Buffer.from([0]), Buffer.from("tail"),
    ]));
    await fs.writeFile(path.join(root, "at-limit.txt"), Buffer.alloc(1_000_000, 0x61));
    await fs.writeFile(path.join(root, "over-limit.txt"), Buffer.alloc(1_000_001, 0x61));
    client = await clientFor(root);
    const result = await client.callTool(
      "read_multiple_files", { paths: ["late-nul.bin", "over-limit.txt", "a.md"] }, { timeoutMs: 10000 }
    );
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /late-nul\.bin: \(二进制文件，未读取\)/);
    assert.match(result.text, /over-limit\.txt: ✗ 超过单文件上限/);
    assert.match(result.text, /内容A/);
    const exact = await client.callTool(
      "read_multiple_files", { paths: ["at-limit.txt"] }, { timeoutMs: 10000 }
    );
    assert.equal(exact.ok, true, exact.text);
    assert.match(exact.text, /at-limit\.txt:/);
    assert.match(exact.text, /已截断/);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
