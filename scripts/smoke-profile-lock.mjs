/** 专用浏览器资料目录占用冒烟：第二次启动不得结束第一个测试浏览器。 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "../src/browser.mjs";

const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-profile-lock-"));
let first;
let second;
try {
  first = (await launchBrowser({ headless: true, profileDir })).context;
  const page = await first.newPage();
  await page.goto("data:text/html,<title>profile-alive</title>");
  if (await page.title() !== "profile-alive") throw new Error("测试浏览器未准备好");
  let refused = false;
  try {
    second = (await launchBrowser({ headless: true, profileDir })).context;
  } catch (err) {
    refused = /不会自动结束.*浏览器/.test(err.message);
  }
  let originalAlive = false;
  try { originalAlive = await page.title() === "profile-alive"; } catch { /* 已被错误结束 */ }
  if (!originalAlive) {
    throw new Error("SMOKE-PROFILE FAILED：原专用浏览器已被结束");
  }
  if (!refused) throw new Error("SMOKE-PROFILE FAILED：第二次启动没有安全拒绝占用");
  process.stdout.write("SMOKE-PROFILE PASSED — 资料目录占用时原浏览器保持运行\n");
} finally {
  await second?.close().catch(() => {});
  await first?.close().catch(() => {});
  if (path.dirname(path.resolve(profileDir)) !== path.resolve(os.tmpdir()) ||
      !path.basename(profileDir).startsWith("file-tool-profile-lock-")) {
    throw new Error("临时资料目录校验失败，未清理");
  }
  await fs.rm(profileDir, { recursive: true, force: true });
}
