import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createThreadStore } from "../src/state.mjs";

function makeStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-tool-threads-"));
  t.after(() => {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith("file-tool-threads-")) {
      throw new Error("临时登记目录校验失败，未清理");
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { dir, file: path.join(dir, "threads.json"), store: createThreadStore(path.join(dir, "threads.json")) };
}

test("threads: 保存/读取/清除 往返", (t) => {
  const { getThread, saveThread, clearThread } = makeStore(t).store;
  const url = "https://chat.deepseek.com/a/chat/s/test-1";
  saveThread("deepseek", "D:\\proj\\demo", url);
  const got = getThread("deepseek", "D:\\proj\\demo");
  assert.ok(got);
  assert.equal(got.url, url);
  assert.equal(got.site, "deepseek");

  assert.equal(clearThread("deepseek", "D:\\proj\\demo"), true);
  assert.equal(getThread("deepseek", "D:\\proj\\demo"), null);
  assert.equal(clearThread("deepseek", "D:\\proj\\demo"), false, "重复清除返回 false");
});

test("threads: root 大小写不敏感（Windows 路径）", (t) => {
  const { getThread, saveThread, clearThread } = makeStore(t).store;
  saveThread("deepseek", "D:\\proj\\Case-Test", "https://x/s/1");
  assert.ok(getThread("deepseek", "d:\\proj\\case-test"), "大小写不同应命中同一登记");
  clearThread("deepseek", "D:\\proj\\Case-Test");
});

test("threads: 不同站点/项目互不干扰", (t) => {
  const { getThread, saveThread, clearThread } = makeStore(t).store;
  saveThread("deepseek", "D:\\p\\a", "https://x/s/a");
  saveThread("chatgpt", "D:\\p\\a", "https://chatgpt/c/1");
  saveThread("deepseek", "D:\\p\\b", "https://x/s/b");
  assert.equal(getThread("deepseek", "D:\\p\\a").url, "https://x/s/a");
  assert.equal(getThread("chatgpt", "D:\\p\\a").url, "https://chatgpt/c/1");
  assert.equal(getThread("deepseek", "D:\\p\\b").url, "https://x/s/b");
  clearThread("deepseek", "D:\\p\\a");
  clearThread("chatgpt", "D:\\p\\a");
  clearThread("deepseek", "D:\\p\\b");
});

test("threads: 文本问答与旧代码导师登记隔离，旧键保持可读", (t) => {
  const { getThread, saveThread, clearThread } = makeStore(t).store;
  const root = "D:\\shared";
  saveThread("chatgpt", root, "https://chatgpt.com/c/code");
  assert.equal(getThread("chatgpt", root, "text"), null);
  saveThread("chatgpt", root, "https://chatgpt.com/c/text", "text");
  assert.equal(getThread("chatgpt", root).url, "https://chatgpt.com/c/code");
  assert.equal(getThread("chatgpt", root, "text").url, "https://chatgpt.com/c/text");
  clearThread("chatgpt", root, "text");
  assert.equal(getThread("chatgpt", root, "text"), null);
  assert.ok(getThread("chatgpt", root));
});

test("threads: 损坏的登记文件阻止读取和覆写", (t) => {
  const { file, store } = makeStore(t);
  const original = "{不完整的 JSON";
  fs.writeFileSync(file, original);
  assert.throws(() => store.getThread("deepseek", "D:\\p"), /登记文件格式错误/);
  assert.throws(() => store.saveThread("deepseek", "D:\\p", "https://chat.deepseek.com/a/chat/s/new"), /登记文件格式错误/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("threads: 旧版登记格式可直接读取并续写", (t) => {
  const { file, store } = makeStore(t);
  const root = "D:\\existing-project";
  const url = "https://chat.deepseek.com/a/chat/s/legacy";
  const key = `deepseek|${path.resolve(root).toLowerCase()}`;
  fs.writeFileSync(file, JSON.stringify({ [key]: { url, site: "deepseek", root, updatedAt: 1 } }));
  assert.equal(store.getThread("deepseek", root).url, url);
  store.saveThread("chatgpt", root, "https://chatgpt.com/c/new");
  assert.equal(store.getThread("deepseek", root).url, url);
});

test("threads: 替换失败时旧登记不变且临时文件被清理", (t) => {
  const { dir, file, store } = makeStore(t);
  const root = "D:\\p";
  store.saveThread("deepseek", root, "https://chat.deepseek.com/a/chat/s/old");
  const original = fs.readFileSync(file, "utf8");
  const failingIo = Object.create(fs);
  failingIo.renameSync = () => { throw new Error("模拟替换失败"); };
  const failingStore = createThreadStore(file, failingIo);
  assert.throws(() => failingStore.saveThread("deepseek", root, "https://chat.deepseek.com/a/chat/s/new"), /模拟替换失败/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(fs.readdirSync(dir), ["threads.json"]);
});
