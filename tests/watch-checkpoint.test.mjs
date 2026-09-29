import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWatchCheckpointStore, replyFingerprint, assertOtherRoleClear } from "../src/watch-checkpoint.mjs";

test("watch 断点：仅保存阶段和回复指纹，不保存正文或动作参数", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-tool-checkpoint-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "watch.json");
  const store = createWatchCheckpointStore(file);
  const url = "https://chat.deepseek.com/a/chat/s/test-thread";
  const handle = store.forThread("deepseek", dir, url);
  const replyId = replyFingerprint({ count: 3, text: "测试私密回复" });
  handle.write({ phase: "executing", replyId, actionIndex: 1, actionCount: 2 });
  assert.equal(handle.read().phase, "executing");
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /测试私密回复|test-thread/);
  assert.match(raw, /executing/);
  assert.equal(store.forThread("deepseek", dir, "https://chat.deepseek.com/other").read().phase, "mismatch-pending");
  handle.acknowledge();
  assert.equal(handle.read().phase, "processed");
});

test("watch 断点：损坏文件不视为空状态，也不被后续写入覆盖", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-tool-checkpoint-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "watch.json");
  fs.writeFileSync(file, "broken-json");
  const handle = createWatchCheckpointStore(file).forThread("deepseek", dir, "https://chat.deepseek.com/a/chat/s/x");
  assert.throws(() => handle.read(), /断点/);
  assert.throws(() => handle.write({ phase: "processed", replyId: "a".repeat(64) }), /断点/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken-json");
});

test("watch 断点：文本问答与代码导师独立，旧断点仍按默认角色读取", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-tool-checkpoint-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = createWatchCheckpointStore(path.join(dir, "watch.json"));
  const url = "https://chatgpt.com/c/shared";
  const code = store.forThread("chatgpt", dir, url);
  const text = store.forThread("chatgpt", dir, url, "text");
  code.write({ phase: "executing", replyId: "a".repeat(64), actionCount: 1 });
  assert.equal(text.read(), null);
  text.write({ phase: "processed", replyId: "b".repeat(64), actionCount: 1 });
  assert.equal(code.read().phase, "executing");
  assert.equal(text.read().phase, "processed");
});

test("watch 断点：另一角色未确认时不能切换角色绕过核对", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-tool-checkpoint-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = createWatchCheckpointStore(path.join(dir, "watch.json"));
  const code = store.forThread("chatgpt", dir, "https://chatgpt.com/c/code", "code");
  code.write({ phase: "delivering", replyId: "a".repeat(64), actionCount: 1 });
  assert.throws(() => assertOtherRoleClear(store, "chatgpt", dir, "text"), /另一任务角色.*未确认/);
  code.acknowledge();
  assert.doesNotThrow(() => assertOtherRoleClear(store, "chatgpt", dir, "text"));
});

test("watch 断点：目录同步状态不明需原聊天人工确认", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "file-tool-checkpoint-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = createWatchCheckpointStore(path.join(dir, "watch.json"));
  const handle = store.forThread("deepseek", dir, "https://chat.deepseek.com/a/chat/s/original");
  handle.write({ phase: "catalog-sync", replyId: "a".repeat(64) });
  assert.equal(handle.read().phase, "catalog-sync");
  assert.equal(store.forThread("deepseek", dir, "https://chat.deepseek.com/a/chat/s/other").read().phase, "mismatch-pending");
  assert.equal(handle.acknowledge(), true);
  assert.equal(handle.read().phase, "processed");
});
