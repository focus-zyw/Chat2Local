import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { listDirectories, startControlServer } from "../src/control-server.mjs";
import { createThreadStore } from "../src/state.mjs";
import { createWatchCheckpointStore, replyFingerprint } from "../src/watch-checkpoint.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPhase(url, phase) {
  for (let i = 0; i < 60; i++) {
    const response = await fetch(`${url}api/status`);
    const status = await response.json();
    if (status.phase === phase) return status;
    await sleep(10);
  }
  throw new Error(`控制台未进入 ${phase}`);
}

test("本地控制台：校验来源和目录，启动、暂停、恢复、停止同一浏览器会话", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-console-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let launched = 0;
  let closed = 0;
  let paused = 0;
  let resumed = 0;
  let stopped = 0;
  let intro = "";
  const stopWatcherFn = async () => { stopped++; };
  stopWatcherFn.pause = async () => { paused++; };
  stopWatcherFn.resume = () => { resumed++; };
  const app = await startControlServer({
    saveThreadFn: () => {},
    launchBrowserFn: async () => {
      launched++;
      return { channel: "测试浏览器", context: { on() {}, async close() { closed++; } } };
    },
    createDriverFn: async () => ({
      async markTab() {},
      async send(text) { intro = text; return { ok: true, text: "已收到" }; },
      currentUrl() { return "https://chat.deepseek.com/a/chat/s/test-console"; },
    }),
    startWatcherFn: async () => stopWatcherFn,
  });
  t.after(() => app.close());
  const origin = app.url.slice(0, -1);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  assert.ok(bootstrap.token);
  assert.ok(bootstrap.sites.some((site) => site.id === "deepseek"));
  const post = (route, body, headers = {}) => fetch(`${app.url}api/${route}`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "X-File-Tool-Token": bootstrap.token, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post("start", { siteId: "deepseek", root }, { "X-File-Tool-Token": "bad" })).status, 403);
  assert.equal((await post("start", { siteId: "deepseek", root }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await post("start", { siteId: "deepseek", root: path.join(root, "missing") })).status, 400);
  assert.equal(launched, 0);

  assert.equal((await post("start", { siteId: "deepseek", root })).status, 202);
  const started = await waitPhase(app.url, "running");
  assert.ok(started.events.some((event) => event.text.includes("未找到所选网站和项目的历史聊天登记")));
  assert.equal(launched, 1);
  assert.match(intro, /取材料轮和教学互动轮二选一/);

  assert.equal((await post("pause", {})).status, 200);
  await waitPhase(app.url, "paused");
  assert.equal(paused, 1);
  assert.equal(closed, 0, "暂停不能关闭浏览器");

  assert.equal((await post("resume", {})).status, 200);
  await waitPhase(app.url, "running");
  assert.equal(resumed, 1);
  assert.equal(launched, 1, "恢复不能重启浏览器");

  assert.equal((await post("stop", {})).status, 200);
  await waitPhase(app.url, "idle");
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});

test("本地控制台：文本角色使用独立聊天，切回代码导师不续接文本线程", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-role-console-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createThreadStore(path.join(root, "threads.json"));
  const checkpointStore = createWatchCheckpointStore(path.join(root, "watch.json"));
  const opened = [];
  const sent = [];
  let launches = 0;
  const app = await startControlServer({
    getThreadFn: store.getThread,
    saveThreadFn: store.saveThread,
    checkpointStore,
    launchBrowserFn: async () => { launches++; return { channel: "测试浏览器", context: { on() {}, async close() {} } }; },
    createDriverFn: async ({ startUrl }) => {
      opened.push(startUrl);
      return {
        async markTab() {},
        async send(payload) { sent.push(payload); return { ok: true, text: "已收到" }; },
        currentUrl() { return `https://chatgpt.com/c/role-${opened.length}`; },
      };
    },
    startWatcherFn: async () => async () => {},
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const post = (route, body) => fetch(`${app.url}api/${route}`, {
    method: "POST",
    headers: { Origin: app.url.slice(0, -1), "Content-Type": "application/json", "X-File-Tool-Token": bootstrap.token },
    body: JSON.stringify(body),
  });
  assert.equal((await post("start", { siteId: "chatgpt", root, role: "unknown" })).status, 400);
  assert.equal(launches, 0);
  const oldCheckpoint = checkpointStore.forThread("chatgpt", root, "https://chatgpt.com/c/old-code", "code");
  oldCheckpoint.write({ phase: "executing", replyId: "a".repeat(64), actionCount: 1 });
  const blocked = await post("start", { siteId: "chatgpt", root, role: "text" });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /另一任务角色.*未确认/);
  assert.equal(launches, 0);
  oldCheckpoint.acknowledge();
  assert.equal((await post("start", { siteId: "chatgpt", root, role: "text" })).status, 202);
  assert.equal((await waitPhase(app.url, "running")).role, "text");
  assert.match(sent.at(-1), /文本目录问答/);
  assert.equal(store.getThread("chatgpt", root), null);
  assert.ok(store.getThread("chatgpt", root, "text"));
  await post("stop", {});
  assert.equal((await post("start", { siteId: "chatgpt", root })).status, 202);
  await waitPhase(app.url, "running");
  assert.equal(opened[1], undefined);
  assert.match(sent.at(-1), /代码导师/);
});

