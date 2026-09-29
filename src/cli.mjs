#!/usr/bin/env node
/**
 * Chat2Local CLI
 *
 *   node src/cli.mjs setup                       启动专用浏览器登录聊天网站（一次）
 *   node src/cli.mjs list                        列出支持的站点
 *   node src/cli.mjs ask <site> "<task>" [--root <dir>] [--rounds N]
 *                                                [--minutes N] [--watch N] [--headless] [--diagnose]
 *
 * 示例：
 *   node src/cli.mjs ask deepseek "跑一遍 tests/ 里的测试，总结哪些失败、为什么"
 *   node src/cli.mjs ask chatgpt "读 package.json 和 src/，给出项目结构说明" --root D:\my-project
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { launchBrowser } from "./browser.mjs";
import { createDriver } from "./page-driver.mjs";
import { orchestrate, runTurn } from "./loop.mjs";
import {
  conversationIntroPayload,
  reconnectPayload,
  compressPayload,
  mcpSyncPayload,
  mcpToolCatalogLine,
  ROLE_IDS,
  roleDefinition,
} from "./protocol.mjs";
import { stripActionBlocks } from "./parse.mjs";
import { runAction, isMcpWriteTool } from "./host-actions.mjs";
import { createWriteGate } from "./write-gate.mjs";
import { createMcpClient, MCP_TOOLS_MAX } from "./mcp-client.mjs";
import { startWatcher } from "./watcher.mjs";
import { watchCheckpointStore, assertOtherRoleClear, replyFingerprint } from "./watch-checkpoint.mjs";
import { startControlServer, validThreadUrl } from "./control-server.mjs";
import { getThread, saveThread, clearThread, saveSummary, takeSummary } from "./state.mjs";
import { resolveSite, SITE_IDS, SITES } from "./sites.mjs";
import { pathToFileURL } from "node:url";

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1 || !argv[i + 1]) return fallback;
  return argv[i + 1];
}

function usageError(message) {
  const err = new Error(message);
  err.code = "CLI_USAGE";
  return err;
}

/** 读取正数选项；非法输入必须在启动浏览器前失败，避免意外关闭预算。 */
export function positiveNumberArg(argv, flag, fallback, { integer = false } = {}) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const raw = argv[i + 1];
  const value = Number(raw);
  const kind = integer ? "正整数" : "大于 0 的数字";
  if (!raw || raw.startsWith("--") || !Number.isFinite(value) || value <= 0) {
    throw usageError(`选项 ${flag} 必须是${kind}，收到：${raw ?? "(缺失)"}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw usageError(`选项 ${flag} 必须是${kind}，收到：${raw}`);
  }
  return value;
}

/** Host Root 必须明确指向一个已存在目录，避免浏览器启动后才发现路径无效。 */
export function rootDirArg(argv, fallback = process.cwd()) {
  const i = argv.indexOf("--root");
  const raw = i === -1 ? fallback : argv[i + 1];
  if (!raw || raw.startsWith("--")) {
    throw usageError(`选项 --root 必须提供目录路径，收到：${raw ?? "(缺失)"}`);
  }
  const root = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw usageError(`Host Root 不存在：${root}`);
  }
  if (!stat.isDirectory()) {
    throw usageError(`Host Root 不是目录：${root}`);
  }
  return root;
}

/**
 * 解析 watch 的 --mcp 桥接配置：--mcp <node 脚本> + 可重复的 --mcp-arg <值>
 * 或 --mcp-arg=<值>（等号形式可传以 -- 开头的 server 旗标，如 --headless）。
 * server 脚本是用户指定的信任边界（模型只能选工具名和参数，永远不能选
 * server 或命令），所以脚本必须已存在且是 Node 可运行类型；返回 null 表示
 * 未配置。cwd 取 Host Root，server 自行用它约束工具入参的路径语义。
 */
export function mcpSpecArg(argv, root) {
  const i = argv.indexOf("--mcp");
  if (i === -1) return null;
  const script = argv[i + 1];
  if (!script || script.startsWith("--")) {
    throw usageError(`选项 --mcp 需要本地 MCP server 脚本路径（.mjs/.js/.cjs），收到：${script ?? "(缺失)"}`);
  }
  const ext = path.extname(script).toLowerCase();
  if (![".mjs", ".js", ".cjs"].includes(ext)) {
    throw usageError(`--mcp 只支持 Node 脚本（.mjs/.js/.cjs），收到：${script}`);
  }
  const abs = path.resolve(script);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw usageError(`--mcp 脚本不存在：${abs}`);
  }
  if (!stat.isFile()) throw usageError(`--mcp 不是文件：${abs}`);
  const args = [];
  for (let j = 0; j < argv.length; j++) {
    if (argv[j] === "--mcp-arg") {
      const value = argv[j + 1];
      if (value == null || value.startsWith("--")) {
        throw usageError(`选项 --mcp-arg 需要一个值（传给 MCP server 的参数，可重复）；以 -- 开头的 server 旗标请用 --mcp-arg=<值> 形式`);
      }
      args.push(value);
    } else if (argv[j]?.startsWith("--mcp-arg=")) {
      const value = argv[j].slice("--mcp-arg=".length);
      if (!value) throw usageError("选项 --mcp-arg=<值> 的值不能为空");
      args.push(value);
    }
  }
  return { command: process.execPath, args: [abs, ...args], cwd: root, script: abs };
}

/** 解析可重复的 --mcp-allow <工具名>：显式授权的工具子集；未提供返回 null。 */
export function mcpAllowArg(argv) {
  const names = [];
  for (let j = 0; j < argv.length; j++) {
    if (argv[j] === "--mcp-allow") {
      const value = argv[j + 1];
      if (value == null || value.startsWith("--")) {
        throw usageError(`选项 --mcp-allow 需要工具名（可重复），收到：${value ?? "(缺失)"}`);
      }
      names.push(value);
    } else if (argv[j]?.startsWith("--mcp-allow=")) {
      const value = argv[j].slice("--mcp-allow=".length);
      if (!value) throw usageError("选项 --mcp-allow=<工具名> 的值不能为空");
      names.push(value);
    }
  }
  return names.length ? names : null;
}

/**
 * 探测结果 → 会话工具目录与允许列表：开场白展示多少个工具，执行端就只放行
 * 多少个——展示、授权、执行共用同一份目录。explicitAllow（--mcp-allow）给出
 * 时只授权这些工具（取交集，用户显式授权优先于 server 自报顺序）；探测失败
 * 或目录为空返回 null，调用方不得注入桥接执行器（此时 mcp 动作按未配置处理）。
 */
export function mcpCatalogArg(listed, explicitAllow = null) {
  const probed = (Array.isArray(listed?.tools) ? listed.tools : []).filter(
    (t) => t && typeof t.name === "string" && mcpToolCatalogLine(t) !== null
  );
  let tools;
  let dropped = [];
  if (Array.isArray(explicitAllow)) {
    // 显式授权：按用户给出的顺序取交集；server 有但未点名的不授权
    tools = explicitAllow
      .map((name) => probed.find((t) => t.name === name))
      .filter(Boolean)
      .slice(0, MCP_TOOLS_MAX);
    const chosen = new Set(tools.map((t) => t.name));
    dropped = [
      ...explicitAllow.filter((n) => !probed.some((t) => t.name === n) && !chosen.has(n)),
      ...probed.filter((t) => !chosen.has(t.name)).map((t) => t.name),
    ];
  } else {
    tools = probed.slice(0, MCP_TOOLS_MAX);
    dropped = probed.slice(MCP_TOOLS_MAX).map((t) => t.name);
  }
  if (tools.length === 0) return null;
  return { tools, allow: tools.map((t) => t.name), dropped };
}

/**
 * 续接旧聊天时同步本次能力目录。空目录同样必须送达，才能撤销历史授权认知。
 * 失败时由调用方停止启动 watcher，避免目录尚未确认却启用 MCP 执行器。
 */
export async function syncMcpCatalog(driver, resumed, catalog) {
  if (!resumed) return { ok: true, synced: false };
  try {
    const result = await driver.deliver(mcpSyncPayload(catalog?.tools ?? []));
    if (!result?.ok) {
      return { ok: false, synced: false, error: result?.error || "未知原因" };
    }
    return { ok: true, synced: true };
  } catch (err) {
    return { ok: false, synced: false, error: err?.message || "未知原因" };
  }
}

/** watch 的目录授权与网页同步：回调在首次发现前安装，授权只缩不扩。
 * 更新期间暂停 watcher；同步失败时保留人工核对断点并结束旁观。 */
export function createMcpCatalogController({ client, driver, explicitAllow, checkpoint, log = () => {}, onCatalogChange = () => {}, onFailure = () => {}, mayResume = () => true }) {
  let currentCheckpoint = checkpoint;
  let catalog = null;
  let initialized = false;
  let pendingTools = null;
  let revision = 0;
  let syncedRevision = 0;
  let watcher = null;
  let active = false;
  let failed = false;
  let syncTask = null;

  const markUnconfirmed = () => {
    const prior = currentCheckpoint?.read();
    if (prior && prior.phase !== "processed") return; // 保留在途动作的更具体断点
    currentCheckpoint?.write({ phase: "catalog-sync", replyId: replyFingerprint({ text: mcpSyncPayload(catalog?.tools ?? []) }) });
  };
  const rebuild = (tools) => {
    const previous = catalog?.allow ?? [];
    const rebuilt = mcpCatalogArg({ ok: true, tools }, explicitAllow);
    const allow = rebuilt ? rebuilt.allow.filter((name) => previous.includes(name)) : [];
    catalog = { tools: rebuilt ? rebuilt.tools.filter((tool) => allow.includes(tool.name)) : [], allow, dropped: [] };
    onCatalogChange(catalog);
    revision += 1;
    if (allow.length < previous.length) log(`MCP 工具目录收缩（授权：${allow.join("、") || "无"}）`);
    if (active) scheduleSync();
  };
  client.onCatalogUpdate = (tools) => {
    if (!initialized) pendingTools = tools;
    else rebuild(tools);
  };

  const fail = async (error) => {
    if (failed) return;
    failed = true;
    watcher?.signal?.();
    try { await watcher?.(); }
    catch (err) { log(`watcher 收尾失败：${err?.message || err}`); }
    let checkpointError = "";
    try { markUnconfirmed(); }
    catch (err) { checkpointError = `；断点保存失败：${err?.message || err}`; }
    const message = `mcp 工具目录同步失败或发送状态不明（${error}）。已停止旁观执行${checkpointError}；请在原聊天人工核对能力更新是否送达后再继续`;
    log(message);
    try { onFailure(message); } catch (err) { log(`停止输入失败：${err?.message || err}`); }
    return message;
  };
  const syncLatest = async () => {
    while (revision !== syncedRevision && !failed) {
      const target = revision;
      const result = await syncMcpCatalog(driver, true, catalog);
      if (!result.ok) {
        await fail(result.error);
        return;
      }
      syncedRevision = target;
      log("已向原聊天同步当前 mcp 工具目录。");
    }
  };
  function scheduleSync() {
    if (syncTask || failed || !watcher || watcher.isStopped?.()) return;
    syncTask = (async () => {
      const wasPaused = watcher.isPaused?.() ?? false;
      await watcher.pause(); // 当前动作/回填结束后，才发送目录更新
      if (watcher.isStopped?.()) return;
      await syncLatest();
      if (!wasPaused && !failed && mayResume()) watcher.resume();
    })().catch(async (err) => { await fail(err?.message || "未知原因"); })
      .finally(() => {
        syncTask = null;
        if (active && revision !== syncedRevision && !failed) scheduleSync();
      });
  }

  return {
    setCheckpoint(value) { currentCheckpoint = value; },
    get catalog() { return catalog; },
    get revision() { return revision; },
    get failed() { return failed; },
    get syncing() { return Boolean(syncTask); },
    initialize(listed) {
      catalog = mcpCatalogArg(listed?.ok && pendingTools ? { ok: true, tools: pendingTools } : listed, explicitAllow);
      onCatalogChange(catalog);
      initialized = true;
      pendingTools = null;
      return catalog;
    },
    async syncBeforeWatch(resumed, introRevision) {
      // 新聊天的开场白已包含当时的目录；其发送期间若目录变化，补发最新目录。
      syncedRevision = introRevision;
      if (resumed) syncedRevision = -1;
      await syncLatest();
      if (failed) throw new Error("mcp 工具目录同步失败；请人工核对原聊天后再继续");
    },
    attachWatcher(stop) {
      watcher = stop;
      active = true;
      if (revision !== syncedRevision) scheduleSync();
    },
    async waitForSync() { await syncTask; },
  };
}

/** 站点名在任何浏览器动作前校验，避免输错后仍启动专用浏览器。 */
export function siteIdArg(siteId) {
  if (!resolveSite(siteId)) {
    throw usageError(
      `未知站点 "${siteId}"；可用：${SITE_IDS.join("、")}。运行 node src/cli.mjs list 查看详情`
    );
  }
  return siteId;
}

/** 解析 --role；allowed 限定该命令支持的角色（watch/console 支持全部，ask/chat 仅 code|text）。 */
export function roleIdArg(argv, allowed = ROLE_IDS) {
  const i = argv.indexOf("--role");
  if (i === -1) return "code";
  const role = argv[i + 1];
  if (!allowed.includes(role)) {
    throw usageError(`未知或不受支持的任务角色：${role ?? "(缺失)"}；可用：${allowed.join("、")}`);
  }
  return role;
}

/** ask 的任务正文；选项可在正文前后，-- 后的内容原样作为任务。 */
export function askTaskArg(argv) {
  const separator = argv.indexOf("--");
  if (separator !== -1) return argv.slice(separator + 1).join(" ").trim();
  const valueFlags = new Set(["--root", "--rounds", "--minutes", "--watch", "--role"]);
  const booleanFlags = new Set(["--headless", "--diagnose", "--audit"]);
  const words = [];
  for (let i = 1; i < argv.length; i++) {
    if (valueFlags.has(argv[i])) { i++; continue; }
    if (!booleanFlags.has(argv[i])) words.push(argv[i]);
  }
  return words.join(" ").trim();
}

const LAST_REPLY_FILE = path.join(os.homedir(), ".file-tool", "last-reply.txt");

/**
 * 按项目决定续接还是新开：有登记线程（学过）→ 打开旧对话并发短重连消息；
 * 无登记（新项目）或 --new → 返回 false，调用方发完整开场白。续接失败
 * （旧线程失效等）→ 清登记、退回站点首页，调用方同样走新聊天。
 */
async function resumeThread(driver, siteId, root, forceNew, log, role = "code") {
  const saved = forceNew ? (clearThread(siteId, root, role), null) : getThread(siteId, root, role);
  if (!saved) return { resumed: false };
  log(`该项目此前学习过（${new Date(saved.updatedAt).toLocaleString()}），续接上次对话。`);
  let sent;
  try {
    sent = await driver.send(reconnectPayload(root, role));
  } catch (err) {
    sent = { ok: false, error: err?.message || "open-failed" };
  }
  if (!sent.ok) {
    log(`续接失败：${sent.error}——清除登记，改开新聊天`);
    clearThread(siteId, root, role);
    const base = SITES[siteId]?.url;
    if (base) await driver.openUrl(base);
    return { resumed: false };
  }
  return { resumed: true, sent };
}

/** 开场白/重连成功后登记对话线程，供该项目下次续接。 */
function rememberThread(driver, siteId, root, role = "code") {
  try {
    const url = driver.currentUrl();
    const base = SITES[siteId]?.url;
    if (url && url !== base) saveThread(siteId, root, url, role);
  } catch {
    /* 登记失败不影响主流程 */
  }
}

/**
 * 自诊断：最终回复里疑似有动作块却没被执行（如站点渲染把 JSON 引号转成
 * 中文标点、代码块结构改版），解析器当成纯讲解收尾了。
 * @returns {boolean} 是否判定为可疑（调用方据此跳过后续提示）
 */
function warnUnparsedActions(reply) {
  if (!reply) return false;
  const suspicious = /```host/i.test(reply) || /["\u201c]op["\u201d]/.test(reply);
  if (!suspicious) return false;
  process.stderr.write(
    `⚠ 这条回复里疑似有动作块但未被识别执行。原始回复已存到 ${LAST_REPLY_FILE}——` +
      `打开看看 JSON 长什么样（重点查引号/冒号是否被站点转成中文标点、代码块语言标记是否丢失），反馈后可继续调整解析器。\n`
  );
  return true;
}

function printUsage() {
  process.stdout.write(`Chat2Local — 让网页聊天使用本地工具

用法:
  node src/cli.mjs setup                          启动专用浏览器，登录聊天网站后关窗即可
  node src/cli.mjs list                           列出支持的站点
  node src/cli.mjs console                        打开本地控制台，管理 watch 会话
  node src/cli.mjs watch <site> --root <dir>       旁观执行：你在网页上聊，工具自动执行 host 动作并回填
  node src/cli.mjs ask <site> "<task>" [选项]      一次性任务：派活到终态，拿回执
  node src/cli.mjs chat <site> [选项]              导师模式：交互式陪学本地项目代码

console 选项:
  --role <code|text|task> 预选任务角色；控制台页面也可切换（默认沿用上次选择）

watch 选项:
  --root <dir>     要学习的项目目录（必填其一，默认当前目录）
  --role <code|text|task> 任务角色：代码导师、文本问答或任务执行（默认 code）
  --new            不续接旧对话，强制开新聊天（清除该项目的线程登记）
  --confirm-recovery  核对中断前动作后继续；不会重跑或重发上次动作
  --mcp <script>   桥接本地 MCP server（Node 脚本，stdio JSON-RPC）；网页可用 {"op":"mcp","tool":"…","args":{…}} 调用其工具
  --mcp-arg <v>    传给 MCP server 的参数，可重复；--mcp-arg=<v> 形式可传以 -- 开头的旗标（如 --headless）
  --mcp-allow <t>  显式授权的工具子集，可重复；未提供时默认授权目录前 ${MCP_TOOLS_MAX} 个

watch 终端命令: 输入 暂停(pause)/恢复(resume) 控制旁观；压缩(compact)/保存摘要 线程摘要；写入模式 询问|风险|自动|禁止 切换写入审批（默认逐笔询问 diff），撤销写入 回退一笔；MCP 连接与浏览器保留；exit/退出 结束

ask 选项:
  --root <dir>     Host Root（默认当前目录）；AI 只能读/运行这个目录内的文件
  --role <code|text> 任务角色：代码任务或文本目录问答（默认 code）
  --rounds <N>     最大轮数，正整数（默认 12）
  --minutes <N>    总时长上限分钟，须大于 0（默认 20）
  --watch <N>      单轮等待回复的秒数，须大于 0（默认 240）
  --headless       无头运行（不弹窗口；真实站点可能有反自动化风险）
  --diagnose       故障排查模板：定位证据、验证假设并给出带行号和测试结果的结论
  --audit          文档核查模板：输出 文档承诺 → 代码证据 → 验证结果 → 未确认项

chat 选项:
  --root <dir>     要学习的项目目录（默认当前目录）
  --role <code|text> 任务角色：代码导师或文本目录问答（默认 code）
  --new            不续接旧对话，强制开新聊天（清除该项目的线程登记）
  --turn-rounds <N> 每个提问允许的动作轮数，正整数（默认 6）
  --watch <N>      单轮等待回复的秒数，须大于 0（默认 240）
  --headless       无头运行（不推荐：看不到页面，反自动化风险也更高）
`);
}

async function cmdSetup() {
  process.stdout.write("启动专用浏览器（profile: ~/.file-tool/chrome-profile）……\n");
  process.stdout.write("请在窗口里登录你要用的聊天网站；完成后直接关闭该窗口。\n");
  const { context } = await launchBrowser({ headless: false });
  context.on("close", () => process.exit(0));
  // 浏览器被手动关闭时 launchPersistentContext 的 context 会 close
  await new Promise(() => {});
}

async function cmdList() {
  for (const id of Object.keys(SITES)) {
    process.stdout.write(`${id.padEnd(10)} ${SITES[id].label.padEnd(12)} ${SITES[id].url}\n`);
  }
  process.stdout.write(`${"mock".padEnd(10)} ${"自测".padEnd(12)} http://127.0.0.1:8642/ (npm run smoke)\n`);
}

/** 用系统默认浏览器打开 URL（打不开不影响控制台运行）。 */
function openInBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* 用户手动复制地址即可 */
  }
}

