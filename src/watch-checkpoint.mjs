/** watcher 断点：仅保存处理阶段和回复指纹，不落网页正文、动作或执行结果。 */

import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_FILE = path.join(os.homedir(), ".file-tool", "watch-checkpoints.json");
const MAX_ENTRIES = 100;
const PHASES = new Set(["executing", "delivering", "processed"]);

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

/** 与 watcher 既有的“相同文本视为同一回复”规则一致，避免页面重排造成重跑。 */
export function replyFingerprint(snapshot) {
  return hash(String(snapshot?.text ?? ""));
}

function projectKey(siteId, root, role = "code") {
  const resolved = path.resolve(root);
  const legacy = `${siteId}|${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
  return role === "code" ? legacy : `${legacy}|role:${role}`;
}

/** 文件与 I/O 可注入，故障测试不会触碰真实项目的登记。 */
export function createWatchCheckpointStore(file = DEFAULT_FILE, io = fs) {
  function load() {
    let raw;
    try { raw = io.readFileSync(file, "utf8"); }
    catch (err) {
      if (err?.code === "ENOENT") return {};
      throw new Error("watch 断点读取失败；不会继续自动执行动作", { cause: err });
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object" &&
          !Array.isArray(parsed.entries)) return parsed.entries;
    } catch { /* 格式错误统一处理 */ }
    throw new Error("watch 断点文件格式错误；已保留原文件，不会继续自动执行动作");
  }

  function save(entries) {
    // 未确认动作不能因使用了更多项目而被淘汰；只裁剪已完成的旧记录。
    const all = Object.entries(entries);
    const pending = all.filter(([, value]) => value?.phase !== "processed");
    const finished = all.filter(([, value]) => value?.phase === "processed")
      .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
      .slice(0, Math.max(0, MAX_ENTRIES - pending.length));
    const limited = Object.fromEntries([...pending, ...finished]);
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    let created = false;
    try {
      fd = io.openSync(temporary, "wx", 0o600);
      created = true;
      io.writeFileSync(fd, JSON.stringify({ version: 1, entries: limited }, null, 2), "utf8");
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, file);
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      if (created) {
        try { io.unlinkSync(temporary); }
        catch (err) { if (err?.code !== "ENOENT") throw err; }
      }
    }
  }

  function forThread(siteId, root, url, role = "code") {
    const key = projectKey(siteId, root, role);
    const urlHash = hash(url);
    function read() {
      const entry = load()[key];
      if (!entry) return null;
      if (!PHASES.has(entry.phase) || !/^[a-f0-9]{64}$/.test(entry.replyId || "") ||
          !/^[a-f0-9]{64}$/.test(entry.urlHash || "")) {
        throw new Error("watch 断点记录无效；不会继续自动执行动作");
      }
      if (entry.urlHash !== urlHash) {
        return entry.phase === "processed" ? null : { phase: "mismatch-pending" };
      }
      return entry;
    }
    function write({ phase, replyId, actionIndex = 0, actionCount = 0 }) {
      if (!PHASES.has(phase) || !/^[a-f0-9]{64}$/.test(replyId || "") ||
          !Number.isSafeInteger(actionIndex) || actionIndex < 0 ||
          !Number.isSafeInteger(actionCount) || actionCount < 0 || actionIndex > actionCount) {
        throw new Error("watch 断点参数无效");
      }
      const entries = load();
      const previous = entries[key];
      if (previous && previous.urlHash !== urlHash && previous.phase !== "processed") {
        throw new Error("所选项目的另一聊天尚有未确认动作；请先核对旧聊天");
      }
      entries[key] = { urlHash, phase, replyId, actionIndex, actionCount, updatedAt: Date.now() };
      save(entries);
    }
    function acknowledge() {
      const previous = read();
      if (!previous || previous.phase === "processed") return false;
      if (previous.phase === "mismatch-pending") {
        throw new Error("断点属于另一个聊天；请先恢复原聊天登记");
      }
      write({ phase: "processed", replyId: previous.replyId,
        actionIndex: previous.actionIndex, actionCount: previous.actionCount });
      return true;
    }
    return { read, write, acknowledge };
  }

  return { forThread };
}

export const watchCheckpointStore = createWatchCheckpointStore();

/** 切换角色不应绕过另一角色尚未人工核对的动作。 */
export function assertOtherRoleClear(store, siteId, root, role) {
  const other = role === "text" ? "code" : "text";
  const checkpoint = store.forThread(siteId, root, "", other).read();
  if (checkpoint && checkpoint.phase !== "processed") {
    throw new Error("另一任务角色有未确认的 watch 动作；请切回原角色，在原聊天人工核对后再启动");
  }
}
