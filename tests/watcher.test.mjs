import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReplyTracker, startWatcher } from "../src/watcher.mjs";
import { createWatchCheckpointStore } from "../src/watch-checkpoint.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("watcher: 诊断流水只记录状态，不保存网页回复正文", async () => {
  const privateReply = "仅用于测试的私密回复-不要写入诊断流水";
  const traces = [];
  let snapshots = 0;
  const stop = await startWatcher({
    driver: { async snapshot() { return { busy: false, text: snapshots++ ? "x".repeat(privateReply.length) : privateReply }; } },
    root: os.tmpdir(),
    traceSink: (line) => traces.push(line),
    intervalMs: 5,
    stableMs: 1000,
  });
  await sleep(30);
  await stop();
  assert.ok(traces.length >= 2, "同长度的回复变化也应被诊断流水记录");
  assert.match(traces[0], /busy=0 chars=\d+/);
  assert.ok(traces.every((line) => line.includes("changed=1")));
  assert.doesNotMatch(traces.join("\n"), /仅用于测试的私密回复/);
});

test("tracker: 文本不变且非 busy 满 stableMs 才算稳定；变化即重置", () => {
  let t = 1000;
  const now = () => t;
  const tracker = createReplyTracker({ stableMs: 3000, now });
  assert.equal(tracker.observe("a", false).stable, false);
  t += 1000;
  assert.equal(tracker.observe("a", false).stable, false);
  t += 2500; // 距上次变化 3500ms
  assert.equal(tracker.observe("a", false).stable, true);
  // busy 时不算稳定
  t += 3000;
  assert.equal(tracker.observe("a", true).stable, false);
  // 文本变化重新计时
  assert.equal(tracker.observe("ab", false).stable, false);
  t += 4000;
  assert.equal(tracker.observe("ab", false).stable, true);
});

test("tracker: 空文本永不稳定", () => {
  let t = 1000;
  const tracker = createReplyTracker({ stableMs: 1, now: () => t });
  t += 5000;
  assert.equal(tracker.observe("", false).stable, false);
});

test("watcher: 动作→执行→回填；纯讲解只通知不回填", async () => {
  const snapshots = [
    { busy: false, text: '我先看看。\n```host\n[{"op":"ls","path":"src"}]\n```' },
    { busy: false, text: "讲解：入口在 src/index.js。" },
  ];
  const delivered = [];
  const replies = [];
  const executed = [];
  const driver = {
    async snapshot() {
      // 回填完成后才换讲解回复，避免并行浏览器测试抢占时间片时跳过动作。
      return delivered.length ? snapshots[1] : snapshots[0];
    },
    async deliver(text) {
      delivered.push(text);
      return { ok: true };
    },
  };
  const stop = await startWatcher({
    driver,
    root: os.tmpdir(),
    execAction: async (a) => {
      executed.push(a.path);
      return { ok: true, text: "x" };
    },
    intervalMs: 5,
    stableMs: 1,
    log: () => {},
    onReply: (t) => replies.push(t),
  });
  for (let i = 0; i < 100 && (!delivered.length || !replies.length); i++) await sleep(10);
  await stop();
  await sleep(10);

  assert.equal(executed.length, 1);
  assert.equal(executed[0], "src");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /file-tool 自动回填/);
  assert.match(delivered[0], /\[1\] ls src → ok/);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /入口在/);
});

test("watcher: 文本角色回填要求引用来源，不要求教学反问", async () => {
  const delivered = [];
  const stop = await startWatcher({
    driver: {
      async snapshot() { return { busy: false, text: '```host\n[{"op":"read","path":"notes/guide.md","line":1}]\n```' }; },
      async deliver(payload) { delivered.push(payload); return { ok: true }; },
    },
    root: os.tmpdir(),
    role: "text",
    execAction: async () => ({ ok: true, text: "1: 审批时限：3天。" }),
    intervalMs: 5,
    stableMs: 1,
  });
  for (let i = 0; i < 100 && !delivered.length; i++) await sleep(10);
  await stop();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /引用相对路径和行号/);
  assert.doesNotMatch(delivered[0], /教学互动|反问/);
});

