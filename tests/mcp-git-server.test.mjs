import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createMcpClient } from "../src/mcp-client.mjs";

const execFileAsync = promisify(execFile);
const SERVER = fileURLToPath(new URL("../demo/mcp-git-server.mjs", import.meta.url));

async function gitIn(dir, ...args) {
  await execFileAsync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

async function makeFixtureRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-git-fixture-"));
  await gitIn(dir, "init");
  await gitIn(dir, "config", "user.email", "fixture@example.com");
  await gitIn(dir, "config", "user.name", "Fixture");
  await fs.writeFile(path.join(dir, "a.txt"), "line1\nline2\n", "utf8");
  await gitIn(dir, "add", "a.txt");
  await gitIn(dir, "commit", "-m", "init: a");
  // 已暂存的新文件 + 未暂存的修改：status 与两个 diff 各有真实内容
  await fs.writeFile(path.join(dir, "b.txt"), "staged content\n", "utf8");
  await gitIn(dir, "add", "b.txt");
  await fs.writeFile(path.join(dir, "a.txt"), "line1\nline2\nmodified tail\n", "utf8");
  return dir;
}

test("mcp-git-server：四个只读工具经真实常驻 client 全链路可用", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    client = await createMcpClient(
      { command: process.execPath, args: [SERVER, repo] },
      { startupTimeoutMs: 20000 }
    );

    const listed = await client.listTools({ timeoutMs: 10000 });
    assert.equal(listed.ok, true, listed.text);
    assert.deepEqual(
      listed.tools.map((t) => t.name),
      ["git_status", "git_diff_unstaged", "git_diff_staged", "git_log"]
    );

    const status = await client.callTool("git_status", {}, { timeoutMs: 10000 });
    assert.equal(status.ok, true, status.text);
    assert.ok(status.text.includes("## "), `status 缺分支行：${status.text}`);
    assert.ok(status.text.includes("M a.txt"), `status 缺未暂存修改：${status.text}`);
    assert.ok(status.text.includes("b.txt"), `status 缺已暂存文件：${status.text}`);

    const unstaged = await client.callTool("git_diff_unstaged", {}, { timeoutMs: 10000 });
    assert.equal(unstaged.ok, true, unstaged.text);
    assert.ok(unstaged.text.includes("+modified tail"), `unstaged diff 缺修改行：${unstaged.text}`);

    const staged = await client.callTool("git_diff_staged", {}, { timeoutMs: 10000 });
    assert.equal(staged.ok, true, staged.text);
    assert.ok(staged.text.includes("+staged content"), `staged diff 缺新增行：${staged.text}`);
    assert.doesNotMatch(staged.text, /已隐藏/);

    const log = await client.callTool("git_log", { max: 5 }, { timeoutMs: 10000 });
    assert.equal(log.ok, true, log.text);
    assert.ok(log.text.includes("init: a"), `log 缺提交摘要：${log.text}`);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("mcp-git-server：参数只认数字，模型字符串不进 argv，作用域不可经参数切换", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    client = await createMcpClient(
      { command: process.execPath, args: [SERVER, repo] },
      { startupTimeoutMs: 20000 }
    );
    const poisoned = await client.callTool(
      "git_log",
      { max: "3; rm -rf /", skip: null, repo_path: "C:/Windows", extra: { evil: true } },
      { timeoutMs: 10000 }
    );
    assert.equal(poisoned.ok, true, poisoned.text);
    assert.ok(poisoned.text.includes("init: a"), `未知/恶意参数不得改变结果：${poisoned.text}`);

    const unknown = await client.callTool("git_commit", { message: "hack" }, { timeoutMs: 10000 });
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /未知工具|拒绝/, `写操作必须被拒：${unknown.text}`);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("mcp-git-server：超大输出按上限截断并提示", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    client = await createMcpClient(
      { command: process.execPath, args: [SERVER, repo] },
      { startupTimeoutMs: 20000 }
    );
    await fs.appendFile(path.join(repo, "a.txt"), "x".repeat(30000), "utf8");
    const huge = await client.callTool("git_diff_unstaged", {}, { timeoutMs: 20000 });
    assert.equal(huge.ok, true, huge.text);
    assert.ok(huge.text.includes("已截断"), `缺截断提示：${huge.text.slice(-200)}`);
    assert.ok(huge.text.length <= 7400, `截断后仍超限：${huge.text.length}`);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("mcp-git-server：非 git 目录启动即退出，握手按探测失败处理", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-git-empty-"));
  try {
    await assert.rejects(
      createMcpClient({ command: process.execPath, args: [SERVER, dir] }, { startupTimeoutMs: 20000 })
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("mcp-git-server：敏感文件的暂存和未暂存补丁均不回填", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    await fs.writeFile(path.join(repo, ".env"), "API_TOKEN=synthetic-old\n");
    await gitIn(repo, "add", ".env");
    await gitIn(repo, "commit", "-m", "fixture secret");
    await fs.writeFile(path.join(repo, ".env"), "API_TOKEN=synthetic-staged\n");
    await gitIn(repo, "add", ".env");
    await fs.writeFile(path.join(repo, ".env"), "API_TOKEN=synthetic-unstaged\n");
    client = await createMcpClient({ command: process.execPath, args: [SERVER, repo] });
    for (const name of ["git_status", "git_diff_staged", "git_diff_unstaged"]) {
      const result = await client.callTool(name, {}, { timeoutMs: 10000 });
      assert.equal(result.ok, true, result.text);
      assert.doesNotMatch(result.text, /\.env|synthetic-(old|staged|unstaged)/);
    }
    const allowed = await client.callTool("git_diff_unstaged", {}, { timeoutMs: 10000 });
    assert.match(allowed.text, /modified tail/);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("mcp-git-server：仓库 Git 扩展不执行，status 不改写索引", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    const marker = path.join(repo, "extension-ran.txt");
    const helper = path.join(repo, "extension.mjs");
    await fs.writeFile(helper, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdout.write("1\\n");`);
    await gitIn(repo, "config", "diff.external", `"${process.execPath}" "${helper}"`);
    await gitIn(repo, "config", "core.fsmonitor", `"${process.execPath}" "${helper}"`);
    const indexBefore = await fs.readFile(path.join(repo, ".git", "index"));
    client = await createMcpClient({ command: process.execPath, args: [SERVER, repo] });
    for (const name of ["git_status", "git_diff_unstaged", "git_diff_staged"]) {
      const result = await client.callTool(name, {}, { timeoutMs: 10000 });
      assert.equal(result.ok, true, result.text);
      assert.doesNotMatch(result.text, /extension-ran|CUSTOM DIFF/);
    }
    assert.equal(await fs.stat(marker).then(() => true, () => false), false);
    assert.deepEqual(await fs.readFile(path.join(repo, ".git", "index")), indexBefore);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("mcp-git-server：敏感文件改名为普通文件后仍隐藏两端补丁", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    await fs.writeFile(path.join(repo, ".env"), "API_TOKEN=synthetic-renamed\n".repeat(20));
    await gitIn(repo, "add", ".env");
    await gitIn(repo, "commit", "-m", "fixture secret");
    await gitIn(repo, "mv", ".env", "public.txt");
    await fs.writeFile(path.join(repo, "safe.txt"), "visible staged content\n");
    await gitIn(repo, "add", "safe.txt");
    client = await createMcpClient({ command: process.execPath, args: [SERVER, repo] });
    const result = await client.callTool("git_diff_staged", {}, { timeoutMs: 10000 });
    assert.equal(result.ok, true, result.text);
    assert.doesNotMatch(result.text, /synthetic-renamed|\.env|public\.txt/);
    assert.match(result.text, /已隐藏/);
    assert.match(result.text, /staged content/);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("mcp-git-server：超过旧 4 MiB 缓冲的大 diff 仍截断回填", async () => {
  const repo = await makeFixtureRepo();
  let client;
  try {
    await fs.appendFile(path.join(repo, "a.txt"), "x".repeat(5 * 1024 * 1024));
    client = await createMcpClient({ command: process.execPath, args: [SERVER, repo] });
    const result = await client.callTool("git_diff_unstaged", {}, { timeoutMs: 30000 });
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /已截断/);
    assert.ok(result.text.length < 8000);
  } finally {
    await client?.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});
