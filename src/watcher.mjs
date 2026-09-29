/**
 * watcher —— 旁观执行器：用户直接在网页上和导师聊天，本模块盯着页面，
 * 发现新回复里有 ```host 动作就执行，并把结果自动回填进对话。
 *
 * 检测协议：
 *   - 轮询 driver.snapshot()（最后一根 assistant 气泡：文本 + busy 标志）
 *   - 文本不变且 !busy 持续 stableMs → 视为一条"新回复"
 *   - 有动作块 → 逐个执行（root 沙箱内）→ driver.deliver(feedPayload) 回填
 *   - 无动作块（纯讲解）→ 只通知 onReply，不打扰对话
 *   - 无动作块但含 ```summary 围栏（压缩续接请求的回复）→ 通知 onSummary
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractActions } from "./parse.mjs";
import { runAction } from "./host-actions.mjs";
import { feedPayload, MAX_ACTIONS_PER_ROUND } from "./protocol.mjs";
import { replyFingerprint } from "./watch-checkpoint.mjs";

// 追踪文件：watcher 每次快照的状态流水。它"看不见"页面时（busy 卡死、
// 选择器失效、用户聊错窗口），从这里能直接看到它实际看到的东西。
const TRACE_FILE = path.join(os.homedir(), ".file-tool", "watch-trace.txt");

// 只展示这些固定字段名；MCP 入参值与其他字段名均可能包含凭据。
const MCP_LOG_ARG_KEYS = ["url", "element", "target", "function"];

/** 提取 ```summary 围栏内容（压缩续接请求的回复形态）；无则返回 null。
 * 只认 summary 语言标签的完整围栏，正文其余部分忽略。 */
function extractSummaryFence(text) {
  const match = String(text ?? "").match(/```summary\r?\n([\s\S]*?)```/i);
  const body = match?.[1]?.trim();
  return body || null;
}

/** MCP 动作日志只记录参数形状，本地动作仍只记录 op+path。 */
function actionFragment(action) {  if (action?.op !== "mcp") return "";
  const args = action.args;
  if (!args || typeof args !== "object") return "参数形状未知；参数值已省略";
  const knownKeys = MCP_LOG_ARG_KEYS.filter((key) => Object.hasOwn(args, key));
  const otherCount = Math.max(0, Object.keys(args).length - knownKeys.length);
  const other = otherCount ? `，另 ${otherCount} 个字段名已省略` : "";
  return `参数键=[${knownKeys.join(",")}]${other}；参数值已省略`;
}

function appendTrace(line) {
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    if (fs.existsSync(TRACE_FILE) && fs.statSync(TRACE_FILE).size > 200000) {
      fs.writeFileSync(TRACE_FILE, ""); // 防无限膨胀
    }
    fs.appendFileSync(TRACE_FILE, line + "\n");
  } catch {
    /* 诊断写文件失败不影响主流程 */
  }
}

