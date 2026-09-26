#!/usr/bin/env node
/**
 * file-tool CLI
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
import { conversationIntroPayload, reconnectPayload, ROLE_IDS } from "./protocol.mjs";
import { stripActionBlocks } from "./parse.mjs";
import { startWatcher } from "./watcher.mjs";
import { watchCheckpointStore, assertOtherRoleClear } from "./watch-checkpoint.mjs";
import { startControlServer, validThreadUrl } from "./control-server.mjs";
import { getThread, saveThread, clearThread } from "./state.mjs";
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

/** 站点名在任何浏览器动作前校验，避免输错后仍启动专用浏览器。 */
export function siteIdArg(siteId) {
  if (!resolveSite(siteId)) {
    throw usageError(
      `未知站点 "${siteId}"；可用：${SITE_IDS.join("、")}。运行 node src/cli.mjs list 查看详情`
    );
  }
  return siteId;
}

/** 旧命令默认仍为代码导师。 */
export function roleIdArg(argv) {
  const i = argv.indexOf("--role");
  if (i === -1) return "code";
  const role = argv[i + 1];
  if (!ROLE_IDS.includes(role)) throw usageError(`未知任务角色：${role ?? "(缺失)"}；可用：${ROLE_IDS.join("、")}`);
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
  process.stdout.write(`file-tool — 让网页聊天读文件/读目录/跑测试

用法:
  node src/cli.mjs setup                          启动专用浏览器，登录聊天网站后关窗即可
  node src/cli.mjs list                           列出支持的站点
  node src/cli.mjs console                        打开本地控制台，管理 watch 会话
  node src/cli.mjs watch <site> --root <dir>       旁观执行：你在网页上聊，工具自动执行 host 动作并回填
  node src/cli.mjs ask <site> "<task>" [选项]      一次性任务：派活到终态，拿回执
  node src/cli.mjs chat <site> [选项]              导师模式：交互式陪学本地项目代码

console 选项:
  --role <code|text> 预选任务角色；控制台页面也可切换（默认沿用上次选择）

watch 选项:
  --root <dir>     要学习的项目目录（必填其一，默认当前目录）
  --role <code|text> 任务角色：代码导师或文本目录问答（默认 code）
  --new            不续接旧对话，强制开新聊天（清除该项目的线程登记）
  --confirm-recovery  核对中断前动作后继续；不会重跑或重发上次动作

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
      process.stderr.write(`[file-tool] 自动启动失败：${err?.message || err}\n`);
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
  process.once("SIGINT", () => { shutdown().catch((err) => process.stderr.write(`[file-tool] ${err.message}\n`)); });
  process.once("SIGTERM", () => { shutdown().catch((err) => process.stderr.write(`[file-tool] ${err.message}\n`)); });
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
  const role = roleIdArg(argv);
  const turnRounds = positiveNumberArg(argv, "--turn-rounds", 6, { integer: true });
  const watchMs = positiveNumberArg(argv, "--watch", 240) * 1000;
  const headless = argv.includes("--headless");

  const log = (msg) => process.stderr.write(`[file-tool] ${msg}\n`);
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

  const log = (msg) => process.stderr.write(`[file-tool] ${msg}\n`);
  log(`站点=${siteId} root=${root}（旁观执行模式）`);

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
  let stopWatcher = async () => {}; // startWatcher 完成前就 Ctrl+C 也不能泄漏轮询循环
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
    let intro;
    if (resume.resumed) {
      intro = { ok: true, text: "" };
      process.stdout.write("已续接上次对话（开场白免发，协议在原线程里）。\n");
    } else {
      process.stdout.write(role === "text" ? "发送文本问答开场白……\n" : "发送导师开场白（让网页模型知道 host 动作协议）……\n");
      intro = await driver.send(conversationIntroPayload(root, role, true));
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
          `请务必在标题带〔file-tool〕标记的浏览器窗口里聊天。\n` +
          `它的回复里出现 \`\`\`host 动作块时，本工具会自动执行并把结果回填进对话；\n` +
          `终端保持运行才会持续旁观（关掉终端窗口 = 停止旁观执行）。\n\n`
      );
    } else {
      throw new Error(`开场白发送失败：${intro.error || "未知原因"}；为避免在未登记聊天执行动作，已停止旁观`);
    }

    stopWatcher = await startWatcher({
      driver,
      root,
      role,
      checkpoint,
      log,
      onFatal: (message) => log(message),
      onReply: (text) => log(`新讲解回复（${text.length} 字符，无动作块，已在网页显示）`),
    });

    // 终端仍可作为备用输入：每行原样发进网页对话
    rl.prompt();
    for await (const line of rl) {
      const q = line.trim();
      if (!q) {
        rl.prompt();
        continue;
      }
      if (q === "exit" || q === "quit" || q === "退出" || q === "q") break;
      const fed = await driver.deliver(q);
      if (!fed.ok) log(`发送失败：${fed.error || "unknown"}`);
      rl.prompt();
    }
  } finally {
    // 必须先停轮询循环再关浏览器：否则循环对已关闭页面做快照，
    // 每 1.5s 报一次"轮询异常"且进程永不退出（实测事故）
    await stopWatcher();
    rl.close();
    await context.close().catch(() => {});
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
  const role = roleIdArg(options);
  if (diagnose && role === "text") throw usageError("--diagnose 仅适用于代码任务角色；文本目录问答请去掉 --diagnose");
  if (audit && role === "text") throw usageError("--audit 仅适用于代码任务角色；文本目录问答请去掉 --audit");

  const log = (msg) => process.stderr.write(`[file-tool] ${msg}\n`);
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
    process.stderr.write(`[file-tool] ${detail}\n`);
    process.exit(1);
  });
}
