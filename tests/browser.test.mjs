import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "../src/browser.mjs";

async function removeTestProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("file-tool-browser-")) {
    throw new Error("临时浏览器目录校验失败，未清理");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

test("browser: 全部渠道失败时不自动结束资料目录占用者", async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-browser-test-"));
  t.after(() => removeTestProfile(profileDir));
  let attempts = 0;
  await assert.rejects(
    launchBrowser({
      profileDir,
      headless: true,
      profileInUseFn: () => false,
      launchPersistentContextFn: async () => {
        attempts++;
        throw new Error("模拟资料目录被占用");
      },
    }),
    /不会自动结束.*浏览器/
  );
  assert.equal(attempts, 3, "每个浏览器渠道只尝试一次，不应先结束占用者再重试");
});

test("browser: 已检测到占用时不再尝试启动第二个浏览器", async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-browser-occupied-"));
  t.after(() => removeTestProfile(profileDir));
  let attempts = 0;
  await assert.rejects(
    launchBrowser({
      profileDir,
      profileInUseFn: () => true,
      launchPersistentContextFn: async () => { attempts++; throw new Error("不应启动"); },
    }),
    /资料目录正在被使用/
  );
  assert.equal(attempts, 0);
});

test("browser: 无法确认占用状态时保守拒绝启动", async (t) => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-tool-browser-unknown-"));
  t.after(() => removeTestProfile(profileDir));
  let attempts = 0;
  await assert.rejects(
    launchBrowser({
      profileDir,
      profileInUseFn: () => null,
      launchPersistentContextFn: async () => { attempts++; throw new Error("不应启动"); },
    }),
    /无法确认.*已取消启动/
  );
  assert.equal(attempts, 0);
});
