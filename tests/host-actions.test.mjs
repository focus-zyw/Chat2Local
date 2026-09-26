import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runAction,
  underRoot,
  READ_MAX_CHARS,
  LS_MAX_ENTRIES,
  SEARCH_MAX_FILE_BYTES,
} from "../src/host-actions.mjs";

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-"));
  await fs.mkdir(path.join(root, "src", "sub"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"demo","type":"module"}\n');
  await fs.writeFile(path.join(root, "src", "app.js"), "console.log('hello from app');\n");
  await fs.writeFile(path.join(root, "src", "sub", "deep.txt"), "deep\n");
  await fs.writeFile(
    path.join(root, "src", "boom.js"),
    "console.log('out');\nprocess.exit(3);\n"
  );
  return root;
}

test("underRoot: 允许 root 内相对路径，拒绝 .. 越界与绝对路径", () => {
  const root = path.resolve("/tmp/somewhere");
  assert.ok(underRoot(root, "src/app.js"));
  assert.ok(underRoot(root, "."));
  assert.equal(underRoot(root, "../escape"), null);
  assert.equal(underRoot(root, "a/../../b"), null);
  assert.equal(underRoot(root, "C:\\Windows\\system32"), null);
  assert.equal(underRoot(root, "\\\\server\\share"), null);
});

test("符号链接不能绕过 root，root 内链接仍可读取", async () => {
  const root = await makeRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside secret\n");
  await fs.writeFile(path.join(outside, "outside.js"), "console.log('escaped');\n");

  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(outside, path.join(root, "escape"), linkType);

  for (const action of [
    { op: "read", path: "escape/secret.txt" },
    { op: "ls", path: "escape", recursive: true },
    { op: "run", path: "escape/outside.js" },
  ]) {
    const result = await runAction(action, root);
    assert.equal(result.ok, false);
    assert.equal(result.error, "host-path");
  }

  await fs.mkdir(path.join(root, "inside"));
  await fs.writeFile(path.join(root, "inside", "allowed.txt"), "inside\n");
  await fs.symlink(path.join(root, "inside"), path.join(root, "inside-link"), linkType);
  const allowed = await runAction({ op: "read", path: "inside-link/allowed.txt" }, root);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.text, "inside\n");
});

test("敏感路径：直接读取与搜索被拒，样例文件仍可读取", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, ".env"), "TOKEN=fixture-only\n");
  await fs.writeFile(path.join(root, ".env.example"), "TOKEN=example\n");
  await fs.writeFile(path.join(root, "id_ed25519"), "fixture-key\n");
  for (const action of [
    { op: "read", path: ".env" },
    { op: "search", path: ".env", pattern: "TOKEN" },
    { op: "read", path: "id_ed25519" },
  ]) {
    const result = await runAction(action, root);
    assert.equal(result.ok, false);
    assert.equal(result.error, "sensitive-path");
    assert.doesNotMatch(result.text, /fixture-only|fixture-key/);
  }
  const example = await runAction({ op: "read", path: ".env.example" }, root);
  assert.equal(example.ok, true);
  assert.equal(example.text, "TOKEN=example\n");
});

test("敏感路径：目录清单与递归搜索均隐藏文件名和内容", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, ".ssh"));
  await fs.writeFile(path.join(root, ".ssh", "id_rsa"), "needle-private\n");
  await fs.writeFile(path.join(root, "src", ".env.local"), "needle-secret\n");
  await fs.writeFile(path.join(root, "src", "safe.txt"), "needle-safe\n");
  for (const action of [
    { op: "read", path: "." },
    { op: "ls", path: ".", recursive: true },
    { op: "ls", path: "src" },
  ]) {
    const result = await runAction(action, root);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.text, /\.ssh|\.env\.local|id_rsa/);
  }
  const found = await runAction({ op: "search", path: ".", pattern: "needle" }, root);
  assert.equal(found.ok, true);
  assert.match(found.text, /needle-safe/);
  assert.doesNotMatch(found.text, /needle-secret|needle-private|\.env|\.ssh/);
  const denied = await runAction({ op: "ls", path: ".ssh" }, root);
  assert.equal(denied.error, "sensitive-path");
});

