/**
 * 端到端自测（不需要任何账号/真实站点）：
 *
 *   1. 造一个 fixture 目录（package.json + 一个会打印 SMOKE-TEST-PASSED 的测试文件）
 *   2. 起本地 mock 聊天页（端口冲突时自动换空闲端口）
 *   3. Playwright 开无头浏览器 → mock 页 → 跑完整 Agent Loop
 *   4. 断言 receipt：complete、ls/read/run 三个动作都成功、done 总结回显了真实文件内容
 *
 * 跑法：npm run smoke
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMockServer, mockServerUrl } from "./mock-server.mjs";
import { launchBrowser } from "../src/browser.mjs";
import { createDriver } from "../src/page-driver.mjs";
import { orchestrate } from "../src/loop.mjs";
import { MOCK_SITE } from "../src/sites.mjs";

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-smoke-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "smoke-fixture", type: "module" }, null, 2) + "\n"
  );
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tests", "smoke.test.js"),
    "console.log('SMOKE-TEST-PASSED');\n"
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export default 1;\n");
  await fs.writeFile(path.join(root, "src", "bug.js"), "export const enabled = false;\n");
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "guide.md"), "审批时限：3天。\n逾期联系负责人。\n");
  await fs.writeFile(path.join(root, "tests", "bug.test.js"),
    'import assert from "node:assert/strict";\nimport { enabled } from "../src/bug.js";\nassert.equal(enabled, true);\n');
  return root;
}

async function main() {
  const fixture = await makeFixture();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-smoke-profile-"));
  const server = await startMockServer();
  const mockUrl = mockServerUrl(server);
  process.stderr.write(`[smoke] mock 页 ${mockUrl}，fixture ${fixture}\n`);

  let context;
  try {
    ({ context } = await launchBrowser({ headless: true, profileDir }));
    const driver = await createDriver({
      context,
      siteId: "mock",
      siteUrl: mockUrl,
      watchMs: 60000,
      log: (m) => process.stderr.write(`[smoke] ${m}\n`),
    });
    const receipt = await orchestrate({
      driver,
      task: "自测：按协议依次 ls、read、run，然后 done。",
      root: fixture,
      maxRounds: 6,
      log: (m) => process.stderr.write(`[smoke] ${m}\n`),
    });

    const fails = [];
    if (receipt.endReason !== "complete") fails.push(`endReason=${receipt.endReason}`);
    const ops = receipt.actions.map((a) => a.op);
    if (!ops.includes("ls")) fails.push("没有 ls 动作");
    if (!ops.includes("read")) fails.push("没有 read 动作");
    if (!ops.includes("run")) fails.push("没有 run 动作");
    if (!receipt.actions.every((a) => a.ok)) fails.push("有动作失败: " + JSON.stringify(receipt.actions));
    if (!/smoke-fixture/.test(receipt.note)) fails.push("done 总结未回显真实文件内容");
    if (!/SMOKE-TEST-PASSED/.test(receipt.note)) fails.push("done 总结未包含测试输出标记");
    if (!receipt.ran.length || receipt.ran[0].exit !== 0) fails.push("run 回执异常: " + JSON.stringify(receipt.ran));

    if (fails.length) {
      process.stderr.write(JSON.stringify(receipt, null, 2) + "\n");
      throw new Error("SMOKE FAILED:\n" + fails.join("\n"));
    }
    process.stdout.write("SMOKE PASSED — ls / read / run 全链路 OK\n" + receipt.note + "\n");

    const diagnoseDriver = await createDriver({
      context,
      siteId: "mock",
      siteUrl: mockUrl,
      watchMs: 60000,
      log: (m) => process.stderr.write(`[smoke:diagnose] ${m}\n`),
    });
    const diagnosis = await orchestrate({
      driver: diagnoseDriver,
      task: "已有测试失败，请定位原因",
      root: fixture,
      diagnose: true,
      maxRounds: 6,
      log: (m) => process.stderr.write(`[smoke:diagnose] ${m}\n`),
    });
    const diagnoseOps = diagnosis.actions.map((a) => a.op);
    if (diagnosis.endReason !== "complete" ||
      !["search", "read", "run"].every((op) => diagnoseOps.includes(op)) ||
      diagnosis.ran[0]?.exit !== 1 ||
      !/src\/bug\.js:1/.test(diagnosis.note) ||
      !/tests\/bug\.test\.js 退出码 1/.test(diagnosis.note)) {
      throw new Error("排障冒烟失败：" + JSON.stringify(diagnosis));
    }
    process.stdout.write("SMOKE DIAGNOSE PASSED — search / read / run / 证据结论全链路 OK\n");

    const textDriver = await createDriver({
      context, siteId: "mock", siteUrl: mockUrl, watchMs: 60000,
      log: (m) => process.stderr.write(`[smoke:text] ${m}\n`),
    });
    const textReceipt = await orchestrate({
      driver: textDriver, task: "审批时限是多少？", root: fixture, role: "text", maxRounds: 6,
      log: (m) => process.stderr.write(`[smoke:text] ${m}\n`),
    });
    if (textReceipt.endReason !== "complete" ||
      !textReceipt.actions.some((a) => a.op === "search" && a.ok) ||
      !textReceipt.actions.some((a) => a.op === "read" && a.ok) ||
      !/notes\/guide\.md:1/.test(textReceipt.note)) {
      throw new Error("文本任务冒烟失败：" + JSON.stringify(textReceipt));
    }
    process.stdout.write("SMOKE TEXT PASSED — 文本问答及来源行号全链路 OK\n");
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke] ${err?.stack || err}\n`);
  process.exit(1);
});
