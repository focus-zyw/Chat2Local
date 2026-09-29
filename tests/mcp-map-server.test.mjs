import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpClient } from "../src/mcp-client.mjs";

const SERVER = fileURLToPath(new URL("../demo/mcp-map-server.mjs", import.meta.url));

/** fixture 布局（行号是断言依据，改动需同步）：
 *  a.mjs     L3 fn alpha · L7 class Widget · L8 method constructor(Widget) · L11 method run(Widget) · L16 fn makeWidget
 *  b.js      L2 fn useAlpha（引用 alpha/Widget/makeWidget，抬高它们的 ×N 与 a.mjs 排序）
 *  sub/c.py  L1 class Greeter · L4 method hello · L8 fn main
 *  .env（敏感，不得出现）· node_modules/x.js（依赖，不得出现）· notes.md（非代码，不进地图）
 */
async function makeFixtureRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-map-fixture-"));
  await fs.writeFile(
    path.join(root, "a.mjs"),
    [
      "// 注释行不产生符号", // L1
      "", // L2
      "export function alpha() {", // L3
      "  return 1;", // L4
      "}", // L5
      "", // L6
      "export class Widget {", // L7
      "  constructor(opts) {", // L8
      "    this.opts = opts;", // L9
      "  }", // L10
      "  run(input) {", // L11
      "    return input;", // L12
      "  }", // L13
      "}", // L14
      "", // L15
      "export const makeWidget = (o) => new Widget(o);", // L16
      "", // L17
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "b.js"),
    ["import { alpha, Widget, makeWidget } from './a.mjs';", "function useAlpha() {", "  return alpha() + makeWidget(new Widget());", "}"].join("\n") + "\n",
    "utf8"
  );
  await fs.mkdir(path.join(root, "sub"));
  await fs.writeFile(
    path.join(root, "sub", "c.py"),
    ["class Greeter:", "    name = 'g'", "", "    def hello(self):", "        return 'hi'", "", "", "def main():", "    pass"].join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(root, ".env"), "SECRET=dummy\n", "utf8");
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "x.js"), "function hidden() {}\n", "utf8");
  await fs.writeFile(path.join(root, "notes.md"), "# 无符号文档\n", "utf8");
  return root;
}

function clientFor(...roots) {
  return createMcpClient({ command: process.execPath, args: [SERVER, ...roots] }, { startupTimeoutMs: 20000 });
}