test("敏感路径：root 内符号链接不能把秘密伪装成普通文件", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, ".ssh"));
  await fs.writeFile(path.join(root, ".ssh", "id_rsa"), "fixture-only\n");
  await fs.symlink(path.join(root, ".ssh"), path.join(root, "ordinary"), process.platform === "win32" ? "junction" : "dir");
  const result = await runAction({ op: "read", path: "ordinary/id_rsa" }, root);
  assert.equal(result.error, "sensitive-path");
  assert.doesNotMatch(result.text, /fixture-only/);
});

test("敏感路径：常见凭据名与可执行文件名被拒，依赖目录仍可显式读取", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "credentials.json"), "fixture-only\n");
  await fs.writeFile(path.join(root, ".env.js"), "console.log('should-not-run')\n");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "README.txt"), "public dependency\n");
  for (const action of [
    { op: "read", path: "credentials.json" },
    { op: "run", path: ".env.js" },
  ]) {
    const result = await runAction(action, root);
    assert.equal(result.error, "sensitive-path");
  }
  const dependency = await runAction({ op: "read", path: "node_modules/README.txt" }, root);
  assert.equal(dependency.ok, true);
  assert.equal(dependency.text, "public dependency\n");
});

test("read: 读文本文件", async () => {
  const root = await makeRoot();
  const r = await runAction({ op: "read", path: "package.json" }, root);
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"name":"demo","type":"module"}\n');
});

test("read: 目录读 = 单层清单，目录带斜杠", async () => {
  const root = await makeRoot();
  const r = await runAction({ op: "read", path: "src" }, root);
  assert.equal(r.ok, true);
  assert.deepEqual(r.text.split("\n").sort(), ["app.js", "boom.js", "sub/"]);
  assert.equal(r.dir, true);
});

test("read: 大目录条目封顶并注明截断", async () => {
  const root = await makeRoot();
  await Promise.all(
    Array.from({ length: LS_MAX_ENTRIES + 10 }, (_, i) =>
      fs.writeFile(path.join(root, `read-${String(i).padStart(4, "0")}.txt`), "x")
    )
  );
  const result = await runAction({ op: "read", path: "." }, root);
  const lines = result.text.split("\n");
  assert.equal(lines.length, LS_MAX_ENTRIES + 1);
  assert.match(result.text, /listing truncated at/);
});

test("read: offset/length 分段 + 超上限截断带续读提示", async () => {
  const root = await makeRoot();
  const big = "x".repeat(READ_MAX_CHARS + 500);
  await fs.writeFile(path.join(root, "big.txt"), big);
  const r1 = await runAction({ op: "read", path: "big.txt" }, root);
  assert.equal(r1.ok, true);
  assert.ok(r1.text.length < big.length);
  assert.match(r1.text, /"offset":/);
  const r2 = await runAction({ op: "read", path: "big.txt", offset: 5, length: 3 }, root);
  assert.equal(r2.text, "xxx");
  const r3 = await runAction({ op: "read", path: "nope.txt" }, root);
  assert.equal(r3.ok, false);
  assert.equal(r3.error, "not-found");
});

test("read: 流式 UTF-8 保持跨块多字节字符、UTF-16 offset 与 size 语义", async () => {
  const root = await makeRoot();
  const source = "a".repeat(65535) + "😀中文" + "z".repeat(100);
  await fs.writeFile(path.join(root, "unicode.txt"), source);

  const offset = 65534;
  const length = 8;
  const result = await runAction({ op: "read", path: "unicode.txt", offset, length }, root);
  assert.equal(result.ok, true);
  assert.equal(result.text, source.slice(offset, offset + length));
  assert.equal(result.size, source.length);
});

test("ls: 单层 / 递归 / 缺失返回 (missing)", async () => {
  const root = await makeRoot();
  const flat = await runAction({ op: "ls", path: "." }, root);
  assert.equal(flat.ok, true);
  assert.deepEqual(flat.text.split("\n").sort(), ["package.json", "src/"]);

  const tree = await runAction({ op: "ls", path: ".", recursive: true }, root);
  const lines = tree.text.split("\n");
  assert.ok(lines.includes("src/app.js"));
  assert.ok(lines.includes("src/sub/deep.txt"));

  const miss = await runAction({ op: "ls", path: "ghost" }, root);
  assert.equal(miss.ok, true);
  assert.equal(miss.text, "(missing)");
});