async function cmdConsole(argv = []) {
  const rootArg = argv.includes("--root") ? rootDirArg(argv) : "";
  const roleArg = roleIdArg(argv);
  const siteIdx = argv.indexOf("--site");
  const siteArg = siteIdx === -1 ? "" : argv[siteIdx + 1];
  if (siteArg && !Object.hasOwn(SITES, siteArg)) {
    throw new Error(`未知站点 "${siteArg}"；运行 node src/cli.mjs list 查看可用站点`);
  }
  const port = positiveNumberArg(argv, "--port", 3210, { integer: true });
  const autostart = argv.includes("--autostart");
  if (autostart && !(rootArg && siteArg)) {
    throw new Error("--autostart 需要同时提供 --root 与 --site");
  }

  // 优先绑定固定端口（好记、可收藏书签）；被占用时回退随机端口
  let app;
  try {
    app = await startControlServer({
      port,
      defaultRoot: rootArg,
      defaultSiteId: siteArg,
      defaultRole: argv.includes("--role") ? roleArg : "",
      autostart: autostart ? { root: rootArg, siteId: siteArg } : null,
    });
  } catch (err) {
    if (!String(err?.message || err).includes("EADDRINUSE")) throw err;
    process.stdout.write(`端口 ${port} 被占用，改用随机端口。\n`);
    app = await startControlServer({
      defaultRoot: rootArg,
      defaultSiteId: siteArg,
      defaultRole: argv.includes("--role") ? roleArg : "",
      autostart: autostart ? { root: rootArg, siteId: siteArg } : null,
    });
  }
  process.stdout.write(`本地控制台已启动：${app.url}\n`);
  openInBrowser(app.url);
  if (autostart) {
    process.stdout.write(`自动启动会话：${siteArg} @ ${rootArg}\n`);
    await app.startSession(siteArg, rootArg, roleArg).catch((err) => {
      process.stderr.write(`[Chat2Local] 自动启动失败：${err?.message || err}\n`);
    });
  }
  process.stdout.write("按 Ctrl+C 关闭控制台。\n");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.stdout.write("控制台已关闭。\n");
  };
  process.once("SIGINT", () => { shutdown().catch((err) => process.stderr.write(`[Chat2Local] ${err.message}\n`)); });
  process.once("SIGTERM", () => { shutdown().catch((err) => process.stderr.write(`[Chat2Local] ${err.message}\n`)); });
}

