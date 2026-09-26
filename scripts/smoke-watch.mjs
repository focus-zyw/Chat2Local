/**
 * watch（旁观执行）模式端到端自测：先在 mock 页发送 watch 专属开场白，
 * 再用 ?auto=1 模拟"用户已在网页上提问、导师回复带 host 动作块"，
 * 验证 watcher 发现动作、执行并自动回填。不需要账号。跑法：npm run smoke:watch
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMockServer, mockServerUrl } from "./mock-server.mjs";
import { launchBrowser } from "../src/browser.mjs";
import { createDriver } from "../src/page-driver.mjs";
import { startWatcher } from "../src/watcher.mjs";
import { watchIntroPayload } from "../src/protocol.mjs";
import { createWatchCheckpointStore } from "../src/watch-checkpoint.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "watch-fixture", type: "module" }, null, 2) + "\n"
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export default 1;\n");
  return root;
}

async function main() {
  const fixture = await makeFixture();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-watch-profile-"));
  const server = await startMockServer();
  const mockUrl = mockServerUrl(server);
  let context;
  try {
    ({ context } = await launchBrowser({ headless: true, profileDir }));
    const log = (m) => process.stderr.write(`[smoke:watch] ${m}\n`);
    const introDriver = await createDriver({ context, siteId: "mock", siteUrl: mockUrl, watchMs: 20000, log });
    const intro = await introDriver.send(watchIntroPayload(fixture));
    await introDriver.close();
    if (!intro.ok || !intro.text.includes("```host")) {
      throw new Error(`SMOKE-WATCH FAILED: watch 开场白未触发动作回复：${intro.error || intro.text}`);
    }
    const driver = await createDriver({
      context,
      siteId: "mock",
      siteUrl: mockUrl + "?auto=1",
      watchMs: 20000,
      log,
    });
    await driver.markTab();
    if ((await driver.probe()).state !== "healthy") {
      throw new Error("SMOKE-WATCH FAILED: 已打开 mock 网页却未检测到可用输入框");
    }
    const checkpoint = createWatchCheckpointStore(path.join(profileDir, "watch-checkpoints.json"))
      .forThread("mock", fixture, mockUrl + "?auto=1");
    const logs = [];
    const stop = await startWatcher({
      driver,
      root: fixture,
      checkpoint,
      intervalMs: 400,
      stableMs: 800,
      log: (m) => {
        logs.push(m);
        log(m);
      },
    });

    // 等 watcher 完成闭环：mock 收到回填后回复 WATCHER-FEED-OK
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await sleep(500);
      const snap = await driver.snapshot();
      if (snap.text.includes("WATCHER-FEED-OK")) ok = true;
    }
    await stop();
    if (!ok) throw new Error("SMOKE-WATCH FAILED: 20s 内未见回填后的讲解\n" + logs.join("\n"));
    if (checkpoint.read()?.phase !== "processed") throw new Error("SMOKE-WATCH FAILED: 动作完成后断点未落盘");

    // 诊断回归（脱敏故障样本）：细分原因映射必须与页面状态一致
    const healthy = await driver.diagnose();
    if (healthy.state !== "healthy") {
      throw new Error(`SMOKE-WATCH FAILED: 健康页诊断应为 healthy，实际 ${healthy.cause}`);
    }
    await driver.openUrl(mockUrl + "?broken=hidden");
    const hidden = await driver.diagnose();
    if (hidden.cause !== "composer-invisible") {
      throw new Error(`SMOKE-WATCH FAILED: hidden 变体应为 composer-invisible，实际 ${hidden.cause}`);
    }
    // probe 可见性判定（评审 Spec-3）：hidden 输入框不得误判为健康
    const probeHidden = await driver.probe();
    if (probeHidden.state !== "unknown" || probeHidden.cause !== "composer-invisible") {
      throw new Error(`SMOKE-WATCH FAILED: hidden 变体的 probe 应为 composer-invisible，实际 ${probeHidden.state}/${probeHidden.cause || "—"}`);
    }
    await driver.openUrl(mockUrl + "?broken=composer");
    const missed = await driver.diagnose();
    if (missed.cause !== "composer-selector-miss") {
      throw new Error(`SMOKE-WATCH FAILED: composer 变体应为 composer-selector-miss，实际 ${missed.cause}`);
    }
    // probe 范围收窄（评审 P28）：只查输入框，不因回复区正常而误判健康
    const probeScoped = await driver.probe();
    if (probeScoped.cause !== "composer-miss" || !probeScoped.advice) {
      throw new Error(`SMOKE-WATCH FAILED: 收窄后的 probe 在 composer 变体应为 composer-miss，实际 ${probeScoped.cause || "—"}`);
    }
    process.stdout.write("SMOKE-WATCH PASSED — 旁观执行模式全链路 OK（含诊断回归：healthy/hidden/selector-miss/probe-scope）\n");
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke:watch] ${err?.stack || err}\n`);
  process.exit(1);
});