test("search: 单文件子串 + 忽略大小写", async () => {
  const root = await makeRoot();
  await fs.writeFile(
    path.join(root, "src", "app.js"),
    "const a = emitAll();\nconst b = plain();\nexport function EMIT(){ a(); }\n"
  );
  const r = await runAction({ op: "search", path: "src/app.js", pattern: "emit" }, root);
  assert.equal(r.ok, true);
  assert.match(r.text, /src\/app\.js:1: /);
  assert.match(r.text, /src\/app\.js:3: /);
  assert.ok(!r.text.includes("plain();"), "不命中的行不应出现");
});

test("search: 单文件遵守命中数与文件大小上限", async () => {
  const root = await makeRoot();
  const pathToFile = path.join(root, "many-hits.txt");
  await fs.writeFile(pathToFile, "hit one\nmiss\nhit two\nhit three\n");

  const limited = await runAction(
    { op: "search", path: "many-hits.txt", pattern: "hit", maxResults: 1 },
    root
  );
  assert.equal(limited.ok, true);
  assert.match(limited.text, /many-hits\.txt:1:/);
  assert.doesNotMatch(limited.text, /many-hits\.txt:3:/);
  assert.match(limited.text, /截断于 1 处命中/);

  await fs.writeFile(pathToFile, "hit\n".repeat(Math.floor(SEARCH_MAX_FILE_BYTES / 4) + 1));
  const oversized = await runAction(
    { op: "search", path: "many-hits.txt", pattern: "hit", maxResults: 1 },
    root
  );
  assert.equal(oversized.ok, true);
  assert.match(oversized.text, /跳过 1 个超大\/不可读文件/);
  assert.doesNotMatch(oversized.text, /many-hits\.txt:\d+:/);
});

test("search: 目录递归跳过 node_modules，include 过滤文件名", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "pkg", "i.js"), "emit hidden;\n");
  await fs.writeFile(path.join(root, "src", "a.ts"), "emit here;\n");
  await fs.writeFile(path.join(root, "src", "b.js"), "emit there;\n");

  const all = await runAction({ op: "search", path: ".", pattern: "emit" }, root);
  assert.match(all.text, /src\/a\.ts:1/);
  assert.match(all.text, /src\/b\.js:1/);
  assert.ok(!all.text.includes("hidden"), "不应搜到 node_modules");
  assert.match(all.text, /共搜索 \d+ 个文件/);

  const tsOnly = await runAction(
    { op: "search", path: "src", pattern: "emit", include: "*.ts" },
    root
  );
  assert.match(tsOnly.text, /a\.ts:1/);
  assert.ok(!tsOnly.text.includes("b.js"));
});

test("search: regex 模式与非法正则", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "a.js"), "foo(1);\nfoo2(2);\n");
  const re = await runAction({ op: "search", path: ".", pattern: "foo\\(", regex: true }, root);
  assert.match(re.text, /a\.js:1: /);
  const bad = await runAction({ op: "search", path: ".", pattern: "((", regex: true }, root);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "bad-regex");
});

test("search: maxResults 截断提示与 (missing)", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "a.js"), "hit\nhit\nhit\n");
  const r = await runAction({ op: "search", path: ".", pattern: "hit", maxResults: 2 }, root);
  assert.match(r.text, /截断于 2 处命中/);
  const miss = await runAction({ op: "search", path: "ghost", pattern: "x" }, root);
  assert.equal(miss.text, "(missing)");
  const noPattern = await runAction({ op: "search", path: ".", pattern: "" }, root);
  assert.equal(noPattern.error, "bad-pattern");
});

test("search: context 上下文行且相邻命中合并", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "a.js"), ["l1", "l2", "HIT", "l4", "HIT", "l6"].join("\n"));
  const r = await runAction({ op: "search", path: "a.js", pattern: "HIT", context: 1 }, root);
  const lines = r.text.split("\n");
  // 两处命中各带前后 1 行，中间重叠合并——应为第 2~6 行共 5 行
  assert.deepEqual(
    lines.map((l) => l.split(":")[1]),
    ["2", "3", "4", "5", "6"]
  );
});