/** chat 模式下打印一轮的结果（剥掉动作块，只给人看讲解）。 */
function printChatReply(turn, role = "code") {
  if (turn.endReason === "driver-error") {
    process.stdout.write(`⚠ 页面驱动失败：${turn.error}\n`);
    return;
  }
  // 原始回复总是落盘：无论哪种原因漏识别（站点改版/过早收货/空捕获），
  // 下一轮排查都以这份原文为证据，不再依赖猜测。
  fs.mkdirSync(path.dirname(LAST_REPLY_FILE), { recursive: true });
  fs.writeFileSync(LAST_REPLY_FILE, turn.reply ?? "", "utf8");

  const body = stripActionBlocks(turn.reply);
  const speaker = role === "text" ? "问答助手" : "导师";
  if (body) process.stdout.write(`\n${speaker}> ${body}\n\n`);
  else process.stdout.write(`\n${speaker}> （无文字回复）\n\n`);
  if (turn.endReason !== "complete") {
    process.stdout.write(
      `（本轮动作预算耗尽：${turn.endReason}。回复可能不完整，可继续追问或调大 --turn-rounds）\n`
    );
    return;
  }
  if (warnUnparsedActions(turn.reply)) return;
  if (!body) {
    process.stdout.write(
      `⚠ 捕获到的回复是空的，但网页上明明有内容——多半是站点改了消息 DOM（例如 shadow DOM 渲染）。\n` +
        `请核对 src/sites.mjs 里该站点的 messageRoots/markdownBodies 选择器，或把站点名与此现象反馈给维护者。\n`
    );
  }
}

