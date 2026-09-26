/**
 * 浏览器启动器 —— 专用浏览器实例（与日常浏览完全隔离）。
 *
 * 安全模型（见 README）：
 * - 调试能力（Playwright/CDP）只作用于这个独立 profile 的实例，不碰日常浏览器；
 *   即使调试端口被本机恶意页面利用（CDP 无鉴权、DNS rebinding 这类已知攻击面），
 *   拿到的也只是"只登录了聊天网站的空号浏览器"。
 * - profile 目录默认 ~/.file-tool/chrome-profile，持久化——登录一次，之后免登录。
 *
 * 渠道回退：系统 Chrome → 系统 Edge → Playwright 自带 Chromium（需 npx playwright
 * install chromium）。优先系统浏览器：真实指纹，反自动化检测最弱。
 *
 * 资料目录占用：进程退出后可能留下专用浏览器，也可能另一个控制台仍在使用。
 * 无法安全区分两者；启动失败时只提示用户检查，不自动结束占用进程。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

export function defaultProfileDir() {
  return path.join(os.homedir(), ".file-tool", "chrome-profile");
}

const CHANNELS = ["chrome", "msedge", null]; // null = Playwright 自带 Chromium

async function tryChannels(dir, headless, launchPersistentContextFn) {
  const problems = [];
  for (const channel of CHANNELS) {
    try {
      const context = await launchPersistentContextFn(dir, {
        channel: channel || undefined,
        headless,
        viewport: null, // 用真实窗口尺寸
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      return { context, channel: channel || "chromium" };
    } catch (err) {
      problems.push(`${channel || "chromium"}: ${err.message?.split("\n")[0]}`);
    }
  }
  return { context: null, problems };
}

/** 只检查是否有浏览器仍持有此专用目录；不输出进程信息，也不结束进程。 */
function profileInUse(dir) {
  if (process.platform === "win32") {
    const target = dir.replace(/'/g, "''");
    const script =
      `$d='${target}'; ` +
      `$p=Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'msedge.exe' OR Name = 'chromium.exe'\" | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($d,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ` +
      `Select-Object -First 1; if ($p) { 'occupied' } else { 'free' }`;
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096,
    });
    if (result.status !== 0) return null;
    const answer = result.stdout.trim();
    return answer === "occupied" ? true : answer === "free" ? false : null;
  }
  const result = spawnSync("ps", ["-eo", "comm=,args="], {
    encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").some((line) =>
    /chrome|chromium|msedge|microsoft edge/i.test(line) && line.includes(dir)
  );
}

export async function launchBrowser({
  headless = false,
  profileDir,
  profileInUseFn = profileInUse,
  launchPersistentContextFn = (dir, options) => chromium.launchPersistentContext(dir, options),
} = {}) {
  const dir = profileDir || defaultProfileDir();
  fs.mkdirSync(dir, { recursive: true });

  const occupied = profileInUseFn(dir);
  if (occupied === null) {
    throw new Error("无法确认专用浏览器资料目录是否被占用；为保护现有会话，已取消启动");
  }
  if (occupied) {
    throw new Error("专用浏览器资料目录正在被使用；请确认是另一个控制台还是上次残留，关闭后重试。程序不会自动结束其他浏览器进程。");
  }

  const { context, channel, problems } = await tryChannels(dir, headless, launchPersistentContextFn);
  if (context) return { context, channel };

  throw new Error(
    `无法启动浏览器（依次尝试了 chrome / msedge / 自带 chromium）：\n${problems.join("\n")}\n` +
      `若专用浏览器仍在运行，可能是另一个控制台正在使用，也可能是上次退出残留；请自行确认并关闭后重试。程序不会自动结束其他浏览器进程。\n` +
      `若都没有，运行 npx playwright install chromium 安装自带浏览器`
  );
}