test("search→read 组合：命中行号直接作为 read line 参数", async () => {
  const root = await makeRoot();
  const body =
    Array.from({ length: 150 }, (_, i) => `// filler ${i + 1}`).join("\n") +
    "\nfunction uniqueHandler() {}\n";
  await fs.writeFile(path.join(root, "src", "w.js"), body);
  const s = await runAction({ op: "search", path: ".", pattern: "uniqueHandler" }, root);
  const lineNo = Number(s.text.match(/src\/w\.js:(\d+):/)[1]);
  const r = await runAction({ op: "read", path: "src/w.js", line: lineNo, lines: 1 }, root);
  assert.match(r.text, new RegExp(`^${lineNo}: function uniqueHandler`, "m"));
});

test("read: 行号模式——编号前缀、末尾提示与越界报错", async () => {
  const root = await makeRoot();
  const body = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n");
  await fs.writeFile(path.join(root, "l.txt"), body + "\n");
  const r = await runAction({ op: "read", path: "l.txt", line: 98, lines: 5 }, root);
  assert.match(r.text, /^98: line-98$/m);
  assert.match(r.text, /^100: line-100$/m);
  assert.match(r.text, /已到文件末尾，共 100 行/);

  const over = await runAction({ op: "read", path: "l.txt", line: 101 }, root);
  assert.equal(over.ok, false);
  assert.equal(over.error, "out-of-range");
  assert.match(over.text, /文件共 100 行/);

  await fs.writeFile(path.join(root, "empty.txt"), "");
  const empty = await runAction({ op: "read", path: "empty.txt", line: 1 }, root);
  assert.match(empty.text, /文件共 0 行/);
});

test("ls: 递归跳过 node_modules/.git 等依赖目录，但保留目录名本身", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x");
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "config"), "x");

  const r = await runAction({ op: "ls", path: ".", recursive: true }, root);
  const lines = r.text.split("\n");
  assert.ok(lines.includes("node_modules/"), "依赖目录名应出现在清单里");
  assert.ok(!lines.includes("node_modules/pkg/"), "不应下钻 node_modules");
  assert.ok(!lines.includes("node_modules/pkg/index.js"));
  assert.ok(!lines.includes(".git/config"), "不应下钻 .git");
  assert.ok(lines.includes("src/app.js"), "项目自己的文件应完整保留");

  // 单层 ls 不受影响：显式列一层是刻意行为
  const flat = await runAction({ op: "ls", path: "node_modules" }, root);
  assert.ok(flat.text.includes("pkg/"));

  // 显式 read 依赖文件仍然允许（模型点名要看时）
  const read = await runAction({ op: "read", path: "node_modules/pkg/index.js" }, root);
  assert.equal(read.ok, true);
});

test("ls: 条目封顶并注明截断", async () => {
  const root = await makeRoot();
  await Promise.all(
    Array.from({ length: LS_MAX_ENTRIES + 10 }, (_, i) =>
      fs.writeFile(path.join(root, `f${String(i).padStart(4, "0")}.txt`), "x")
    )
  );
  const r = await runAction({ op: "ls", path: "." }, root);
  assert.ok(r.text.includes("truncated at"));
});

test("run: node 脚本正常执行，捕获输出与 exit code", async () => {
  const root = await makeRoot();
  const ok = await runAction({ op: "run", path: "src/app.js" }, root);
  assert.equal(ok.ok, true);
  assert.equal(ok.exit, 0);
  assert.match(ok.text, /hello from app/);

  const fail = await runAction({ op: "run", path: "src/boom.js" }, root);
  assert.equal(fail.ok, false);
  assert.equal(fail.exit, 3);
  assert.match(fail.text, /out/);
});

test("run: args 透传、cwd=root", async () => {
  const root = await makeRoot();
  await fs.writeFile(
    path.join(root, "args.js"),
    "import path from 'node:path';\n" +
      "process.stdout.write(JSON.stringify({argv: process.argv.slice(2), cwd: path.basename(process.cwd())}));\n"
  );
  const r = await runAction({ op: "run", path: "args.js", args: ["a", "b"] }, root);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.text);
  assert.deepEqual(parsed.argv, ["a", "b"]);
  assert.equal(parsed.cwd, path.basename(root));
});

test("run: 拒绝不支持的扩展名与越界路径", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "page.html"), "<html></html>");
  const html = await runAction({ op: "run", path: "page.html" }, root);
  assert.equal(html.ok, false);
  assert.equal(html.error, "cannot-execute");

  const esc = await runAction({ op: "run", path: "../outside.js" }, root);
  assert.equal(esc.ok, false);
  assert.equal(esc.error, "host-path");
});

