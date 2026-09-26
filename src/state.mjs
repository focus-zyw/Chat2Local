/**
 * 会话线程登记 —— 项目（站点+Host Root）→ 网页对话 URL。
 *
 * 学习过的项目在 watch/chat 重启时续接原对话（导师记得上次讲到哪，
 * 网站线程本身就是记忆）；新项目开新聊天。只存 URL 与元数据，不存
 * 对话内容——内容的事实来源始终是网页线程自己。
 */

import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

const THREADS_FILE = path.join(os.homedir(), ".file-tool", "threads.json");
const MAX_ENTRIES = 100; // 防无限膨胀：只保留最近使用的 N 个项目

function threadKey(siteId, root, role = "code") {
  // Windows 路径大小写不敏感：key 统一小写，避免 D:\x 与 d:\x 记成两个项目
  const legacy = `${siteId}|${path.resolve(root).toLowerCase()}`;
  return role === "code" ? legacy : `${legacy}|role:${role}`;
}

/** 文件路径与文件系统可注入，供临时目录中的故障测试使用。 */
export function createThreadStore(file = THREADS_FILE, io = fs) {
  function load() {
    let raw;
    try {
      raw = io.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return {};
      throw new Error("历史聊天登记读取失败；请检查本地文件权限，程序不会覆盖现有登记", { cause: err });
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* 格式错误统一提示，原文件保持不变 */ }
    throw new Error("历史聊天登记文件格式错误；请备份并检查，程序不会覆盖它");
  }

  function save(map) {
    const entries = Object.entries(map)
      .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
      .slice(0, MAX_ENTRIES);
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    let created = false;
    try {
      fd = io.openSync(temporary, "wx", 0o600);
      created = true;
      io.writeFileSync(fd, JSON.stringify(Object.fromEntries(entries), null, 2), "utf8");
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, file); // 同目录替换，写入中断时旧文件仍完整
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      if (created) {
        try { io.unlinkSync(temporary); } catch (err) { if (err?.code !== "ENOENT") throw err; }
      }
    }
  }

  function getThread(siteId, root, role = "code") {
    return load()[threadKey(siteId, root, role)] ?? null;
  }

  function saveThread(siteId, root, url, role = "code") {
    const map = load();
    map[threadKey(siteId, root, role)] = {
      url,
      site: siteId,
      root: path.resolve(root),
      updatedAt: Date.now(),
    };
    save(map);
  }

  function clearThread(siteId, root, role = "code") {
    const map = load();
    const key = threadKey(siteId, root, role);
    if (!(key in map)) return false;
    delete map[key];
    save(map);
    return true;
  }

  return { getThread, saveThread, clearThread };
}

const defaultStore = createThreadStore();
export const getThread = defaultStore.getThread;
export const saveThread = defaultStore.saveThread;
export const clearThread = defaultStore.clearThread;