/** chat 模式：交互式 REPL，人在对话环里，浏览器与聊天上下文保持到退出。 */
async function cmdChat(argv) {
  let siteId = argv[0];
  if (!siteId) {
    printUsage();
    process.exit(1);
  }
  siteId = siteIdArg(siteId);
  const root = rootDirArg(argv);
  const role = roleIdArg(argv, ["code", "text"]);
  const turnRounds = positiveNumberArg(argv, "--turn-rounds", 6, { integer: true });
  const watchMs = positiveNumberArg(argv, "--watch", 240) * 1000;
  const headless = argv.includes("--headless");

  const log = (msg) => process.stderr.write(`[Chat2Local] ${msg}\n`);
  log(`站点=${siteId} root=${root} 每问动作轮数≤${turnRounds}`);

  const { context, channel } = await launchBrowser({ headless });
  log(`浏览器已启动（${channel}，专用 profile）。退出请输入 exit / 退出，或 Ctrl+C。`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const forceNew = argv.includes("--new");
    const saved = forceNew ? (clearThread(siteId, root, role), null) : getThread(siteId, root, role);
    const driver = await createDriver({ context, siteId, watchMs, log, startUrl: saved?.url });
    const resume = await resumeThread(driver, siteId, root, forceNew, log, role);
    if (resume.resumed) {
      rememberThread(driver, siteId, root, role);
      process.stdout.write(role === "text" ? "已续接文本问答对话，可以继续提问。\n" : "已续接上次对话，导师复述了上次进度（见网页），直接提问即可。\n");
    } else {
      process.stdout.write(role === "text" ? "正在连接文本目录问答……\n" : "导师正在熟悉项目……\n");
      const intro = await runTurn({
        driver,
        payload: conversationIntroPayload(root, role, false),
        root,
        maxRounds: turnRounds,
        log,
      });
      printChatReply(intro, role);
      rememberThread(driver, siteId, root, role);
    }

    rl.setPrompt("你> ");
    rl.prompt();
    for await (const line of rl) {
      const q = line.trim();
      if (!q) {
        rl.prompt();
        continue;
      }
      if (q === "exit" || q === "quit" || q === "退出" || q === "q") break;
      const turn = await runTurn({
        driver,
        payload: q,
        root,
        maxRounds: turnRounds,
        log,
      });
      printChatReply(turn, role);
      rl.prompt();
    }
  } finally {
    rl.close();
    await context.close().catch(() => {});
    process.stdout.write("会话已结束，浏览器已关闭。\n");
  }
}

