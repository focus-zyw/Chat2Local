/**
 * 进程树终止 —— host-actions 的 run 与 mcp-client 共用。
 * 独立成模块避免两者互相引用形成循环依赖。
 *
 * 超时/收尾时终止整个进程树：被终止的脚本可能派生服务或 watcher，
 * 只 kill 子进程本身会留下孤儿（Windows 上尤其常见）。
 */

import { spawn } from "node:child_process";
import process from "node:process";

export function terminateProcessTree(child) {
  return new Promise((resolve) => {
    if (!child?.pid) return resolve();
    if (process.platform !== "win32") {
      try {
        // 非 Windows 子进程以独立进程组启动，负 PID 会终止整个组。
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      return resolve();
    }

    let finished = false;
    let killer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallbackTimer);
      resolve();
    };
    const fallback = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    };
    const fallbackTimer = setTimeout(() => {
      try {
        killer?.kill();
      } catch {
        /* already gone */
      }
      fallback();
    }, 5000);
    try {
      killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", fallback);
      killer.once("close", finish);
    } catch {
      fallback();
    }
  });
}