test("watcher: stop() 后停止轮询（进程可正常退出）", async () => {
  let snaps = 0;
  const driver = {
    async snapshot() {
      snaps++;
      return { busy: false, text: "" };
    },
    async deliver() {
      return { ok: true };
    },
  };
  const stop = await startWatcher({
    driver,
    root: os.tmpdir(),
    intervalMs: 5,
    stableMs: 1,
    log: () => {},
  });
  await sleep(60);
  await stop();
  const atStop = snaps;
  await sleep(60);
  assert.ok(snaps - atStop <= 2, `stop() 后应几乎不再轮询，实际又轮询了 ${snaps - atStop} 次`);
});

test("watcher: 同一条回复不重复处理", async () => {
  let executed = 0;
  const driver = {
    async snapshot() {
      return { busy: false, text: '```host\n[{"op":"ls","path":"."}]\n```' };
    },
    async deliver() {
      return { ok: true };
    },
  };
  const stop = await startWatcher({
    driver,
    root: os.tmpdir(),
    execAction: async () => {
      executed++;
      return { ok: true, text: "x" };
    },
    intervalMs: 5,
    stableMs: 1,
    log: () => {},
  });
  await sleep(120);
  await stop();
  await sleep(10);
  assert.equal(executed, 1, "同一文本应只执行一次");
});

test("watcher: 动作执行失败也照常回填（错误信息让导师自纠错）", async () => {
  const delivered = [];
  const driver = {
    async snapshot() {
      return { busy: false, text: '```host\n[{"op":"read","path":"../escape.txt"}]\n```' };
    },
    async deliver(text) {
      delivered.push(text);
      return { ok: true };
    },
  };
  const stop = await startWatcher({
    driver,
    root: os.tmpdir(),
    execAction: async () => ({ ok: false, error: "host-path", text: "路径越界" }),
    intervalMs: 5,
    stableMs: 1,
    log: () => {},
  });
  await sleep(120);
  await stop();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /失败\(host-path\)/);
});

test("watcher: 回填瞬时失败会重试，但本地动作只执行一次", async () => {
  let executed = 0;
  const delivered = [];
  const driver = {
    async snapshot() {
      return { busy: false, text: '```host\n[{"op":"ls","path":"."}]\n```' };
    },
    async deliver(text) {
      delivered.push(text);
      return delivered.length === 1
        ? { ok: false, error: "composer-busy" }
        : { ok: true };
    },
  };
  const stop = await startWatcher({
    driver,
    root: os.tmpdir(),
    execAction: async () => {
      executed++;
      return { ok: true, text: "x" };
    },
    intervalMs: 5,
    stableMs: 1,
    feedRetryMs: 5,
    log: () => {},
  });
  await sleep(120);
  await stop();

  assert.equal(executed, 1, "回填重试不能重复执行本地动作");
  assert.equal(delivered.length, 2, "首次回填失败后应自动重试");
  assert.equal(delivered[0], delivered[1], "重试必须发送同一份动作结果");
});

test("watcher: 重启后已回填的网页动作不会再执行", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-restart-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createWatchCheckpointStore(path.join(dir, "checkpoint.json"));
  const checkpoint = store.forThread("deepseek", dir, "https://chat.deepseek.com/a/chat/s/old");
  const driver = {
    async snapshot() { return { count: 1, busy: false, text: '```host\n[{"op":"run","path":"test.js"}]\n```' }; },
    async deliver() { return { ok: true }; },
  };
  let executed = 0;
  const options = {
    driver, root: dir, checkpoint, intervalMs: 5, stableMs: 1,
    execAction: async () => { executed++; return { ok: true, text: "ok" }; },
  };
  const first = await startWatcher(options);
  await sleep(70);
  await first();
  assert.equal(executed, 1);
  assert.equal(checkpoint.read().phase, "processed");
  const second = await startWatcher(options);
  await sleep(70);
  await second();
  assert.equal(executed, 1, "进程重启不能重复运行上一条动作");
});

test("watcher: 回填未确认时重启安全停住，人工确认后不重放 run", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-pending-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const checkpoint = createWatchCheckpointStore(path.join(dir, "checkpoint.json"))
    .forThread("deepseek", dir, "https://chat.deepseek.com/a/chat/s/old");
  let executed = 0;
  const driver = {
    async snapshot() { return { count: 1, busy: false, text: '```host\n[{"op":"run","path":"test.js"}]\n```' }; },
    async deliver() { return { ok: false, error: "temporary" }; },
  };
  const options = {
    driver, root: dir, checkpoint, intervalMs: 5, stableMs: 1, feedRetryMs: 10000,
    execAction: async () => { executed++; return { ok: true, text: "ok" }; },
  };
  const first = await startWatcher(options);
  await sleep(70);
  await first();
  assert.equal(executed, 1);
  assert.equal(checkpoint.read().phase, "delivering");
  await assert.rejects(startWatcher(options), /核对/);
  checkpoint.acknowledge();
  const second = await startWatcher(options);
  await sleep(70);
  await second();
  assert.equal(executed, 1);
});

