/**
 * chat（导师）模式端到端自测：mock 聊天页 + 无头浏览器，验证
 *   开场白（含动作轮）→ 讲解 → 用户追问（纯讲解轮）→ 完成
 * 全链路。不需要任何账号。跑法：npm run smoke:chat
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startMockServer, mockServerUrl } from "./mock-server.mjs";
import { launchBrowser } from "../src/browser.mjs";
import { createDriver } from "../src/page-driver.mjs";
import { runTurn } from "../src/loop.mjs";
import { chatIntroPayload, conversationIntroPayload } from "../src/protocol.mjs";

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-chat-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "chat-fixture", type: "module" }, null, 2) + "\n"
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "index.js"), "export default 1;\n");
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.writeFile(path.join(root, "notes", "guide.md"), "审批时限：3天。\n逾期联系负责人。\n");
  return root;
}

async function main() {
  const fixture = await makeFixture();
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-chat-profile-"));
  const server = await startMockServer();
  const mockUrl = mockServerUrl(server);
  let context;
  const fails = [];
  try {
    ({ context } = await launchBrowser({ headless: true, profileDir }));
    const driver = await createDriver({
      context,
      siteId: "mock",
      siteUrl: mockUrl,
      watchMs: 60000,
      log: (m) => process.stderr.write(`[smoke:chat] ${m}\n`),
    });

    // 开场白：导师协议 → AI 先 ls → 结果回填 → 给出讲解
    const intro = await runTurn({
      driver,
      payload: chatIntroPayload(fixture),
      root: fixture,
      maxRounds: 6,
      log: (m) => process.stderr.write(`[smoke:chat] ${m}\n`),
    });
    if (intro.endReason !== "complete") fails.push(`开场白 endReason=${intro.endReason}`);
    if (!intro.actions.some((a) => a.op === "ls" && a.ok)) fails.push("开场白没有成功的 ls 动作");
    if (!/导师讲解/.test(intro.reply)) fails.push("开场白没有产出讲解");

    // 追问：纯讲解轮（无动作，rounds=1）
    const q = await runTurn({
      driver,
      payload: "入口在哪？",
      root: fixture,
      maxRounds: 6,
      log: (m) => process.stderr.write(`[smoke:chat] ${m}\n`),
    });
    if (q.endReason !== "complete") fails.push(`追问 endReason=${q.endReason}`);
    if (q.rounds !== 1) fails.push(`追问应为单轮，实际 ${q.rounds}`);
    if (!/导师讲解/.test(q.reply) || !/入口在哪/.test(q.reply)) fails.push("追问讲解未回显问题");

    const textDriver = await createDriver({
      context, siteId: "mock", siteUrl: mockUrl, watchMs: 60000,
      log: (m) => process.stderr.write(`[smoke:text] ${m}\n`),
    });
    const textIntro = await runTurn({
      driver: textDriver,
      payload: conversationIntroPayload(fixture, "text", false),
      root: fixture,
      maxRounds: 6,
      log: (m) => process.stderr.write(`[smoke:text] ${m}\n`),
    });
    if (textIntro.endReason !== "complete") fails.push(`文本问答 endReason=${textIntro.endReason}`);
    if (!textIntro.actions.some((a) => a.op === "search" && a.ok)) fails.push("文本问答没有成功搜索");
    if (!textIntro.actions.some((a) => a.op === "read" && a.ok)) fails.push("文本问答没有成功读取");
    if (!/notes\/guide\.md:1/.test(textIntro.note)) fails.push("文本回答没有引用文件行号");
  } finally {
    if (context) await context.close().catch(() => {});
    server.close();
    await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  if (fails.length) throw new Error("SMOKE-CHAT FAILED:\n" + fails.join("\n"));
  process.stdout.write("SMOKE-CHAT PASSED — 导师模式全链路 OK\n");
}

main().catch((err) => {
  process.stderr.write(`[smoke:chat] ${err?.stack || err}\n`);
  process.exit(1);
});
