/**
 * 真实站点端到端自检（需要专用 profile 已登录目标站点）：
 *
 *   node scripts/live-check.mjs deepseek --root D:/git-project/mitt
 *
 * 流程：启动专用浏览器 → 发导师开场白 → 启动 watcher → 以用户身份发一个问题
 * （要求导师用 ls）→ 等待"检测动作 → 执行 → 回填"闭环 → 再等导师消化结果
 * 后的新讲解 → 打印全程证据。
 *
 * 这是一次真实的模型调用与真实文件读取，会打开可见浏览器窗口。
 */

import path from "node:path";
import { launchBrowser } from "../src/browser.mjs";
import { createDriver } from "../src/page-driver.mjs";
import { startWatcher } from "../src/watcher.mjs";
import { watchIntroPayload } from "../src/protocol.mjs";
import { rootDirArg } from "../src/cli.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const argv = process.argv.slice(2);
  const siteId = argv[0];
  if (!siteId) throw new Error("用法: node scripts/live-check.mjs <site> --root <dir>");
  const root = rootDirArg(argv);

  const logs = [];
  const log = (m) => {
    logs.push(m);
    process.stderr.write(`[live] ${m}\n`);
  };

  process.stderr.write(`[live] 启动浏览器（可见窗口）与 ${siteId} 会话，root=${root}\n`);
  const { context, channel } = await launchBrowser({ headless: false });
  try {
    const driver = await createDriver({ context, siteId, watchMs: 300000, log });
    await driver.markTab();
    log("发送导师开场白…");
    const intro = await driver.send(watchIntroPayload(root));
    if (!intro.ok) throw new Error(`开场白失败：${intro.error}`);
    log(`开场白回复 ${intro.text.length} 字符`);

    let fed = false;
    const stop = await startWatcher({
      driver,
      root,
      log: (m) => {
        if (/结果回填(?:重试)?成功/.test(m)) fed = true;
        log(m);
      },
      onReply: (t) => log(`（新讲解 ${t.length} 字符，无动作块）`),
    });

    log("以用户身份发送测试问题…");
    const q = await driver.deliver(
      "请先用一次 ls 动作（path 用 . ，recursive 用 true）看看这个项目的目录结构，然后用两三句话告诉我这是什么项目。"
    );
    if (!q.ok) throw new Error(`问题发送失败：${q.error}`);

    // 等待回填闭环（最长 6 分钟——思考型模型可能很慢）
    for (let i = 0; i < 120 && !fed; i++) await sleep(3000);
    if (!fed) {
      await stop();
      throw new Error("LIVE-CHECK FAILED: 6 分钟内 watcher 未完成 执行→回填 闭环");
    }
    log("回填已完成，等导师消化结果后的新讲解（45s）…");
    await sleep(45000);
    const finalSnap = await driver.snapshot();
    await stop();

    process.stdout.write(
      "\n=== 最终页面状态 ===\n" +
        `busy=${finalSnap.busy} chars=${finalSnap.text.length}\n` +
        finalSnap.text.slice(-600) + "\n" +
        "\n=== 判定 ===\n" +
        (fed ? "LIVE-CHECK PASSED — 真实站点闭环 OK\n" : "LIVE-CHECK FAILED\n")
    );
    if (!fed) process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[live] ${err?.stack || err}\n`);
  process.stderr.write(`[live] 追踪文件: ~/.file-tool/watch-trace.txt\n`);
  process.exit(1);
});
