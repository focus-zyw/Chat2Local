import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { positiveNumberArg, rootDirArg, siteIdArg, askTaskArg, roleIdArg } from "../src/cli.mjs";

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