test("watcher: 回填异常无法证明未发送时停止，不自动重复发送", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-unknown-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const checkpoint = createWatchCheckpointStore(path.join(dir, "checkpoint.json"))
    .forThread("deepseek", dir, "https://chat.deepseek.com/a/chat/s/old");
  let sent = 0;
  let executed = 0;
  let fatal = "";
  const stop = await startWatcher({
    driver: {
      async snapshot() { return { busy: false, text: '```host\n[{"op":"run","path":"test.js"}]\n```' }; },
      async deliver() { sent++; throw new Error("发送结果未知"); },
    },
    root: dir, checkpoint, intervalMs: 5, stableMs: 1, feedRetryMs: 5,
    execAction: async () => { executed++; return { ok: true, text: "ok" }; },
    onFatal: (message) => { fatal = message; },
  });
  await sleep(80);
  await stop();
  assert.equal(executed, 1);
  assert.equal(sent, 1);
  assert.equal(checkpoint.read().phase, "delivering");
  assert.match(fatal, /不确定/);
});

test("watcher: 断点写入失败时不得先执行动作", async () => {
  let executed = 0;
  let fatal = "";
  const stop = await startWatcher({
    driver: {
      async snapshot() { return { busy: false, text: '```host\n[{"op":"run","path":"test.js"}]\n```' }; },
      async deliver() { return { ok: true }; },
    },
    root: os.tmpdir(), intervalMs: 5, stableMs: 1,
    checkpoint: { read() { return null; }, write() { throw new Error("磁盘不可写"); } },
    execAction: async () => { executed++; return { ok: true, text: "ok" }; },
    onFatal: (message) => { fatal = message; },
  });
  await sleep(50);
  await stop();
  assert.equal(executed, 0);
  assert.match(fatal, /断点保存失败/);
});

test("watcher: 暂停后不执行新动作，恢复时沿用原会话", async () => {
  let reply = '```host\n[{"op":"ls","path":"first"}]\n```';
  const executed = [];
  const driver = {
    async snapshot() { return { busy: false, text: reply }; },
    async deliver() { return { ok: true }; },
  };
  const stop = await startWatcher({
    driver, root: os.tmpdir(), intervalMs: 5, stableMs: 1,
    execAction: async (action) => {
      executed.push(action.path);
      return { ok: true, text: "ok" };
    },
  });
  await sleep(60);
  assert.deepEqual(executed, ["first"]);

  await stop.pause();
  reply = '```host\n[{"op":"ls","path":"second"}]\n```';
  await sleep(50);
  assert.deepEqual(executed, ["first"], "暂停期间不能执行网页新动作");

  stop.resume();
  await sleep(60);
  await stop();
  assert.deepEqual(executed, ["first", "second"]);
});

test("watcher: 暂停等待正在执行的动作与回填完成", async () => {
  let releaseAction;
  let startedAction;
  const actionStarted = new Promise((resolve) => { startedAction = resolve; });
  const actionGate = new Promise((resolve) => { releaseAction = resolve; });
  let delivered = 0;
  const driver = {
    async snapshot() { return { busy: false, text: '```host\n[{"op":"ls","path":"."}]\n```' }; },
    async deliver() { delivered++; return { ok: true }; },
  };
  const stop = await startWatcher({
    driver, root: os.tmpdir(), intervalMs: 5, stableMs: 1,
    execAction: async () => { startedAction(); await actionGate; return { ok: true, text: "ok" }; },
  });
  await actionStarted;
  let pauseFinished = false;
  const pause = stop.pause().then(() => { pauseFinished = true; });
  await sleep(15);
  assert.equal(pauseFinished, false, "当前动作未完成时不能显示已暂停");
  releaseAction();
  await pause;
  assert.equal(delivered, 1, "暂停前要完成本轮回填");
  await stop();
});