/** watch 收尾：先阻止新动作，再释放在途 MCP 请求，最后关闭 watcher 与浏览器。 */
export async function closeWatchResources({ stopWatcher, mcpClient, rl, context }) {
  stopWatcher?.signal?.();
  try {
    await mcpClient?.close();
  } catch {
    /* 关闭失败不阻塞收尾；客户端内部已尝试进程树清理 */
  }
  try {
    await stopWatcher?.();
  } finally {
    rl.close();
    await context.close().catch(() => {});
  }
}

/** watch 模式：用户在网页上聊，工具在旁自动执行 host 动作并回填结果。 */
async function cmdWatch(argv) {
  let siteId = argv[0];
  if (!siteId) {
    printUsage();
    process.exit(1);
  }
  siteId = siteIdArg(siteId);
  const root = rootDirArg(argv);
  const role = roleIdArg(argv);
  const headless = argv.includes("--headless");

  const log = (msg) => process.stderr.write(`[Chat2Local] ${msg}\n`);
  log(`站点=${siteId} root=${root} 角色=${role}（旁观执行模式）`);

  const mcpSpec = mcpSpecArg(argv, root);
  const mcpAllow = mcpAllowArg(argv);
  let mcpCatalog = null; // { tools, allow, dropped }——开场白展示、授权与执行共用
  if (mcpSpec) log(`MCP 桥接：${mcpSpec.script}${mcpAllow ? `（显式授权：${mcpAllow.join("、")}）` : ""}`);

  const forceNew = argv.includes("--new");
  assertOtherRoleClear(watchCheckpointStore, siteId, root, role);
  const registered = getThread(siteId, root, role);
  const existingCheckpoint = watchCheckpointStore.forThread(siteId, root, registered?.url || "", role);
  const prior = existingCheckpoint.read();
  if (forceNew && prior && prior.phase !== "processed") {
    throw usageError("旧聊天尚有未确认动作；请先在原聊天核对，不能用 --new 绕过");
  }

  const { context, channel } = await launchBrowser({ headless });
  log(`浏览器已启动（${channel}，专用 profile）。Ctrl+C 退出。`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stopWatcher = null; // startWatcher 完成前就 Ctrl+C 也不能泄漏轮询循环；?. 保证可空
  let mcpClient = null;
  let mcpCatalogController = null;
  let manualPauseRequested = false;
  try {
    const saved = forceNew ? (clearThread(siteId, root, role), null) : registered;
    const driver = await createDriver({ context, siteId, log, startUrl: saved?.url });
    await driver.markTab();
    let checkpoint = watchCheckpointStore.forThread(siteId, root, saved?.url || driver.currentUrl?.() || "", role);
    const recovery = checkpoint.read();
    if (recovery?.phase === "mismatch-pending") {
      throw new Error("旧聊天有未确认动作；请先在控制台重新绑定原聊天地址并核对");
    }
    let resume;
    if (recovery && recovery.phase !== "processed") {
      if (!saved || driver.currentUrl?.() !== saved.url) {
        throw new Error("原聊天未能打开，无法核对中断动作；已保留断点和聊天登记");
      }
      if (!argv.includes("--confirm-recovery")) {
        throw new Error("上次动作可能已执行或回填未确认。请在原聊天核对后，加 --confirm-recovery 重启；不会重跑或重发上次动作");
      }
      checkpoint.acknowledge();
      log("已确认中断动作；不会重跑或重发上次动作。");
      resume = { resumed: true };
    } else {
      resume = await resumeThread(driver, siteId, root, forceNew, log, role);
    }

    // 常驻 MCP 连接：本 watch 独享一个 server 进程，目录发现与调用共用，
    // 退出统一释放（放在浏览器启动之后，浏览器启动失败时无进程可泄漏）
    if (mcpSpec) {
      try {
        mcpClient = await createMcpClient(mcpSpec, { startupTimeoutMs: 30000 });
        mcpCatalogController = createMcpCatalogController({
          client: mcpClient, driver, explicitAllow: mcpAllow, checkpoint,
          log, onCatalogChange: (catalog) => { mcpCatalog = catalog; },
          onFailure: () => rl.close(),
          mayResume: () => !manualPauseRequested,
        });
        const listed = await mcpClient.listTools({ timeoutMs: 30000 });
        mcpCatalog = mcpCatalogController.initialize(listed);
        if (mcpCatalog) {
          log(`MCP server 就绪（协议 ${mcpClient.protocolVersion}），工具目录（${mcpCatalog.allow.length} 个）：${mcpCatalog.allow.join("、")}`);
          if (mcpCatalog.dropped.length) {
            log(`未授权的工具（${mcpCatalog.dropped.length} 个，不在允许列表或超出上限）：${mcpCatalog.dropped.join("、")}`);
          }
        } else {
          await mcpClient.close();
          mcpClient = null;
          mcpCatalogController = null;
          log("MCP server 没有可展示的工具——本次不会授权任何 mcp 动作，续接时会向原聊天同步空目录");
        }
      } catch (err) {
        // createMcpClient 失败时已自行清理；创建成功后的目录处理失败也要释放。
        await mcpClient?.close().catch(() => {});
        mcpClient = null;
        mcpCatalogController = null;
        log(`MCP server 连接失败（${err?.message || err}）——mcp 动作不可用，其余功能不受影响`);
      }
    }

    const introCatalogRevision = mcpCatalogController?.revision ?? 0;
    let intro;
    if (resume.resumed) {
      intro = { ok: true, text: "" };
      process.stdout.write("已续接上次对话（开场白免发，协议在原线程里）。\n");
    } else {
      // 压缩续接消费点：--new 开新线程时，若此前保存过该目录+角色的摘要，
      // 取出（取即清除，一个摘要只注入一次）并随开场白注入新线程。
      const summary = forceNew ? takeSummary(siteId, root, role) : null;
      if (summary) process.stdout.write("检测到已保存的压缩摘要，将随开场白注入新线程。\n");
      process.stdout.write(roleDefinition(role).watchIntro);
      intro = await driver.send(conversationIntroPayload(root, role, true, { mcpTools: mcpCatalog?.tools ?? null, summary }));
    }
    if (intro.ok) {
      const url = driver.currentUrl?.() || "";
      const valid = siteId === "mock"
        ? Boolean(url && url !== SITES[siteId]?.url)
        : validThreadUrl(siteId, url);
      if (!valid) throw new Error("尚未取得有效聊天线程地址；无法安全保存 watch 断点，请检查网站状态后重试");
      saveThread(siteId, root, url, role);
      checkpoint = watchCheckpointStore.forThread(siteId, root, url, role);
      const lead = resume.resumed
        ? "重连成功。"
        : `开场白已送达（回复 ${intro.text.length} 字符，见网页）。`;
      process.stdout.write(
        `${lead}\n` +
          `请务必在标题带〔Chat2Local〕标记的浏览器窗口里聊天。\n` +
          `它的回复里出现 \`\`\`host 动作块时，本工具会自动执行并把结果回填进对话；\n` +
          `终端保持运行才会持续旁观（关掉终端窗口 = 停止旁观执行）。\n\n`
      );
    } else {
      throw new Error(`开场白发送失败：${intro.error || "未知原因"}；为避免在未登记聊天执行动作，已停止旁观`);
    }

    if (mcpCatalogController) {
      // 保存聊天 URL 后才能给目录同步失败写入当前线程的人工核对断点。
      mcpCatalogController.setCheckpoint(checkpoint);
      await mcpCatalogController.syncBeforeWatch(resume.resumed, introCatalogRevision);
    } else {
      const catalogSync = await syncMcpCatalog(driver, resume.resumed, null);
      if (!catalogSync.ok) {
        checkpoint.write({ phase: "catalog-sync", replyId: replyFingerprint({ text: mcpSyncPayload([]) }) });
        throw new Error(`mcp 空目录同步失败或状态不明（${catalogSync.error}）；已停止旁观，请在原聊天人工核对`);
      }
      if (catalogSync.synced) log("已向原聊天同步空目录，历史 mcp 工具均已停用。");
    }

    let pendingSummary = null; // 压缩/compact：模型产出的待确认摘要
    let pendingConfirm = null; // 写入确认挂起：{ resolve }，REPL 循环负责路由输入
    // 写入审批模式（P61，codex 式分级）：deny 禁止 / ask 逐笔询问（默认）/
    // risk 风险询问 / auto 自动批准。目录里有写入类工具时提示一次。
    let writeMode = "ask";
    const writeGate = createWriteGate({
      isMcpWriteTool,
      runWithWrite: (action, rootDir) =>
        runAction(action, rootDir, { mcp: { client: mcpClient, allow: mcpCatalog.allow, allowWrite: true } }),
      getMode: () => writeMode,
      confirm: async ({ tool, riskClass, preview }) => {
        process.stdout.write(
          `\n[写入确认] ${tool}（${riskClass}）\n${preview}\n` +
            `请输入：同意(y) 执行本次 / 会话同意(a，本会话此工具不再询问) / 拒绝(n)\n`
        );
        rl.prompt();
        return new Promise((resolve) => {
          pendingConfirm = { resolve };
        });
      },
    });
    if (mcpCatalog?.tools.some((t) => isMcpWriteTool(t.name))) {
      log("目录含写入类工具，写入审批模式：逐笔询问（写入模式 命令可切换；沙箱边界不随模式放宽）");
    }
    stopWatcher = await startWatcher({
      driver,
      root,
      role,
      checkpoint,
      log,
      onFatal: (message) => log(message),
      onReply: (text) => log(`新讲解回复（${text.length} 字符，无动作块，已在网页显示）`),
      onSummary: (summary) => {
        pendingSummary = summary;
        log(`收到压缩摘要（${summary.length} 字符）——输入 保存摘要 存档（下次 --new 时注入新线程），或忽略。`);
      },
      // 只有目录非空才注入桥接执行器：目录发现与调用共用同一个常驻 client。
      // 写动作先经门控拦截（dryRun 预览 + 人工确认后同一调用直执）；
      // 门控返回 null（非写动作/deny）才走 runAction（deny 下由 host 门控拒绝）。
      ...(mcpClient && mcpCatalog
        ? {
            execAction: async (action, rootDir) => {
              const gated = await writeGate.intercept(action, rootDir);
              if (gated) return gated;
              return runAction(action, rootDir, { mcp: { client: mcpClient, allow: mcpCatalog.allow, allowWrite: false } });
            },
          }
        : {}),
    });
    mcpCatalogController?.attachWatcher(stopWatcher);

    // 终端仍可作为备用输入：每行原样发进网页对话；暂停/恢复只作用于 watcher，
    // MCP 连接与浏览器保留（server 的会话状态跨暂停存活）
    rl.prompt();
    for await (const line of rl) {
      const q = line.trim();
      if (!q) {
        rl.prompt();
        continue;
      }
      if (q === "exit" || q === "quit" || q === "退出" || q === "q") break;
      // 写入确认挂起时，终端输入优先路由给确认（暂停等命令暂不可用）
      if (pendingConfirm) {
        const lower = q.toLowerCase();
        if (q === "同意" || lower === "y") {
          pendingConfirm.resolve("yes");
          pendingConfirm = null;
        } else if (q === "会话同意" || lower === "a") {
          pendingConfirm.resolve("session");
          pendingConfirm = null;
        } else if (q === "拒绝" || lower === "n") {
          pendingConfirm.resolve("no");
          pendingConfirm = null;
        } else {
          process.stdout.write("写入确认挂起：请输入 同意(y) / 会话同意(a) / 拒绝(n)。\n");
        }
        rl.prompt();
        continue;
      }
      if (q === "pause" || q === "暂停") {
        manualPauseRequested = true;
        if (!stopWatcher) {
          process.stdout.write("watcher 尚未启动，无需暂停。\n");
        } else if (stopWatcher.isPaused()) {
          process.stdout.write("已经处于暂停状态。\n");
        } else {
          await stopWatcher.pause();
          process.stdout.write("已暂停：停止处理新回复；当前动作与回填完成后不再继续。MCP 连接与浏览器保留，输入 恢复 继续。\n");
        }
        rl.prompt();
        continue;
      }
      if (q === "resume" || q === "恢复") {
        if (mcpCatalogController?.failed || mcpCatalogController?.syncing) {
          process.stdout.write("目录同步尚未确认，暂不能恢复旁观。\n");
          rl.prompt();
          continue;
        }
        if (!stopWatcher) {
          process.stdout.write("watcher 尚未启动。\n");
        } else if (!stopWatcher.isPaused()) {
          process.stdout.write("当前未处于暂停状态。\n");
        } else {
          manualPauseRequested = false;
          stopWatcher.resume();
          process.stdout.write("已恢复旁观；暂停期间积压的最后一条未处理回复会被处理。\n");
        }
        rl.prompt();
        continue;
      }
      if (q === "压缩" || q === "compact") {
        // 压缩续接第一步：让当前线程模型产出 ```summary 摘要；
        // 捕获后须人工 保存摘要 才存档，防止未经确认的状态写入登记。
        if (!getThread(siteId, root, role)) {
          process.stdout.write("该目录与角色没有已登记线程，无法保存摘要（先正常启动一次 watch）。\n");
          rl.prompt();
          continue;
        }
        if (pendingSummary) {
          process.stdout.write("已有一个待确认摘要，先 保存摘要 或忽略后再重新压缩。\n");
          rl.prompt();
          continue;
        }
        const sent = await driver.deliver(compressPayload(root));
        if (!sent.ok) {
          log(`压缩请求发送失败：${sent.error || "unknown"}`);
        } else {
          process.stdout.write("已请求模型生成摘要；回复的 ```summary 块被捕获后，输入 保存摘要 存档。\n");
        }
        rl.prompt();
        continue;
      }
      if (q === "保存摘要" || q === "save-summary") {
        if (!pendingSummary) {
          process.stdout.write("当前没有待确认的摘要（先用 压缩 命令生成）。\n");
        } else {
          try {
            saveSummary(siteId, root, role, pendingSummary);
            process.stdout.write(`摘要已存档（${pendingSummary.length} 字符）。下次对该目录与角色 --new 开新线程时将注入并清除。\n`);
            pendingSummary = null;
          } catch (err) {
            process.stdout.write(`摘要存档失败：${err?.message || err}\n`);
          }
        }
        rl.prompt();
        continue;
      }
      if (q === "允许写入" || q === "allow-write") {
        // P60 兼容别名：等价于 写入模式 自动（帮我批准）
        writeMode = "auto";
        process.stdout.write("写入审批模式：自动批准（帮我批准）——写入不再逐笔询问，.bak 备份与撤销记录仍保留；输入 写入模式 询问|风险|禁止 可切换，沙箱边界不随模式放宽。\n");
        rl.prompt();
        continue;
      }
      if (q === "禁止写入" || q === "deny-write") {
        writeMode = "deny";
        process.stdout.write("写入审批模式：禁止——写入类 MCP 工具全部拒绝（fail-closed）。\n");
        rl.prompt();
        continue;
      }
      if (q === "写入模式" || q === "write-mode" || q.startsWith("写入模式 ")) {
        const arg = q.startsWith("写入模式 ") ? q.slice("写入模式 ".length).trim() : "";
        const modeMap = { 禁止: "deny", 询问: "ask", 逐笔询问: "ask", 风险: "risk", 风险询问: "risk", 自动: "auto", 帮我批准: "auto", 完全访问: "auto" };
        if (arg) {
          const next = modeMap[arg];
          if (!next) {
            process.stdout.write("未知模式。用法：写入模式 询问|风险|自动|禁止（完全访问/帮我批准 等价于 自动）。\n");
          } else {
            writeMode = next;
            const desc = { deny: "禁止（fail-closed）", ask: "逐笔询问（每笔写入展示 diff 等你确认）", risk: "风险询问（仅覆盖已有内容时询问）", auto: "自动批准（帮我批准）" }[next];
            process.stdout.write(`写入审批模式已切换：${desc}${next === "auto" ? "（沙箱边界不随模式放宽）" : ""}\n`);
          }
        } else {
          const approved = [...writeGate.sessionApproved];
          process.stdout.write(
            `当前写入审批模式：${{ deny: "禁止", ask: "逐笔询问", risk: "风险询问", auto: "自动批准" }[writeMode]}` +
              `；会话同意过的工具：${approved.length ? approved.join("、") : "(无)"}；撤销栈由 server 维护（撤销写入 命令回退一笔）。\n`
          );
        }
        rl.prompt();
        continue;
      }
      if (q === "撤销写入" || q === "undo-write") {
        // 用户主动回退 server 撤销栈顶的一笔写入（不占模型轮次、不经模型门控）
        if (!mcpClient) {
          process.stdout.write("本会话没有 MCP server，无撤销栈。\n");
        } else {
          const r = await mcpClient.callTool("undo_write", {}, { timeoutMs: 15000 });
          process.stdout.write(r.ok ? `已撤销：${r.text}\n` : `撤销失败：${r.text}\n`);
        }
        rl.prompt();
        continue;
      }
      await mcpCatalogController?.waitForSync();
      if (mcpCatalogController?.failed) break;
      const fed = await driver.deliver(q);
      if (!fed.ok) log(`发送失败：${fed.error || "unknown"}`);
      rl.prompt();
    }
  } finally {
    await closeWatchResources({ stopWatcher, mcpClient, rl, context });
    process.stdout.write("Watcher 已停止，浏览器已关闭。\n");
  }
}

async function cmdAsk(argv) {
  let siteId = argv[0];
  if (!siteId) {
    printUsage();
    process.exit(1);
  }
  siteId = siteIdArg(siteId);
  const task = askTaskArg(argv);
  if (!task) {
    process.stderr.write("缺少任务描述。用法: node src/cli.mjs ask <site> \"<task>\"\n");
    process.exit(1);
  }

  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const root = rootDirArg(options);
  const maxRounds = positiveNumberArg(options, "--rounds", 12, { integer: true });
  const totalMs = positiveNumberArg(options, "--minutes", 20) * 60 * 1000;
  const watchMs = positiveNumberArg(options, "--watch", 240) * 1000;
  const headless = options.includes("--headless");
  const diagnose = options.includes("--diagnose");
  const audit = options.includes("--audit");
  if (audit && diagnose) throw usageError("--audit 与 --diagnose 互斥，请只选其一");
  const role = roleIdArg(options, ["code", "text"]);
  if (diagnose && role === "text") throw usageError("--diagnose 仅适用于代码任务角色；文本目录问答请去掉 --diagnose");
  if (audit && role === "text") throw usageError("--audit 仅适用于代码任务角色；文本目录问答请去掉 --audit");

  const log = (msg) => process.stderr.write(`[Chat2Local] ${msg}\n`);
  log(`站点=${siteId} root=${root} 轮数≤${maxRounds} 时长≤${Math.round(totalMs / 60000)}min`);

  const { context, channel } = await launchBrowser({ headless });
  log(`浏览器已启动（${channel}，专用 profile）`);
  try {
    const driver = await createDriver({ context, siteId, watchMs, log });
    const receipt = await orchestrate({ driver, task, root, diagnose, audit, role, maxRounds, totalMs, log });
    process.stdout.write("\n=== 最终回复 ===\n");
    process.stdout.write((receipt.note || "(无)") + "\n");
    process.stdout.write("\n=== Receipt ===\n");
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
    if (receipt.endReason !== "complete") process.exitCode = 2;
    else warnUnparsedActions(receipt.reply);
  } finally {
    await context.close().catch(() => {});
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const run =
    cmd === "setup" ? cmdSetup()
    : cmd === "list" ? cmdList()
    : cmd === "console" ? cmdConsole(rest)
    : cmd === "ask" ? cmdAsk(rest)
    : cmd === "chat" ? cmdChat(rest)
    : cmd === "watch" ? cmdWatch(rest)
    : Promise.resolve(printUsage());
  run.catch((err) => {
    const detail = err?.code === "CLI_USAGE" ? err.message : err?.stack || err;
    process.stderr.write(`[Chat2Local] ${detail}\n`);
    process.exit(1);
  });
}
