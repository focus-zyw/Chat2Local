/** 本地控制台浏览器冒烟：模拟 watch 后端，验证暂停、续接与旧聊天绑定。 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "../src/browser.mjs";
import { startControlServer } from "../src/control-server.mjs";
import { createWatchCheckpointStore, replyFingerprint } from "../src/watch-checkpoint.mjs";

const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-console-profile-"));
let context;
let app;
let launched = 0;
let closed = 0;
let paused = 0;
let resumed = 0;
let stopped = 0;
let savedUrl = "";
let sent = 0;
let probeState = "healthy";
const opened = [];
const checkpointStore = createWatchCheckpointStore(path.join(profileDir, "watch-checkpoints.json"));

try {
  const watcher = async () => { stopped++; };
  watcher.pause = async () => { paused++; };
  watcher.resume = () => { resumed++; };
  const options = {
    checkpointStore,
    healthCheckMs: 0,
    getThreadFn: () => savedUrl ? { url: savedUrl } : null,
    saveThreadFn: (_siteId, _root, url) => { savedUrl = url; },
    launchBrowserFn: async () => {
      launched++;
      return { channel: "模拟浏览器", context: { on() {}, async close() { closed++; } } };
    },
    createDriverFn: async ({ startUrl }) => {
      opened.push(startUrl);
      return {
        async markTab() {},
        async send() { sent++; return { ok: true }; },
        async probe() { return probeState === "healthy" ? { state: "healthy" } : { state: "unknown", reason: "no-composer" }; },
        currentUrl() { return startUrl || "https://chatgpt.com/c/smoke-console"; },
      };
    },
    startWatcherFn: async () => watcher,
  };
  app = await startControlServer(options);
  ({ context } = await launchBrowser({ headless: true, profileDir }));
  const page = await context.newPage();
  await page.goto(app.url);
  await page.getByRole("heading", { name: "让网页聊天使用你的本地工具" }).waitFor();
  await page.locator("#root").fill(process.cwd());
  await page.locator("#site").selectOption("chatgpt");
  await page.locator("#role").selectOption("text");
  if (await page.locator("#role").inputValue() !== "text") throw new Error("控制台无法选择文本问答角色");
  await page.locator("#role").selectOption("code");
  await page.getByText(/未登记历史聊天，启动将新建/).waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: /启动旁观执行/ }).click();
  await page.getByText("正在旁观", { exact: true }).waitFor();
  await page.getByText(/健康 · 网页输入框可用/).waitFor();
  probeState = "unknown";
  await page.getByText(/状态不明 · 找不到输入框/).waitFor({ timeout: 5000 });
  if (closed) throw new Error("网页状态不明时错误地关闭了浏览器");
  probeState = "healthy";
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await page.getByText("已暂停", { exact: true }).waitFor();
  if (closed || paused !== 1) throw new Error("暂停未保留浏览器会话");
  await page.reload();
  await page.getByText("已暂停", { exact: true }).waitFor();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await page.getByText("正在旁观", { exact: true }).waitFor();
  if (launched !== 1 || resumed !== 1) throw new Error("继续时重启了浏览器");
  await page.getByRole("button", { name: "结束会话" }).click();
  await page.getByText("尚未启动", { exact: true }).waitFor();
  if (stopped !== 1 || closed !== 1) throw new Error("结束会话未正确清理");
  await app.close();
  app = await startControlServer(options);
  await page.goto(app.url);
  await page.getByText("尚未启动", { exact: true }).waitFor();
  await page.locator("#root").fill(process.cwd());
  await page.locator("#site").selectOption("chatgpt");
  const recoveredUrl = "https://chatgpt.com/c/recovered-old-chat";
  await page.getByText("找回以前的聊天", { exact: true }).click();
  const beforeMismatch = savedUrl;
  await page.getByLabel("旧聊天地址").fill("https://chat.deepseek.com/a/chat/s/other-site");
  await page.getByRole("button", { name: "绑定旧聊天" }).click();
  await page.getByText(/链接属于 DeepSeek，当前选择的是 ChatGPT.*切换聊天网站/).waitFor();
  if (savedUrl !== beforeMismatch) throw new Error("跨站链接错误地覆盖了历史登记");
  await page.getByLabel("旧聊天地址").fill(recoveredUrl);
  await page.getByRole("button", { name: "绑定旧聊天" }).click();
  await page.getByText(/旧聊天已绑定到所选项目/).waitFor();
  await page.getByText(/已有历史聊天登记，启动将续接/).waitFor({ timeout: 3000 });
  if (savedUrl !== recoveredUrl) throw new Error("浏览器绑定操作未保存旧聊天地址");
  await page.getByRole("button", { name: /启动旁观执行/ }).click();
  await page.getByText("正在旁观", { exact: true }).waitFor();
  if (opened[0] !== undefined || opened[1] !== savedUrl) {
    throw new Error("控制台重启后没有打开上次登记的聊天 URL");
  }
  await page.getByRole("button", { name: "结束会话" }).click();
  await page.getByText("尚未启动", { exact: true }).waitFor();
  checkpointStore.forThread("chatgpt", process.cwd(), savedUrl).write({
    phase: "delivering", replyId: replyFingerprint({ count: 1, text: "模拟中断动作" }), actionCount: 1,
  });
  await app.close();
  app = await startControlServer(options);
  await page.goto(app.url);
  await page.locator("#root").fill(process.cwd());
  await page.locator("#site").selectOption("chatgpt");
  const beforeRecoverySend = sent;
  await page.getByRole("button", { name: /启动旁观执行/ }).click();
  await page.getByText("等待人工核对", { exact: true }).waitFor();
  if (sent !== beforeRecoverySend || checkpointStore.forThread("chatgpt", process.cwd(), savedUrl).read().phase !== "delivering") {
    throw new Error("中断恢复前错误地发送了重连消息或清除了断点");
  }
  await page.getByRole("button", { name: /已核对，继续旁观/ }).click();
  await page.getByText("正在旁观", { exact: true }).waitFor();
  if (sent !== beforeRecoverySend || checkpointStore.forThread("chatgpt", process.cwd(), savedUrl).read().phase !== "processed") {
    throw new Error("人工确认后错误地重发了消息或未保存确认状态");
  }
  await page.getByRole("button", { name: "结束会话" }).click();
  await page.getByText("尚未启动", { exact: true }).waitFor();
  process.stdout.write("SMOKE-CONSOLE PASSED — 暂停/续接、旧聊天绑定与中断核对均正常\n");
} finally {
  if (context) await context.close().catch(() => {});
  if (app) await app.close();
  await fs.rm(profileDir, { recursive: true, force: true });
}