test("run: 超时终止并返回部分输出", async () => {
  const root = await makeRoot();
  await fs.writeFile(
    path.join(root, "slow.js"),
    "process.stdout.write('started');\nsetInterval(() => {}, 1000);\n"
  );
  const t0 = Date.now();
  const r = await runAction({ op: "run", path: "slow.js", timeoutMs: 800 }, root);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout");
  assert.match(r.text, /超时/);
  assert.match(r.text, /started/);
  assert.ok(elapsed < 10000, `应在超时后很快返回，实际 ${elapsed}ms`);
});

test("run: 超时会终止测试脚本派生的子进程", async () => {
  const root = await makeRoot();
  const marker = path.join(root, "orphan-marker.txt");
  await fs.writeFile(
    path.join(root, "orphan-child.js"),
    "import fs from 'node:fs';\n" +
      "const marker = process.argv[2];\n" +
      "setTimeout(() => fs.writeFileSync(marker, 'orphan'), 1500);\n"
  );
  await fs.writeFile(
    path.join(root, "orphan-parent.js"),
    "import { spawn } from 'node:child_process';\n" +
      "import process from 'node:process';\n" +
      "const child = spawn(process.execPath, ['orphan-child.js', process.argv[2]], { cwd: process.cwd(), detached: process.platform === 'win32', stdio: 'ignore' });\n" +
      "child.unref();\n" +
      "console.log('child-started');\n" +
      "setInterval(() => {}, 1000);\n"
  );

  const result = await runAction(
    { op: "run", path: "orphan-parent.js", args: [marker], timeoutMs: 800 },
    root
  );
  assert.equal(result.error, "timeout");
  assert.match(result.text, /child-started/);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

test("未知 op 与缺 path 被拒", async () => {
  const root = await makeRoot();
  assert.equal((await runAction({ op: "write", path: "x.txt", content: "hi" }, root)).error, "unknown-op");
  assert.equal((await runAction({ op: "read" }, root)).error, "bad-path");
  assert.equal((await runAction(null, root)).ok, false);
});

test("read: 行号模式输出受总字符上限约束，续读行号衔接", async () => {
  const root = await makeRoot();
  const body = Array.from({ length: 300 }, (_, i) => `row-${i + 1}: ${"x".repeat(100)}`).join("\n");
  await fs.writeFile(path.join(root, "big.txt"), body);
  const r = await runAction({ op: "read", path: "big.txt", line: 1, lines: 300 }, root);
  assert.equal(r.ok, true);
  assert.ok(
    r.text.length <= READ_MAX_CHARS + 500,
    `输出应受总字符上限约束，实际 ${r.text.length}`
  );
  assert.match(r.text, /字符上限/);
  const next = Number(r.text.match(/"line":(\d+)/)[1]);
  assert.ok(next > 1 && next <= 300, `续读行号应在窗口内：${next}`);
  const r2 = await runAction({ op: "read", path: "big.txt", line: next, lines: 5 }, root);
  assert.match(r2.text, new RegExp(`^${next}: row-${next}: `, "m"), "续读应从上次停的行开始");
});

test("read: 超长单行内存有界——只保留前缀且行数精确", async () => {
  const root = await makeRoot();
  const huge = "A".repeat(2 * 1024 * 1024);
  await fs.writeFile(path.join(root, "huge.txt"), `${huge}\nsecond line\n`);
  const r = await runAction({ op: "read", path: "huge.txt", line: 1, lines: 1 }, root);
  assert.equal(r.ok, true);
  assert.match(r.text, /^1: A{500}/m, "超长行只返回前 500 字符");
  assert.equal(r.totalLines, 2, "超长行不应破坏总行数统计");
  const r2 = await runAction({ op: "read", path: "huge.txt", line: 2, lines: 1 }, root);
  assert.match(r2.text, /^2: second line$/m);
  const over = await runAction({ op: "read", path: "huge.txt", line: 3 }, root);
  assert.match(over.text, /文件共 2 行/);
});

test("read: CRLF 超长行 + 无末尾换行时行数与内容正确", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "crlf.txt"), `B${"x".repeat(600)}\r\nlast no newline`);
  const r = await runAction({ op: "read", path: "crlf.txt", line: 2, lines: 5 }, root);
  assert.match(r.text, /^2: last no newline$/m);
  assert.match(r.text, /已到文件末尾，共 2 行/);
  assert.ok(!r.text.includes("xxxx"), "超长首行不应泄漏到第 2 行的结果");
});