test("本地控制台：专用浏览器被手动关闭后退出旁观并提示重启", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-close-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let context;
  let stopped = 0;
  const watcher = async () => { stopped++; };
  watcher.pause = async () => {};
  watcher.resume = () => {};
  const app = await startControlServer({
    getThreadFn: () => null,
    saveThreadFn: () => {},
    checkpointStore: createWatchCheckpointStore(path.join(dir, "watch.json")),
    launchBrowserFn: async () => {
      context = new EventEmitter();
      context.close = async () => { context.emit("close"); };
      return { context, channel: "测试浏览器" };
    },
    createDriverFn: async () => ({ async markTab() {}, async send() { return { ok: true }; }, currentUrl() { return "https://chat.deepseek.com/a/chat/s/test-close"; } }),
    startWatcherFn: async () => watcher,
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const response = await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": bootstrap.token,
    },
    body: JSON.stringify({ siteId: "deepseek", root: process.cwd() }),
  });
  assert.equal(response.status, 202);
  await waitPhase(app.url, "running");
  context.emit("close");
  const status = await waitPhase(app.url, "error");
  assert.match(status.error, /专用浏览器已关闭/);
  assert.equal(stopped, 1);
});

test("本地控制台：选中学过的项目时在旧聊天 URL 启动而非新会话", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldUrl = "https://chatgpt.com/c/previous-thread";
  const created = [];
  const sent = [];
  const app = await startControlServer({
    getThreadFn: (siteId, projectRoot) => {
      assert.equal(siteId, "chatgpt");
      assert.equal(projectRoot, root);
      return { url: oldUrl, updatedAt: Date.now() };
    },
    saveThreadFn: () => {},
    launchBrowserFn: async () => ({
      channel: "测试浏览器", context: { on() {}, async close() {} },
    }),
    createDriverFn: async (options) => {
      created.push(options);
      return {
        async markTab() {},
        async send(payload) { sent.push(payload); return { ok: true, text: "已续接" }; },
        currentUrl() { return oldUrl; },
      };
    },
    startWatcherFn: async () => {
      const stop = async () => {};
      stop.pause = async () => {};
      stop.resume = () => {};
      return stop;
    },
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const response = await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": bootstrap.token,
    },
    body: JSON.stringify({ siteId: "chatgpt", root }),
  });
  assert.equal(response.status, 202);
  await waitPhase(app.url, "running");
  assert.equal(created.length, 1);
  assert.equal(created[0].startUrl, oldUrl, "驱动必须打开旧聊天 URL");
  assert.equal(sent.length, 1, "旧线程只发送一条短重连消息");
});