function sigOf(text) {
  // djb2：足够区分"回复变没变"，不需要密码学强度
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${h}:${text.length}`;
}

/**
 * 回复稳定判定器（纯逻辑，可注入时钟单测）。
 * observe(text, busy, agedMs) → { stable, text }：文本自上次变化起稳定满
 * stableMs 且非 busy 才算 stable。agedMs 是页面侧报告的"该文本已存在多久"
 * ——waitForChange 路径下文本变化到 Node 观察之间有延迟，用它校准，
 * 避免稳定判定被传输延迟重复计一遍。markProcessed/isProcessed 防止同一
 * 条回复重复处理。
 */
export function createReplyTracker({ stableMs = 3000, now = Date.now } = {}) {
  let lastText = "";
  let lastChangeAt = now();
  let lastSig = "";
  return {
    observe(text, busy, agedMs = 0) {
      const t = String(text ?? "");
      const aged = Math.max(0, Number(agedMs) || 0);
      if (t !== lastText) {
        lastText = t;
        lastChangeAt = now() - aged;
      } else if (aged) {
        // 同一文本：以页面侧更准的变化时间校准（取较早者，保守）
        const pageChangeAt = now() - aged;
        if (pageChangeAt < lastChangeAt) lastChangeAt = pageChangeAt;
      }
      const stable = !busy && t.length > 0 && now() - lastChangeAt >= stableMs;
      return { stable, text: t };
    },
    isProcessed(text) {
      return sigOf(String(text ?? "")) === lastSig;
    },
    markProcessed(text) {
      lastSig = sigOf(String(text ?? ""));
    },
  };
}

/**
 * 启动旁观循环。返回可等待的 stop()，并在该函数上提供 pause()/resume()。
 * 暂停在当前回复的动作与回填尝试结束后生效，恢复时继续使用原页面和判定器。
 *
 * @param {object} opts
 * @param {number} [opts.maxActionsPerFeed] 每条回复最多执行的动作数（其余截掉并告知）
 * @param {number} [opts.feedRetryMs] 回填失败后的重试间隔
 */
export async function startWatcher({
  driver,
  root,
  role = "code",
  execAction = runAction,
  stableMs = 3000,
  intervalMs = 1500,
  maxActionsPerFeed = MAX_ACTIONS_PER_ROUND,
  feedRetryMs = 5000,
  log = () => {},
  onReply = () => {},
  onSummary = null,
  checkpoint = null,
  onFatal = () => {},
  traceSink = appendTrace,
}) {
  const previous = checkpoint?.read();
  if (previous && previous.phase !== "processed") {
    throw new Error("上次网页动作尚未确认；请先核对原聊天，再手动确认继续");
  }
  let lastPersistedId = previous?.replyId || "";
  const tracker = createReplyTracker({ stableMs });
  let stopped = false;
  let paused = false;
  let pauseAcknowledged = false;
  let wakePausedLoop = null;
  let pauseWaiters = [];
  let feeding = false; // 回填期间暂停检测，避免把自己的回填气泡当成新回复
  let feedCount = 0;
  let lastRawText = null; // 原始文本变化检测（与 tracker 的稳定判定分开）
  let lastChangeLogAt = 0;
  let lastChangeAt = Date.now();
  let reminded = false;
  let lastTraceSig = ""; // 仅在内存比较回复变化；诊断文件不落正文或指纹
  let lastTraceAt = 0;
  let pendingFeed = ""; // 动作只执行一次；网页回填失败时保留同一份结果重试
  let pendingReplyId = "";
  let pendingActionCount = 0;
  let retryFeedAt = 0;
  let lastSeenSig = ""; // waitForChange 的期望签名（页面上次看到的气泡状态）
  let lastWakeSig = ""; // 最近一次唤醒报告的签名（对应 agedMs 传递给 tracker）
  let lastWakeAgoMs = 0;

  const signal = () => {
    stopped = true;
    paused = false;
    for (const resolve of pauseWaiters.splice(0)) resolve();
    wakePausedLoop?.();
  };

  const deliverSafely = async (text) => {
    try {
      return await driver.deliver(text);
    } catch (err) {
      return { ok: false, error: err?.message || "deliver-failed", retryable: false };
    }
  };

  const haltForUnknownDelivery = (error) => {
    const message = `网页回填结果不确定（${error || "未知原因"}）；已停止自动执行。请检查原聊天，重启后人工确认，不会自动重发。`;
    log(message);
    try { onFatal(message); } catch { /* 状态通知失败仍须停止 */ }
    signal();
  };

  // mcp 等动作返回"结果不明"（已发出、结果未知）时：停止本批次与后续自动
  // 执行，不回填（回填会让模型以为批次完成并继续），断点保留在 executing
  // 等人工核对。这是结果不明与普通失败的语义分界。
  const haltForUnknownOutcome = (action, result) => {
    const target = `${action.op} ${action.tool ?? action.path ?? ""}`.trim();
    const message =
      `动作 ${target} ${actionFragment(action)} 已发出但结果不明（${result?.text || "未知原因"}）；` +
      `已停止本批次后续动作与自动回填。请核对原聊天与本地实际状态，重启后人工确认，不会自动重试或重放。`;
    log(message);
    try { onFatal(message); } catch { /* 状态通知失败仍须停止 */ }
    signal();
  };

  const persist = (record) => {
    if (!checkpoint) return;
    try { checkpoint.write(record); }
    catch (err) {
      const message = `watch 断点保存失败，已停止自动执行：${err?.message || err}`;
      log(message);
      try { onFatal(message); } catch { /* 状态通知失败仍须停止 */ }
      signal();
      throw err;
    }
  };

  const loop = (async () => {
    while (!stopped) {
      if (paused) {
        pauseAcknowledged = true;
        for (const resolve of pauseWaiters.splice(0)) resolve();
        await new Promise((resolve) => { wakePausedLoop = resolve; });
        wakePausedLoop = null;
        pauseAcknowledged = false;
        continue;
      }
      try {
        if (pendingFeed) {
          if (Date.now() >= retryFeedAt) {
            const fed = await deliverSafely(pendingFeed);
            if (fed.ok) {
              persist({ phase: "processed", replyId: pendingReplyId, actionCount: pendingActionCount });
              lastPersistedId = pendingReplyId;
              pendingFeed = "";
              log(`结果回填重试成功（第 ${feedCount} 次）`);
            } else {
              if (fed.retryable === false) haltForUnknownDelivery(fed.error);
              else {
                retryFeedAt = Date.now() + feedRetryMs;
                log(`回填重试失败：${fed.error || "unknown"}——将在稍后继续重试`);
              }
            }
          }
          if (!paused && !stopped) await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        const snap = await driver.snapshot();
        if (stopped) break;
        // 追踪流水只记状态与变化标记；正文仅在内存比较，不写入诊断文件。
        // 每 10s 强制心跳，事后仍能定位站点选择器或生成状态失效。
        const traceSig = `${snap.busy ? 1 : 0}:${sigOf(snap.text)}`;
        const changed = traceSig !== lastTraceSig;
        const traceLine = `busy=${snap.busy ? 1 : 0} chars=${snap.text.length} changed=${changed ? 1 : 0}`;
        const nowTrace = Date.now();
        if (changed || nowTrace - lastTraceAt > 10000) {
          lastTraceSig = traceSig;
          lastTraceAt = nowTrace;
          traceSink(`${new Date().toISOString()} ${traceLine}`);
        }
        // 内容变化诊断日志：限流 10s 一条。长时间零变化说明用户很可能
        // 聊错了窗口（聊在日常浏览器而不是被旁观的专用实例里）。
        const nowMs = Date.now();
        if (snap.text !== lastRawText) {
          lastRawText = snap.text;
          lastChangeAt = nowMs;
          if (snap.text && nowMs - lastChangeLogAt > 10000) {
            lastChangeLogAt = nowMs;
            log(
              `页面内容有变化（${snap.text.length} 字符${snap.busy ? "，生成中" : ""}）——正在持续监视`
            );
          }
        } else if (
          !reminded &&
          nowMs - lastChangeAt > 120000 &&
          feedCount === 0
        ) {
          reminded = true;
          log(
            "提醒：页面内容已 2 分钟无变化。请确认①你是在标题带〔Chat2Local〕的浏览器窗口里聊天；②终端保持运行（关掉终端 = 停止旁观执行）。"
          );
        }
        if (!feeding) {
          const agedMs = snap.sig && lastWakeSig === snap.sig ? lastWakeAgoMs : 0;
          const { stable, text } = tracker.observe(snap.text, snap.busy, agedMs);
          if (stable && !tracker.isProcessed(text)) {
            tracker.markProcessed(text);
            const replyId = replyFingerprint({ count: snap.count, text });
            if (replyId === lastPersistedId) continue;
            const parsed = extractActions(text);
            const actions = parsed.actions;
            if (actions.length > 0) {
              feeding = true;
              let outcomeUnknown = false;
              try {
                const chosen = actions.slice(0, maxActionsPerFeed);
                persist({ phase: "executing", replyId, actionCount: chosen.length });
                if (actions.length > maxActionsPerFeed) {
                  log(`动作数超过 ${maxActionsPerFeed}，只执行前 ${maxActionsPerFeed} 个`);
                }
                log(`检测到 ${chosen.length} 个动作，执行中…`);
                const results = [];
                for (const [index, action] of chosen.entries()) {
                  if (stopped) break;
                  persist({ phase: "executing", replyId, actionIndex: index + 1, actionCount: chosen.length });
                  let result;
                  try {
                    result = await execAction(action, root);
                  } catch (err) {
                    result = { ok: false, error: err?.message || "exec-failed", text: err?.message || "" };
                  }
                  results.push({ action, result });
                  const head = [`  ${action.op}`, action.tool ?? action.path ?? "", actionFragment(action)]
                    .filter((part) => part !== "")
                    .join(" ");
                  log(`${head} → ${result.ok ? "ok" : `失败 ${result.error || ""}`}`);
                  if (result?.requiresConfirmation || result?.error === "mcp-outcome-unknown") {
                    // 结果不明：不回填、不执行同批次后续动作，断点停在 executing 等人工核对
                    outcomeUnknown = true;
                    haltForUnknownOutcome(action, result);
                    break;
                  }
                }
                if (!outcomeUnknown && !stopped) {
                  feedCount += 1;
                  log(`结果回填到网页（第 ${feedCount} 次）…`);
                  const feed = feedPayload(results, feedCount, role);
                  persist({ phase: "delivering", replyId, actionCount: chosen.length });
                  const fed = await deliverSafely(feed);
                  if (!fed.ok) {
                    if (fed.retryable === false) haltForUnknownDelivery(fed.error);
                    else {
                      pendingFeed = feed;
                      pendingReplyId = replyId;
                      pendingActionCount = chosen.length;
                      retryFeedAt = Date.now() + feedRetryMs;
                      log(`回填失败：${fed.error || "unknown"}——已保留结果，将自动重试`);
                    }
                  } else {
                    persist({ phase: "processed", replyId, actionCount: chosen.length });
                    lastPersistedId = replyId;
                    log(`结果回填成功（第 ${feedCount} 次）`);
                  }
                }
              } finally {
                feeding = false;
              }
            } else {
              persist({ phase: "processed", replyId });
              lastPersistedId = replyId;
              // 压缩续接：捕获 ```summary 围栏（compressPayload 的回复形态），
              // 交给调用方确认保存；其余无动作回复走 onReply。
              const summary = extractSummaryFence(text);
              if (summary && onSummary) onSummary(summary);
              else if (onReply) onReply(text);
            }
          }
        }
      } catch (err) {
        if (!stopped) log(`watcher 轮询异常：${err?.message || err}，继续`);
      }
      if (!paused && !stopped) {
        if (typeof driver.waitForChange === "function") {
          // 事件驱动等待：把"等变化/等稳定"下放到浏览器内执行（250ms 页内
          // 轮询），变化瞬间经 CDP 唤醒 Node，省掉空闲期的无效快照。
          // 分片 bounded（≤sliceMs），stop/心跳/提醒仍按时服务。
          const wake = await driver.waitForChange(lastSeenSig, {
            stableMs,
            sliceMs: Math.max(intervalMs, 5000),
          });
          lastSeenSig = wake?.sig || lastSeenSig;
          lastWakeSig = wake?.sig || "";
          lastWakeAgoMs = wake?.changedAgoMs ?? 0;
        } else {
          await new Promise((r) => setTimeout(r, intervalMs)); // 假驱动器回退（单测）
        }
      }
    }
  })();

  // 非阻塞停止信号：禁止开始下一项动作/回填，但不等待在途动作结束。
  // 收尾顺序（cli）：signal → 关 MCP（释放在途请求）→ await stop() → 关浏览器，
  // 避免退出被在途工具调用拖到超时。
  const stop = async () => {
    signal();
    await loop;
  };
  stop.pause = async () => {
    if (stopped) return;
    paused = true;
    if (!pauseAcknowledged) {
      await new Promise((resolve) => pauseWaiters.push(resolve));
    }
  };
  stop.resume = () => {
    if (stopped) return;
    paused = false;
    for (const resolve of pauseWaiters.splice(0)) resolve();
    wakePausedLoop?.();
  };
  stop.isPaused = () => paused && pauseAcknowledged;
  stop.isStopped = () => stopped;
  stop.signal = signal;
  return stop;
}