test("search: 目录扫描达到文件上限时，明确提示结果可能不完整", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, "bulk"), { recursive: true });
  // 2050 个文件：只有第 2050 个（超出 2000 上限）含 pattern
  const writes = [];
  for (let i = 0; i < 2050; i++) {
    const content = i === 2049 ? "needle here\n" : "filler\n";
    writes.push(fs.writeFile(path.join(root, "bulk", `f${String(i).padStart(5, "0")}.txt`), content));
    if (writes.length >= 200) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);

  const r = await runAction({ op: "search", path: ".", pattern: "needle" }, root);
  assert.equal(r.ok, true);
  assert.match(
    r.text,
    /文件上限|未参与搜索|可能不完整/,
    "达到扫描上限时必须提示结果可能不完整，避免误判为完整无命中"
  );
  assert.ok(!r.text.includes("needle"), "超出上限的文件不应参与搜索");
}, 30000);

test("search: 总文件数恰好等于上限时不误报文件上限提示", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, "bulk"), { recursive: true });
  const writes = [];
  // makeRoot 自带 4 个文件：bulk 放 1996 个，总计恰好 2000 = 上限，不应报截断
  for (let i = 0; i < 1996; i++) {
    const content = i === 4 ? "needle here\n" : "filler\n";
    writes.push(fs.writeFile(path.join(root, "bulk", `g${String(i).padStart(5, "0")}.txt`), content));
    if (writes.length >= 200) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);

  const r = await runAction({ op: "search", path: ".", pattern: "needle" }, root);
  assert.equal(r.ok, true);
  assert.match(r.text, /bulk\/g00004\.txt:1: needle here/);
  assert.match(r.text, /共搜索 2000 个文件/);
  assert.ok(!r.text.includes("文件上限"), "恰好达到上限且扫完时不应出现提示");
}, 30000);

test("read: 行号模式跨块总行数精确（评审 P26 复现样本）", async () => {
  const root = await makeRoot();
  const big = "L".repeat(70000);
  await fs.writeFile(path.join(root, "x.txt"), `first\n${big}\nthird\n`);
  const r = await runAction({ op: "read", path: "x.txt", line: 1, lines: 1 }, root);
  assert.equal(r.totalLines, 3, `跨块后总行数应精确为 3，实际 ${r.totalLines}`);
  assert.match(r.text, /^1: first$/m);
});

test("read: 行号模式单行输出恰为 500 字符上限（评审 P26-2）", async () => {
  const root = await makeRoot();
  await fs.writeFile(path.join(root, "long.txt"), "A".repeat(2000) + "\n");
  const r = await runAction({ op: "read", path: "long.txt", line: 1, lines: 1 }, root);
  const line = r.text.split("\n")[0];
  assert.equal(line, `1: ${"A".repeat(500)}`, "单行输出应恰好保留 500 字符正文");
});

test("search: include 在收集阶段过滤，匹配文件不受 2000 扫描上限挤压（评审 P27）", async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, "bulk"), { recursive: true });
  const writes = [];
  // 前 2000 个为 .js（占满旧上限），目标 .md 排在第 2001 个
  for (let i = 0; i < 2000; i++) {
    writes.push(fs.writeFile(path.join(root, "bulk", `j${String(i).padStart(5, "0")}.js`), "filler\n"));
    if (writes.length >= 200) { await Promise.all(writes); writes.length = 0; }
  }
  writes.push(fs.writeFile(path.join(root, "bulk", "target.md"), "needle here\n"));
  await Promise.all(writes);

  const r = await runAction(
    { op: "search", path: ".", pattern: "needle", include: "*.md" },
    root
  );
  assert.equal(r.ok, true);
  assert.match(r.text, /bulk\/target\.md:1: needle here/, "include 应让匹配文件不被扫描上限挤出");
  assert.ok(!r.text.includes("文件上限"), "匹配文件未超上限时不应提示截断");
}, 30000);
