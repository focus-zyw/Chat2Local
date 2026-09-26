/** 本地控制台：只负责 watch 会话的启动、暂停、恢复与停止。 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launchBrowser } from "./browser.mjs";
import { createDriver } from "./page-driver.mjs";
import { reconnectPayload, conversationIntroPayload, ROLE_IDS } from "./protocol.mjs";
import { getThread, saveThread } from "./state.mjs";
import { SITES } from "./sites.mjs";
import { startWatcher } from "./watcher.mjs";
import { watchCheckpointStore, assertOtherRoleClear } from "./watch-checkpoint.mjs";

// 控制台记住上次成功启动的 项目目录 + 站点，下次作为默认值
const LAST_FILE = path.join(os.homedir(), ".file-tool", "console-last.json");

async function readLast() {
  try {
    const parsed = JSON.parse(await fs.readFile(LAST_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveLast(siteId, root, role = "code") {
  try {
    await fs.mkdir(path.dirname(LAST_FILE), { recursive: true });
    await fs.writeFile(
      LAST_FILE,
      JSON.stringify({ siteId, root, role, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* 记忆失败不影响启动 */
  }
}

const PAGE_FILES = new Map([
  ["/", { file: new URL("./control-ui/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/control.js", { file: new URL("./control-ui/control.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/control.css", { file: new URL("./control-ui/control.css", import.meta.url), type: "text/css; charset=utf-8" }],
]);

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function respond(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { ...COMMON_HEADERS, "Content-Type": type });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function sameToken(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw new Error("请求必须使用 JSON");
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (raw.length > 8192) throw new Error("请求过长");
  }
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("请求 JSON 无效");
  }
}

async function checkedRoot(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("请填写项目目录");
  const root = path.resolve(input.trim());
  let stat;
  try { stat = await fs.stat(root); } catch { throw new Error("项目目录不存在"); }
  if (!stat.isDirectory()) throw new Error("项目路径不是目录");
  return root;
}

function sameConversationUrl(actual, expected) {
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
  } catch {
    return false;
  }
}

export function validThreadUrl(siteId, url) {
  try {
    const thread = new URL(url);
    const home = new URL(SITES[siteId].url);
    return thread.protocol === "https:" && !thread.username && !thread.password &&
      thread.origin === home.origin && !sameConversationUrl(url, home.href);
  } catch {
    return false;
  }
}

/**
 * 目录浏览（控制台"浏览…"按钮的后端）：
 * 无 path 时 Windows 枚举盘符（其他平台从用户主目录开始）；
 * 有 path 时列出其下子目录（只返回目录，不返回文件内容）。
 */
export async function listDirectories(inputPath) {
  if (!inputPath) {
    if (process.platform === "win32") {
      const entries = [];
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        const drive = `${letter}:\\`;
        try {
          await fs.access(drive);
          entries.push({ name: drive, path: drive, dir: true });
        } catch {
          /* 该盘符不存在 */
        }
      }
      return { current: "", parent: null, entries, drives: true };
    }
    inputPath = os.homedir();
  }
  let current = path.resolve(inputPath);
  try {
    const st = await fs.stat(current);
    if (!st.isDirectory()) current = path.dirname(current);
  } catch {
    return { error: "路径不存在" };
  }
  let names;
  try {
    names = await fs.readdir(current, { withFileTypes: true });
  } catch (err) {
    return { error: err.message };
  }
  const parent = path.dirname(current);
  return {
    current,
    parent: parent === current ? null : parent,
    entries: names
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(current, e.name), dir: true }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function startControlServer({
  port = 0,
  defaultRoot = "",
  defaultSiteId = "",
  defaultRole = "",
  autostart = null, // {root, siteId} —— 服务就绪后自动启动会话
  launchBrowserFn = launchBrowser,
  createDriverFn = createDriver,
  startWatcherFn = startWatcher,
  getThreadFn = getThread,
  saveThreadFn = saveThread,
  checkpointStore = watchCheckpointStore,
  healthCheckMs = 3000,
} = {}) {
  const token = randomBytes(32).toString("base64url");
  const state = {
    phase: "idle", siteId: "", root: "", role: "code", channel: "", error: "", events: [],
    health: { state: "stopped", reason: "尚未启动", checkedAt: null },
  };
  let session = null;
  let startTask = null;
  let stopRequested = false;
  let origin = "";
  let lastHealthAt = 0;
  let healthTask = null;

  const log = (message) => {
    state.events.push({ at: new Date().toISOString(), text: String(message) });
    if (state.events.length > 80) state.events.shift();
  };
  const status = () => ({ ...state, events: [...state.events] });

  const setHealth = (kind, reason) => {
    state.health = { state: kind, reason, checkedAt: new Date().toISOString() };
    lastHealthAt = Date.now();
  };

  async function refreshHealth(force = false) {
    if (healthTask) return healthTask;
    if (!force && Date.now() - lastHealthAt < healthCheckMs) return;
    const current = session;
    if (!current || state.phase === "idle" || state.phase === "stopping") {
      setHealth("stopped", "专用浏览器未运行");
      return;
    }
    if (!current.driver?.probe) {
      setHealth("unknown", "暂时无法检查网页输入框");
      return;
    }
    healthTask = (async () => {
      let timer;
      try {
        const probe = await Promise.race([
          Promise.resolve().then(() => current.driver.probe()),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ state: "unknown", reason: "timeout" }), 1500); }),
        ]);
        if (session !== current || current.closed || state.phase === "stopping") return;
        if (probe?.state === "healthy") setHealth("healthy", probe.summary || "网页输入框可用");
        else if (probe?.state === "stopped") setHealth("stopped", "专用网页已关闭");
        else if (probe?.summary) setHealth("unknown", `${probe.summary}。建议：${probe.advice || "稍候重试"}`);
        else if (probe?.reason === "no-composer") setHealth("unknown", "找不到输入框：可能未登录或站点已改版");
        else setHealth("unknown", "暂时无法确认网页状态；不会自动关闭浏览器");
      } catch {
        if (session === current) setHealth("unknown", "网页检查失败；不会自动关闭浏览器");
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { healthTask = null; });
    return healthTask;
  }

  async function runStart(siteId, root, role) {
    const current = { context: null, watcher: null, driver: null, checkpoint: null, closed: false, closingForCleanup: false };
    let failure = null;
    session = current;
    try {
      const launched = await launchBrowserFn({ headless: false });
      current.context = launched.context;
      state.channel = launched.channel;
      setHealth("unknown", "正在检查专用网页");
      current.context.on("close", () => {
        current.closed = true;
        if (current.closingForCleanup) {
          setHealth("stopped", "专用浏览器已关闭");
          return;
        }
        if (stopRequested || session !== current) return;
        stopRequested = true;
        state.phase = "error";
        state.error = "专用浏览器已关闭；请重新启动会话";
        setHealth("stopped", "专用浏览器已关闭");
        log(state.error);
        Promise.resolve(current.watcher?.()).catch(() => {}).finally(() => {
          if (session === current) session = null;
        });
      });
      if (stopRequested) return;

      // 按站点与项目读取历史线程；仅允许回到该站点自己的 HTTPS 地址。
      const prior = getThreadFn(siteId, root, role);
      const saved = prior && validThreadUrl(siteId, prior.url) ? prior : null;
      if (prior && !saved) throw new Error("历史聊天地址无效，已保留登记；请检查后重试，或用命令行 watch --new 新建聊天");
      if (!saved) log("未找到所选网站和项目的历史聊天登记，将建立新聊天；如需找回旧聊天，请先绑定其地址。");
      const driver = await createDriverFn({ context: current.context, siteId, log, startUrl: saved?.url });
      current.driver = driver;
      await driver.markTab();
      await refreshHealth(true);
      if (stopRequested) return;
      let intro;
      if (saved) {
        if (!sameConversationUrl(driver.currentUrl?.(), saved.url)) {
          throw new Error("历史聊天未能打开，已保留登记；请检查登录状态后重试，或用命令行 watch --new 新建聊天");
        }
      }
      // 恢复检查先于任何重连消息；否则新回复可能遮住中断时的动作。
      current.checkpoint = checkpointStore.forThread(siteId, root, saved?.url || driver.currentUrl?.() || "", role);
      const previous = current.checkpoint.read();
      if (previous?.phase === "mismatch-pending") {
        throw new Error("所选项目的旧聊天有未确认动作；请先绑定原聊天地址，再启动核对");
      }
      if (previous && previous.phase !== "processed") {
        if (!saved) throw new Error("上次动作未确认且旧聊天地址未登记；请先绑定原聊天地址，再启动核对");
        state.phase = "recovery";
        state.error = "上次动作可能已执行或回填未确认。请在专用浏览器检查原聊天，确认后点击“已核对，继续旁观”；不会重跑或重发上次动作。";
        log("检测到未确认的 watch 断点；已打开原聊天，自动动作保持停止。请先人工核对。");
        return;
      }
      if (saved) {
        log("已打开该项目的历史聊天，正在续接。");
        intro = await driver.send(reconnectPayload(root, role));
        if (!intro.ok) throw new Error(`历史聊天续接失败：${intro.error || "未知原因"}；已保留登记，可稍后重试`);
      }
      if (!intro) intro = await driver.send(conversationIntroPayload(root, role, true));
      if (!intro.ok) log(`开场白未送达：${intro.error || "未知原因"}。可在网页里手动发送。`);
      if (stopRequested) return;
      if (intro.ok) {
        let url = "";
        try { url = driver.currentUrl?.() || ""; } catch { /* 下方统一提示地址无效 */ }
        if (!validThreadUrl(siteId, url)) throw new Error("尚未取得有效聊天线程地址；无法安全保存 watch 断点，请检查网站状态后重试");
        try {
          if (role === "code") saveThreadFn(siteId, root, url);
          else saveThreadFn(siteId, root, url, role);
        }
        catch { throw new Error("聊天线程地址保存失败；为避免中断后无法找回，本次不启动自动动作"); }
        current.checkpoint = checkpointStore.forThread(siteId, root, url, role);
      } else {
        throw new Error("开场白未送达；为避免在未登记的聊天执行动作，本次不启动旁观");
      }

      current.watcher = await startWatcherFn({
        driver, root, role, log, checkpoint: current.checkpoint,
        onFatal: (message) => { state.phase = "error"; state.error = message; },
        onReply: (text) => log(`新讲解回复（${text.length} 字符）`),
      });
      if (stopRequested) return;
      state.phase = "running";
      log("旁观执行已启动；请在标题带〔file-tool〕的专用浏览器窗口聊天。");
    } catch (err) {
      failure = err;
    } finally {
      if (!["running", "paused", "pausing", "recovery"].includes(state.phase)) {
        if (current.watcher) await current.watcher();
        current.closingForCleanup = true;
        if (current.context) await current.context.close().catch(() => {});
        if (session === current) session = null;
      }
      if (failure && !stopRequested) {
        state.error = `启动失败：${failure?.message || failure}`;
        state.phase = "error";
        log(state.error);
      }
    }
  }

  async function stopSession() {
    if (state.phase === "idle") return;
    stopRequested = true;
    state.phase = "stopping";
    if (session?.watcher) await session.watcher();
    if (session?.context) await session.context.close().catch(() => {});
    if (startTask) await startTask;
    session = null;
    state.phase = "idle";
    state.error = "";
    state.channel = "";
    setHealth("stopped", "专用浏览器未运行");
    log("已停止旁观执行并关闭专用浏览器。");
  }

  /** /api/start 与 --autostart 共用的会话启动入口。返回 {status, payload}。 */
  async function startSession(siteIdRaw, rootRaw, roleRaw = "code") {
    if ((state.phase !== "idle" && state.phase !== "error") || session || startTask) {
      return { status: 409, payload: { error: "已有会话正在运行" } };
    }
    if (typeof siteIdRaw !== "string" || !Object.hasOwn(SITES, siteIdRaw)) {
      return { status: 400, payload: { error: "请选择支持的聊天网站" } };
    }
    if (!ROLE_IDS.includes(roleRaw)) {
      return { status: 400, payload: { error: "请选择支持的任务角色" } };
    }
    const root = await checkedRoot(rootRaw);
    assertOtherRoleClear(checkpointStore, siteIdRaw, root, roleRaw);
    stopRequested = false;
    state.phase = "starting";
    setHealth("unknown", "正在启动专用浏览器");
    state.siteId = siteIdRaw;
    state.root = root;
    state.role = roleRaw;
    state.error = "";
    state.events = [];
    log(roleRaw === "text" ? "正在启动专用浏览器并发送文本问答开场白…" : "正在启动专用浏览器并发送导师开场白…");
    await saveLast(siteIdRaw, root, roleRaw);
    startTask = runStart(siteIdRaw, root, roleRaw).finally(() => { startTask = null; });
    return { status: 202, payload: status() };
  }

  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== host) return respond(res, 403, { error: "访问地址无效" });
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; }
    catch { return respond(res, 400, { error: "请求地址无效" }); }

    if (req.method === "GET" && PAGE_FILES.has(pathname)) {
      const page = PAGE_FILES.get(pathname);
      try { return respond(res, 200, await fs.readFile(page.file, "utf8"), page.type); }
      catch { return respond(res, 500, { error: "控制台页面读取失败" }); }
    }
    if (req.method === "GET" && pathname === "/api/bootstrap") {
      const last = await readLast();
      return respond(res, 200, {
        token,
        root: defaultRoot || last.root || process.cwd(),
        siteId: defaultSiteId || last.siteId || "",
        role: defaultRole || last.role || "code",
        roles: [{ id: "code", label: "代码导师" }, { id: "text", label: "文本目录问答" }],
        sites: Object.entries(SITES).map(([id, site]) => ({ id, label: site.label })),
      });
    }
    if (req.method === "GET" && pathname === "/api/status") {
      await refreshHealth();
      return respond(res, 200, status());
    }
    const isBrowse = req.method === "GET" && pathname === "/api/browse";
    if (req.method !== "POST" && !isBrowse) {
      return respond(res, 404, { error: "页面不存在" });
    }
    if (req.headers.origin !== origin || !sameToken(req.headers["x-file-tool-token"], token)) {
      return respond(res, 403, { error: "请求来源无效" });
    }
    if (isBrowse) {
      const query = new URL(req.url, origin).searchParams;
      const data = await listDirectories(query.get("path"));
      return respond(res, data.error ? 400 : 200, data);
    }

    try {
      const body = await readBody(req);
      if (pathname === "/api/thread-status") {
        if (typeof body.siteId !== "string" || !Object.hasOwn(SITES, body.siteId)) {
          return respond(res, 400, { error: "请选择支持的聊天网站" });
        }
        const root = await checkedRoot(body.root);
        const role = body.role ?? "code";
        if (!ROLE_IDS.includes(role)) return respond(res, 400, { error: "请选择支持的任务角色" });
        const saved = getThreadFn(body.siteId, root, role);
        return respond(res, 200, {
          registered: Boolean(saved),
          valid: Boolean(saved && validThreadUrl(body.siteId, saved.url)),
        });
      }
      if (pathname === "/api/bind-thread") {
        if ((state.phase !== "idle" && state.phase !== "error") || session || startTask) {
          return respond(res, 409, { error: "请先结束当前会话，再绑定旧聊天" });
        }
        if (typeof body.siteId !== "string" || !Object.hasOwn(SITES, body.siteId)) {
          return respond(res, 400, { error: "请选择支持的聊天网站" });
        }
        const root = await checkedRoot(body.root);
        const role = body.role ?? "code";
        if (!ROLE_IDS.includes(role)) return respond(res, 400, { error: "请选择支持的任务角色" });
        const url = typeof body.url === "string" ? body.url.trim() : "";
        if (!validThreadUrl(body.siteId, url)) {
          const matched = Object.entries(SITES).find(([siteId]) => validThreadUrl(siteId, url));
          if (matched) {
            return respond(res, 400, {
              error: `这个链接属于 ${matched[1].label}，当前选择的是 ${SITES[body.siteId].label}；请先切换聊天网站。`,
            });
          }
          return respond(res, 400, { error: "聊天地址必须是所选网站的 HTTPS 对话链接，不能是首页或其他网站" });
        }
        try { saveThreadFn(body.siteId, root, new URL(url).href, role); }
        catch { return respond(res, 500, { error: "保存聊天地址失败，请检查本地权限" }); }
        log("旧聊天已绑定到所选项目；点击启动旁观执行即可续接。");
        return respond(res, 200, status());
      }
      if (pathname === "/api/start") {
        const { status, payload } = await startSession(body.siteId, body.root, body.role ?? "code");
        return respond(res, status, payload);
      }
      if (pathname === "/api/confirm-recovery") {
        if (state.phase !== "recovery" || !session?.checkpoint || !session.driver) {
          return respond(res, 409, { error: "当前没有待核对的中断动作" });
        }
        session.checkpoint.acknowledge();
        session.watcher = await startWatcherFn({
          driver: session.driver, root: state.root, role: state.role, log, checkpoint: session.checkpoint,
          onFatal: (message) => { state.phase = "error"; state.error = message; },
          onReply: (text) => log(`新讲解回复（${text.length} 字符）`),
        });
        state.phase = "running";
        state.error = "";
        log("已人工核对并继续旁观；上次动作及结果不会自动重跑或重发。");
        return respond(res, 200, status());
      }
      if (pathname === "/api/pause") {
        if (state.phase !== "running" || !session?.watcher?.pause) {
          return respond(res, 409, { error: "当前会话不能暂停" });
        }
        state.phase = "pausing";
        await session.watcher.pause();
        if (state.phase === "pausing") {
          state.phase = "paused";
          log("已暂停：专用浏览器仍保持打开，新的本地动作暂不执行。");
        }
        return respond(res, 200, status());
      }
      if (pathname === "/api/resume") {
        if (state.phase !== "paused" || !session?.watcher?.resume) {
          return respond(res, 409, { error: "当前会话不能恢复" });
        }
        session.watcher.resume();
        state.phase = "running";
        log("已恢复旁观执行，沿用当前网页会话。");
        return respond(res, 200, status());
      }
      if (pathname === "/api/stop") {
        await stopSession();
        return respond(res, 200, status());
      }
      return respond(res, 404, { error: "操作不存在" });
    } catch (err) {
      return respond(res, 400, { error: err?.message || "请求失败" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/`,
    origin,
    /** 供 CLI --autostart 直接启动会话（与 /api/start 同一入口）。 */
    startSession,
    async close() {
      await stopSession();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