test("本地控制台：中断断点先人工核对，不发送重连消息或重跑旧动作", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldUrl = "https://chat.deepseek.com/a/chat/s/old-thread";
  const checkpointStore = createWatchCheckpointStore(path.join(root, "watch.json"));
  const checkpoint = checkpointStore.forThread("deepseek", root, oldUrl);
  checkpoint.write({ phase: "delivering", replyId: replyFingerprint({ count: 1, text: "旧动作" }), actionCount: 1 });
  let sent = 0;
  let watched = 0;
  let closed = 0;
  const app = await startControlServer({
    checkpointStore,
    getThreadFn: () => ({ url: oldUrl, updatedAt: Date.now() }),
    saveThreadFn: () => {},
    launchBrowserFn: async () => ({
      channel: "测试浏览器", context: { on() {}, async close() { closed++; } },
    }),
    createDriverFn: async () => ({
      async markTab() {},
      currentUrl() { return oldUrl; },
      async send() { sent++; return { ok: true }; },
    }),
    startWatcherFn: async () => { watched++; return async () => {}; },
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const post = (route, body) => fetch(`${app.url}api/${route}`, {
    method: "POST",
    headers: { Origin: app.url.slice(0, -1), "Content-Type": "application/json", "X-File-Tool-Token": bootstrap.token },
    body: JSON.stringify(body),
  });
  assert.equal((await post("start", { siteId: "deepseek", root })).status, 202);
  const recovery = await waitPhase(app.url, "recovery");
  assert.match(recovery.error, /人工|核对/);
  assert.equal(sent, 0);
  assert.equal(watched, 0);
  assert.equal(closed, 0, "浏览器须保持打开供用户检查原聊天");
  assert.equal((await post("confirm-recovery", {})).status, 200);
  await waitPhase(app.url, "running");
  assert.equal(checkpoint.read().phase, "processed");
  assert.equal(watched, 1);
  assert.equal(sent, 0, "人工确认后也不自动重发消息");
});

test("本地控制台：网页连接分健康、状态不明、已停止，探测失败不关闭浏览器", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let context;
  let mode = "healthy";
  let closed = 0;
  const app = await startControlServer({
    healthCheckMs: 0,
    checkpointStore: createWatchCheckpointStore(path.join(root, "watch.json")),
    getThreadFn: () => null,
    saveThreadFn: () => {},
    launchBrowserFn: async () => {
      context = new EventEmitter();
      context.close = async () => { closed++; context.emit("close"); };
      return { channel: "测试浏览器", context };
    },
    createDriverFn: async () => ({
      async markTab() {},
      async send() { return { ok: true, text: "ok" }; },
      currentUrl() { return "https://chat.deepseek.com/a/chat/s/test-health"; },
      async probe() { if (mode === "unknown") throw new Error("探测超时"); return { state: "healthy" }; },
    }),
    startWatcherFn: async () => async () => {},
  });
  t.after(() => app.close());
  const status = async () => (await (await fetch(`${app.url}api/status`)).json());
  assert.equal((await status()).health.state, "stopped");
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: { Origin: app.url.slice(0, -1), "Content-Type": "application/json", "X-File-Tool-Token": bootstrap.token },
    body: JSON.stringify({ siteId: "deepseek", root }),
  });
  await waitPhase(app.url, "running");
  assert.equal((await status()).health.state, "healthy");
  mode = "unknown";
  assert.equal((await status()).health.state, "unknown");
  assert.equal(closed, 0, "探测失败不能自动关闭或重启浏览器");
  context.emit("close");
  await waitPhase(app.url, "error");
  assert.equal((await status()).health.state, "stopped");
});

test("本地控制台：启动失败后的主动清理不覆盖原始错误", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-health-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldUrl = "https://chatgpt.com/c/old-thread";
  const app = await startControlServer({
    getThreadFn: () => ({ url: oldUrl }),
    checkpointStore: createWatchCheckpointStore(path.join(root, "watch.json")),
    launchBrowserFn: async () => {
      const context = new EventEmitter();
      context.close = async () => context.emit("close");
      return { context, channel: "测试浏览器" };
    },
    createDriverFn: async () => ({
      async markTab() {},
      currentUrl() { return "https://chatgpt.com/"; },
      async probe() { return { state: "unknown" }; },
    }),
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: { Origin: app.url.slice(0, -1), "Content-Type": "application/json", "X-File-Tool-Token": bootstrap.token },
    body: JSON.stringify({ siteId: "chatgpt", root }),
  });
  const failed = await waitPhase(app.url, "error");
  assert.match(failed.error, /历史聊天未能打开/);
  assert.equal(failed.health.state, "stopped");
});