test("watcher: 暂停期间不重试回填，继续后复用原结果", async () => {
  let firstAttempt;
  const attempted = new Promise((resolve) => { firstAttempt = resolve; });
  const delivered = [];
  let executed = 0;
  const driver = {
    async snapshot() { return { busy: false, text: '```host\n[{"op":"ls","path":"."}]\n```' }; },
    async deliver(text) {
      delivered.push(text);
      if (delivered.length === 1) { firstAttempt(); return { ok: false, error: "暂时失败" }; }
      return { ok: true };
    },
  };
  const stop = await startWatcher({
    driver, root: os.tmpdir(), intervalMs: 5, stableMs: 1, feedRetryMs: 20,
    execAction: async () => { executed++; return { ok: true, text: "ok" }; },
  });
  await attempted;
  await stop.pause();
  await sleep(50);
  assert.equal(delivered.length, 1);
  stop.resume();
  await sleep(50);
  await stop();
  assert.equal(executed, 1);
  assert.deepEqual(delivered, [delivered[0], delivered[0]]);
});

test("watcher: 数组 read 动作保留 offset/length 并回填对应片段", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-offset-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "requests"), { recursive: true });
  const source = Array.from({ length: 500 }, (_, i) => String(i).padStart(4, "0")).join("");
  await fs.writeFile(path.join(root, "src", "requests", "sessions.py"), source);
  const delivered = [];
  const driver = {
    async snapshot() {
      return { busy: false, text: '[\n  {"op":"read","path":"src/requests/sessions.py","offset":120,"length":180}\n]' };
    },
    async deliver(text) {
      delivered.push(text);
      return { ok: true };
    },
  };
  const stop = await startWatcher({ driver, root, intervalMs: 5, stableMs: 1 });
  await sleep(100);
  await stop();
  assert.equal(delivered.length, 1);
  assert.ok(delivered[0].includes(source.slice(120, 300)));
  assert.ok(!delivered[0].includes(source.slice(0, 120)));
  assert.match(delivered[0], /\[1\] read src\/requests\/sessions\.py.*offset=120.*length=180/);
});

// ── waitForChange 事件驱动路径 ──

test("tracker: agedMs 校准——页面侧报告已稳定即可立即判定", () => {
  let t = 1000;
  const now = () => t;
  const tracker = createReplyTracker({ stableMs: 3000, now });
  // 文本刚被 Node 观察到，但页面侧报告它已存在 5s
  const r = tracker.observe("新回复", false, 5000);
  assert.equal(r.stable, true, "agedMs ≥ stableMs 应立即稳定");
  // 同一文本再次观察，取较早变化时间，仍稳定
  t += 100;
  assert.equal(tracker.observe("新回复", false, 6000).stable, true);
  // busy 依旧压制
  assert.equal(tracker.observe("新回复", true, 6000).stable, false);
});

test("watcher: waitForChange 路径——唤醒即处理，无需固定轮询", async () => {
  const states = [
    { busy: false, text: '我先看看。\n```host\n[{"op":"ls","path":"src"}]\n```' },
    { busy: false, text: "讲解：入口在 src/index.js。" },
  ];
  let stateIdx = 0;
  let waitCalls = 0;
  const delivered = [];
  const executed = [];
  const driver = {
    async snapshot() {
      const s = states[stateIdx];
      return { busy: s.busy, text: s.text, sig: "sig" + stateIdx };
    },
    async waitForChange(expected, { stableMs } = {}) {
      waitCalls++;
      const curSig = "sig" + stateIdx;
      if (curSig !== expected) {
        // 快照晚于页面变化：新文本已在页面上稳定了 stableMs
        return { woke: true, sig: curSig, changedAgoMs: stableMs };
      }
      if (stateIdx < states.length - 1) {
        // 模拟导师开始回复新内容：状态推进并立即唤醒（changedAt 重置）
        stateIdx++;
        return { woke: true, sig: "sig" + stateIdx, changedAgoMs: 0 };
      }
      // 状态没变：模拟浏览器内等待直到分片超时
      await sleep(5);
      return { woke: false, timeout: true };
    },
    async deliver(text) {
      delivered.push(text);
      return { ok: true };
    },
  };
  const stop = await startWatcher({
    driver,
    root: os.tmpdir(),
    execAction: async (a) => {
      executed.push(a.path);
      return { ok: true, text: "x" };
    },
    stableMs: 3000,
    intervalMs: 5,
    log: () => {},
    onReply: () => {},
  });
  await sleep(120);
  await stop();

  assert.equal(waitCalls > 0, true, "应走 waitForChange 而非固定轮询");
  assert.equal(executed.length, 1);
  assert.equal(executed[0], "src");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /file-tool 自动回填/);
});