test("mcp-map-server：行号准确的符号地图，引用计数抬升被引用文件排序", async () => {
  const root = await makeFixtureRepo();
  let client;
  try {
    client = await clientFor(root);
    const listed = await client.listTools({ timeoutMs: 10000 });
    assert.equal(listed.ok, true, listed.text);
    assert.deepEqual(listed.tools.map((t) => t.name), ["symbol_map"]);

    const r = await client.callTool("symbol_map", {}, { timeoutMs: 15000 });
    assert.equal(r.ok, true, r.text);
    // 行号与 read 的 line 参数同坐标：a.mjs 的符号行号逐一核对
    assert.ok(r.text.includes("a.mjs: L3 fn alpha"), `行号不符：${r.text}`);
    assert.ok(r.text.includes("L7 class Widget"), r.text);
    assert.ok(r.text.includes("L8 method constructor(Widget)"), r.text);
    assert.ok(r.text.includes("L11 method run(Widget)"), r.text);
    assert.ok(r.text.includes("L16 fn makeWidget"), r.text);
    assert.ok(r.text.includes("b.js: L2 fn useAlpha"), r.text);
    // Python：类/缩进方法/顶层函数
    assert.ok(r.text.includes("sub/c.py: L1 class Greeter · L4 method hello · L8 fn main"), r.text);
    // 出现次数：alpha/Widget/makeWidget 被 b.js 引用，×N ≥ 2
    assert.ok(/fn alpha ×\d+/.test(r.text) && /class Widget ×\d+/.test(r.text), r.text);
    // a.mjs 因被引用最多排在 b.js 之前
    assert.ok(r.text.indexOf("a.mjs:") < r.text.indexOf("b.js:"), `排序不符：${r.text}`);
    // 敏感与依赖目录不进地图
    assert.ok(!r.text.includes(".env") && !r.text.includes("node_modules") && !r.text.includes("hidden"), r.text);
    assert.ok(r.text.includes("行号与 read 的 line 参数同坐标"), r.text);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-map-server：path 限定子目录；越界与敏感路径拒绝", async () => {
  const root = await makeFixtureRepo();
  let client;
  try {
    client = await clientFor(root);
    const sub = await client.callTool("symbol_map", { path: "sub" }, { timeoutMs: 15000 });
    assert.equal(sub.ok, true, sub.text);
    assert.ok(sub.text.includes("c.py") && sub.text.includes("L8 fn main"), sub.text);
    assert.ok(!sub.text.includes("a.mjs") && !sub.text.includes("b.js"), `子目录限定失效：${sub.text}`);

    const outside = await client.callTool("symbol_map", { path: path.dirname(root) }, { timeoutMs: 15000 });
    assert.equal(outside.ok, false);
    assert.match(outside.text, /越界/);

    const denied = await client.callTool("symbol_map", { path: ".env" }, { timeoutMs: 15000 });
    assert.equal(denied.ok, false);
    assert.match(denied.text, /敏感/);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-map-server：字符预算下限 500，超出按预算截断并提示", async () => {
  const root = await makeFixtureRepo();
  // 追加 8 个填充模块，把地图推过 500 字符预算（最小预算也钳在 500，更小值不生效）
  for (let i = 1; i <= 8; i += 1) {
    await fs.writeFile(
      path.join(root, `mod${i}.mjs`),
      ["// filler", `export function fillName${i}() {`, `  return ${i};`, "}", "", `export const helper${i} = () => fillName${i}();`].join("\n") + "\n",
      "utf8"
    );
  }
  let client;
  try {
    client = await clientFor(root);
    const clipped = await client.callTool("symbol_map", { maxChars: 120 }, { timeoutMs: 15000 });
    assert.equal(clipped.ok, true, clipped.text);
    assert.ok(clipped.text.includes("已按 500 字符预算截断"), `120 被钳到 500 后应截断：${clipped.text}`);
    assert.ok(clipped.text.length <= 700, `超预算太多：${clipped.text.length}`);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-map-server：联接绕过被双重核对与不跟随遍历阻断", async () => {
  const root = await makeFixtureRepo();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-map-out-"));
  // 根内敏感目录 + 指向它的无邪名联接；根外联接指回根内
  await fs.mkdir(path.join(root, ".ssh"));
  await fs.writeFile(path.join(root, ".ssh", "k.py"), "def secretkey():\n    pass\n", "utf8");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(path.join(root, ".ssh"), path.join(root, "alias"), linkType);
  await fs.symlink(root, path.join(outside, "back-link"), linkType);
  let client;
  try {
    client = await clientFor(root);
    // 根外联接指回根内：请求路径越界即拒，不因解析结果落回根内而放行
    const outsideReq = await client.callTool("symbol_map", { path: path.join(outside, "back-link") }, { timeoutMs: 15000 });
    assert.equal(outsideReq.ok, false);
    assert.match(outsideReq.text, /越界/);
    // 根内无邪名联接指向敏感目录：真实路径复核拒绝
    const aliasReq = await client.callTool("symbol_map", { path: "alias" }, { timeoutMs: 15000 });
    assert.equal(aliasReq.ok, false);
    assert.match(aliasReq.text, /敏感/);
    // 默认遍历不跟随联接：敏感目录内容不得经 alias 出现在地图里
    const full = await client.callTool("symbol_map", {}, { timeoutMs: 15000 });
    assert.equal(full.ok, true, full.text);
    assert.ok(!full.text.includes("secretkey") && !full.text.includes("k.py"), `联接绕过：${full.text}`);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("mcp-map-server：合成凭据不可见——直接/别名列举与读取，合法内容可见", async () => {
  const root = await makeFixtureRepo();
  await fs.writeFile(path.join(root, ".env"), "SECRET=dummy\n", "utf8");
  await fs.writeFile(path.join(root, "creds.json"), '{"token":"dummy"}\n', "utf8");
  await fs.mkdir(path.join(root, ".aws"));
  await fs.writeFile(path.join(root, ".aws", "s.py"), "def leak():\n    pass\n", "utf8");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(path.join(root, ".aws"), path.join(root, "alias"), linkType);
  let client;
  try {
    client = await clientFor(root);
    const full = await client.callTool("symbol_map", {}, { timeoutMs: 15000 });
    assert.equal(full.ok, true, full.text);
    // 合成凭据与敏感路径内容在任何输出形态下不可见
    for (const forbidden of ["SECRET", "creds.json", "dummy", "leak", ".aws", "alias"]) {
      assert.ok(!full.text.includes(forbidden), `泄露 ${forbidden}：${full.text}`);
    }
    // 合法内容可见：正常符号与文件名
    assert.ok(full.text.includes("alpha") && full.text.includes("b.js"), full.text);
    // 直接读取敏感起点即拒
    const denied = await client.callTool("symbol_map", { path: ".env" }, { timeoutMs: 15000 });
    assert.equal(denied.ok, false);
    assert.match(denied.text, /敏感/);
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mcp-map-server：不存在的授权目录启动即退出，握手按探测失败处理", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-map-empty-"));
  try {
    await assert.rejects(clientFor(path.join(dir, "no-such-dir")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