test("本地控制台：首次学习项目后登记聊天 URL 供下次启动续接", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-first-thread-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const saved = [];
  const opened = [];
  let thread = null;
  const options = {
    getThreadFn: () => thread,
    saveThreadFn: (...args) => { saved.push(args); thread = { url: args[2] }; },
    launchBrowserFn: async () => ({
      channel: "测试浏览器", context: { on() {}, async close() {} },
    }),
    createDriverFn: async ({ startUrl }) => {
      opened.push(startUrl);
      return {
        async markTab() {},
        async send() { return { ok: true, text: "已开场" }; },
        currentUrl() { return "https://chatgpt.com/c/first-thread"; },
      };
    },
    startWatcherFn: async () => async () => {},
  };
  const app = await startControlServer(options);
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const response = await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": bootstrap.token,
    },
    body: JSON.stringify({ siteId: "chatgpt", root }),
  });
  assert.equal(response.status, 202);
  await waitPhase(app.url, "running");
  assert.deepEqual(saved, [["chatgpt", root, "https://chatgpt.com/c/first-thread"]]);
  await app.close();

  // 模拟进程重新启动：内存中的控制台已销毁，项目登记仍可被新实例读取。
  const restarted = await startControlServer(options);
  t.after(() => restarted.close());
  const nextBootstrap = await (await fetch(`${restarted.url}api/bootstrap`)).json();
  const nextResponse = await fetch(`${restarted.url}api/start`, {
    method: "POST",
    headers: {
      Origin: restarted.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": nextBootstrap.token,
    },
    body: JSON.stringify({ siteId: "chatgpt", root }),
  });
  assert.equal(nextResponse.status, 202);
  await waitPhase(restarted.url, "running");
  assert.deepEqual(opened, [undefined, "https://chatgpt.com/c/first-thread"]);
});

test("本地控制台：旧聊天被重定向到首页时不冒充续连或覆盖登记", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-redirect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldUrl = "https://chatgpt.com/c/old-thread";
  let sent = 0;
  let saved = 0;
  const app = await startControlServer({
    getThreadFn: () => ({ url: oldUrl }),
    saveThreadFn: () => { saved++; },
    launchBrowserFn: async () => ({
      channel: "测试浏览器", context: { on() {}, async close() {} },
    }),
    createDriverFn: async ({ startUrl }) => {
      assert.equal(startUrl, oldUrl);
      return {
        async markTab() {},
        currentUrl() { return "https://chatgpt.com/"; },
        async send() { sent++; return { ok: true }; },
        async openUrl() {},
      };
    },
    startWatcherFn: async () => async () => {},
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const response = await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": bootstrap.token,
    },
    body: JSON.stringify({ siteId: "chatgpt", root }),
  });
  assert.equal(response.status, 202);
  const status = await waitPhase(app.url, "error");
  assert.match(status.error, /历史聊天/);
  assert.equal(sent, 0, "不能在新聊天误发重连消息或开场白");
  assert.equal(saved, 0);
});

test("本地控制台：拒绝跨站历史 URL，避免把项目路径发给其他网站", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-wrong-origin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let created = 0;
  const app = await startControlServer({
    getThreadFn: () => ({ url: "https://example.com/c/not-ours" }),
    launchBrowserFn: async () => ({
      channel: "测试浏览器", context: { on() {}, async close() {} },
    }),
    createDriverFn: async () => { created++; throw new Error("不应打开外站"); },
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const response = await fetch(`${app.url}api/start`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": bootstrap.token,
    },
    body: JSON.stringify({ siteId: "chatgpt", root }),
  });
  assert.equal(response.status, 202);
  const status = await waitPhase(app.url, "error");
  assert.match(status.error, /地址无效/);
  assert.equal(created, 0);
});

test("本地控制台：可绑定旧聊天到项目，启动时打开该线程且拒绝跨站地址", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-bind-thread-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldUrl = "https://chat.deepseek.com/a/chat/s/old-thread";
  let saved = null;
  let launched = 0;
  let opened = "";
  const app = await startControlServer({
    getThreadFn: () => saved,
    saveThreadFn: (siteId, projectRoot, url) => {
      assert.equal(siteId, "deepseek");
      assert.equal(projectRoot, root);
      saved = { url };
    },
    launchBrowserFn: async () => {
      launched++;
      return { channel: "测试浏览器", context: { on() {}, async close() {} } };
    },
    createDriverFn: async ({ startUrl }) => {
      opened = startUrl;
      return {
        async markTab() {},
        currentUrl() { return oldUrl; },
        async send() { return { ok: true, text: "已续接" }; },
      };
    },
    startWatcherFn: async () => async () => {},
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const post = (route, body, token = bootstrap.token) => fetch(`${app.url}api/${route}`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": token,
    },
    body: JSON.stringify(body),
  });
  const request = { siteId: "deepseek", root, url: oldUrl };
  const unregistered = await post("thread-status", { siteId: "deepseek", root });
  assert.equal(unregistered.status, 200);
  assert.deepEqual(await unregistered.json(), { registered: false, valid: false });
  assert.equal((await post("bind-thread", request, "wrong")).status, 403);
  const wrongSite = await post("bind-thread", { ...request, siteId: "chatgpt" });
  assert.equal(wrongSite.status, 400);
  assert.match((await wrongSite.json()).error, /DeepSeek.*ChatGPT.*切换/);
  assert.equal(saved, null, "网站不匹配时不能写入登记");
  assert.equal((await post("bind-thread", { ...request, url: "https://example.com/c/other" })).status, 400);
  assert.equal((await post("bind-thread", request)).status, 200);
  assert.equal(saved.url, oldUrl);
  assert.equal(launched, 0, "绑定地址不能提前启动浏览器");
  const registered = await post("thread-status", { siteId: "deepseek", root });
  assert.equal(registered.status, 200);
  assert.deepEqual(await registered.json(), { registered: true, valid: true });

  assert.equal((await post("start", { siteId: "deepseek", root })).status, 202);
  await waitPhase(app.url, "running");
  assert.equal(opened, oldUrl);
  assert.equal((await post("bind-thread", request)).status, 409, "运行中不能改绑项目");
});

test("本地控制台：登记文件损坏时提示并阻止新建聊天或覆盖登记", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-corrupt-threads-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "threads.json");
  const original = "{损坏的历史登记";
  await fs.writeFile(file, original);
  const store = createThreadStore(file);
  let drivers = 0;
  const app = await startControlServer({
    getThreadFn: store.getThread,
    saveThreadFn: store.saveThread,
    launchBrowserFn: async () => ({ channel: "测试浏览器", context: { on() {}, async close() {} } }),
    createDriverFn: async () => { drivers++; throw new Error("不应打开新聊天"); },
  });
  t.after(() => app.close());
  const bootstrap = await (await fetch(`${app.url}api/bootstrap`)).json();
  const post = (route, body) => fetch(`${app.url}api/${route}`, {
    method: "POST",
    headers: {
      Origin: app.url.slice(0, -1), "Content-Type": "application/json",
      "X-File-Tool-Token": bootstrap.token,
    },
    body: JSON.stringify(body),
  });
  const selected = { siteId: "deepseek", root };
  const preview = await post("thread-status", selected);
  assert.equal(preview.status, 400);
  assert.match((await preview.json()).error, /登记文件格式错误/);
  const binding = await post("bind-thread", { ...selected, url: "https://chat.deepseek.com/a/chat/s/old" });
  assert.notEqual(binding.status, 200);
  assert.equal((await post("start", selected)).status, 202);
  const failed = await waitPhase(app.url, "error");
  assert.match(failed.error, /登记文件格式错误/);
  assert.equal(drivers, 0);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("browse: 列出子目录（仅目录、带绝对路径），文件被过滤", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-browse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "sub-a"));
  await fs.mkdir(path.join(root, "sub-b"));
  await fs.writeFile(path.join(root, "file.txt"), "x");

  const data = await listDirectories(root);
  assert.equal(data.error, undefined);
  assert.equal(data.current, root);
  assert.deepEqual(
    data.entries.map((e) => e.name),
    ["sub-a", "sub-b"]
  );
  assert.ok(data.entries[0].path.startsWith(root), "应返回供前端直接导航的绝对路径");
  assert.equal(data.parent, path.dirname(root));
});

test("browse: 指向文件时回退父目录；不存在的路径返回 error", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-browse-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "f.txt");
  await fs.writeFile(file, "x");
  const viaFile = await listDirectories(file);
  assert.equal(viaFile.current, root, "文件路径应回退到所在目录");

  const missing = await listDirectories(path.join(root, "nope"));
  assert.match(missing.error, /不存在/);
});
