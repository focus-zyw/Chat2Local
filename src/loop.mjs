/**
 * 对话轮原语与任务循环。
 *
 * runTurn() 是共享的单轮原语：发送 payload → 回复里有 host 动作就执行并
 * 回填 → 循环，直到一条没有动作的回复（complete）或预算耗尽。返回本轮
 * 收据（含最终给人看的回复）。两个模式都踩在它上面：
 *
 *   orchestrate()  任务模式：firstPayload 开局，```done 块视为终态，
 *                  预算耗尽先发收尾请求，带停滞检测（行为与旧版一致）。
 *   chat 模式      cli.mjs 的 REPL 每次用户输入调一次 runTurn：
 *                  每轮独立的动作预算，结束时机在用户手里。
 */

import { extractActions, normalizeReply, stripActionBlocks } from "./parse.mjs";
import { runAction, KNOWN_OPS } from "./host-actions.mjs";
import {
  firstPayload,
  resultPayload,
  wrapUpPayload,
  auditFixPayload,
  MAX_ACTIONS_PER_ROUND,
} from "./protocol.mjs";

const RUN_TAIL_CHARS = 2000; // 收据里保留的 run 输出尾巴
const MAX_AUDIT_FIXES = 2; // audit 缺段补全次数上限，防止模型反复缺段烧预算
const AUDIT_SECTIONS = ["文档承诺", "代码证据", "验证结果", "未确认项"];
const AUDIT_HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?(?:[①②③④]|[1-4][.)、．])?\s*(文档承诺|代码证据|验证结果|未确认项)(?:\s*[:：]\s*(.*)|\s*)$/;

/**
 * audit 结论必须用四个有序的行首标题分段；标题可带序号、Markdown #，
 * 正文可跟在冒号后或另起行。正文里偶然提及段名不能冒充标题。
 */
function missingAuditSections(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const headings = [];
  for (let line = 0; line < lines.length; line++) {
    const match = lines[line].match(AUDIT_HEADING_RE);
    if (match) headings.push({ name: match[1], inlineBody: match[2] || "", line });
  }

  const invalid = new Set();
  for (let index = 0; index < AUDIT_SECTIONS.length; index++) {
    const expected = AUDIT_SECTIONS[index];
    const heading = headings[index];
    if (!heading || heading.name !== expected) {
      invalid.add(expected);
      continue;
    }
    const nextLine = headings[index + 1]?.line ?? lines.length;
    const body = [heading.inlineBody, ...lines.slice(heading.line + 1, nextLine)].join("\n").trim();
    if (!body) invalid.add(expected);
  }
  for (const extra of headings.slice(AUDIT_SECTIONS.length)) invalid.add(extra.name);
  return AUDIT_SECTIONS.filter((section) => invalid.has(section));
}

/**
 * 单轮对话：发送 → 执行动作 → 回填 → …… → 无动作回复。
 *
 * @param {object} opts
 * @param {boolean} [opts.detectDone]      ```done 块视为终态（任务模式）
 * @param {number}  [opts.stallLimit]      连续 N 次相同回复判定停滞（0=关闭）
 * @param {boolean} [opts.wrapUpOnBudget]  预算耗尽时先发一次收尾请求再放弃
 */
export async function runTurn({
  driver,
  payload,
  root,
  execAction = runAction,
  maxRounds = 12,
  totalMs = Infinity,
  detectDone = false,
  audit = false,
  stallLimit = 0,
  wrapUpOnBudget = false,
  log = () => {},
}) {
  const turn = {
    rounds: 0,
    actions: [], // 每次执行的动作摘要
    ran: [], // run 类动作的 {path, exit, output-tail}
    endReason: "", // complete | round-limit | time-limit | stalled | driver-error | audit-incomplete（仅 audit）
    reply: "", // 最终回复原文
    note: "", // 给人看的正文（complete 时 = reply；预算中止时 = 剥掉动作块的残段）
    error: "",
  };

  const startedAt = Date.now();
  let pending = payload;
  let prevReply = "";
  let stallCount = 0;
  let wrappedUp = false;
  let auditFixes = 0; // audit 缺段补全次数（有上限，防模型反复缺段烧预算）
  const missingSections = (text) => {
    if (!audit) return [];
    return missingAuditSections(text);
  };

  while (true) {
    // ── 预算闸：超限（且还没收过尾）先给一次收尾机会 ──
    const outOfRounds = turn.rounds >= maxRounds;
    const outOfTime = Date.now() - startedAt > totalMs;
    if (outOfRounds || outOfTime) {
      const reason = outOfRounds
        ? `轮数上限 ${maxRounds}`
        : `时长上限 ${Math.round(totalMs / 60000)} 分钟`;
      if (wrapUpOnBudget && !wrappedUp) {
        wrappedUp = true;
        log(`预算到限（${reason}），请求收尾总结`);
        pending = wrapUpPayload(reason);
      } else {
        turn.endReason = outOfRounds ? "round-limit" : "time-limit";
        turn.note = stripActionBlocks(turn.reply);
        break;
      }
    }

    log(`第 ${turn.rounds + 1} 轮：发送 payload（${pending.length} 字符）`);
    const res = await driver.send(pending);
    turn.rounds++;
    if (!res.ok) {
      turn.endReason = "driver-error";
      turn.error = res.error || "send-failed";
      log(`驱动失败：${turn.error}`);
      break;
    }
    const reply = res.text || "";
    log(`回复 ${reply.length} 字符`);
    turn.reply = reply;

    // ── 终态 1（任务模式）：```done 块 ──
    const parsed = extractActions(reply);
    if (detectDone && parsed.done !== null) {
      // audit 校验针对最终展示的内容（done 围栏内文本），而非整条回复
      const missing = missingSections(parsed.done || reply);
      if (missing.length > 0 && auditFixes < MAX_AUDIT_FIXES) {
        auditFixes += 1;
        log(`audit 校验：done 结论缺少 ${missing.join("、")}，请求补全（第 ${auditFixes} 次）`);
        pending = auditFixPayload(missing);
        prevReply = normalizeReply(reply);
        continue;
      }
      if (missing.length > 0) {
        // 补全次数用尽仍缺段：按未完成结束，不得报告成功
        turn.endReason = "audit-incomplete";
        turn.note = parsed.done || reply;
        turn.auditMissing = missing;
        log(`audit 校验：补全 ${auditFixes} 次后结论仍缺段（${missing.join("、")}），按未完成结束`);
        break;
      }
      turn.endReason = "complete";
      turn.note = parsed.done || reply;
      log("收到 done，本轮完成");
      break;
    }

    // ── 终态 2：无动作回复 = 给人看的正文 ──
    if (parsed.actions.length === 0) {
      const missing = missingSections(reply);
      if (missing.length > 0 && auditFixes < MAX_AUDIT_FIXES) {
        auditFixes += 1;
        log(`audit 校验：讲解缺段 ${missing.join("、")}，请求补全（第 ${auditFixes} 次）`);
        pending = auditFixPayload(missing);
        prevReply = normalizeReply(reply);
        continue;
      }
      if (missing.length > 0) {
        turn.endReason = "audit-incomplete";
        turn.note = reply;
        turn.auditMissing = missing;
        log(`audit 校验：补全 ${auditFixes} 次后讲解仍缺段（${missing.join("、")}），按未完成结束`);
        break;
      }
      turn.endReason = "complete";
      turn.note = reply;
      break;
    }

    // ── 停滞检测：同一回复原样再来且没执行任何动作 ──
    const normalized = normalizeReply(reply);
    if (stallLimit > 0 && normalized && normalized === prevReply) {
      stallCount += 1;
      if (stallCount >= stallLimit) {
        turn.endReason = "stalled";
        turn.note = stripActionBlocks(reply);
        log(`连续 ${stallLimit} 轮相同回复，判定停滞`);
        break;
      }
    } else {
      stallCount = 0;
    }
    prevReply = normalized;

    // ── 收尾请求之后不再执行动作——要的是总结，不是更多操作 ──
    if (wrappedUp) {
      turn.endReason = outOfRounds ? "round-limit" : "time-limit";
      turn.note = stripActionBlocks(reply);
      break;
    }

    // ── 执行动作（超本轮上限的动作截掉并告知模型）──
    let actions = parsed.actions;
    let trimmedNote = "";
    if (actions.length > MAX_ACTIONS_PER_ROUND) {
      trimmedNote = `\n[注意：本轮动作超过 ${MAX_ACTIONS_PER_ROUND} 个，只执行了前 ${MAX_ACTIONS_PER_ROUND} 个，其余被丢弃——请分多轮请求]`;
      actions = actions.slice(0, MAX_ACTIONS_PER_ROUND);
    }

    const results = [];
    for (const action of actions) {
      if (!action || typeof action !== "object" || !KNOWN_OPS.includes(String(action.op))) {
        results.push({ action, result: { ok: false, error: "unknown-op", text: "未知 op" } });
        continue;
      }
      log(`执行 ${action.op} ${action.path ?? ""}`);
      let result;
      try {
        result = await execAction(action, root);
      } catch (err) {
        result = { ok: false, error: err?.message || "exec-failed", text: err?.message || "" };
      }
      results.push({ action, result });
      turn.actions.push({
        round: turn.rounds,
        op: action.op,
        path: action.path,
        ok: result.ok,
        error: result.error || "",
      });
      if (action.op === "run") {
        turn.ran.push({
          path: action.path,
          exit: result.exit ?? (result.ok ? 0 : null),
          output: String(result.text ?? "").slice(-RUN_TAIL_CHARS),
        });
      }
    }

    pending = resultPayload(results, turn.rounds, maxRounds) + trimmedNote;
  }

  turn.endReason = turn.endReason || "round-limit";
  return turn;
}

/** 任务模式：一次性派活到终态（```done / 无动作 / 预算 / 停滞）。 */
export async function orchestrate({
  driver,
  task,
  root,
  diagnose = false,
  audit = false,
  role = "code",
  execAction = runAction,
  maxRounds = 12,
  totalMs = 20 * 60 * 1000,
  log = () => {},
}) {
  const turn = await runTurn({
    driver,
    payload: firstPayload(task, root, { diagnose, audit, role }),
    root,
    execAction,
    maxRounds,
    totalMs,
    detectDone: true,
    audit,
    stallLimit: 2,
    wrapUpOnBudget: true,
    log,
  });
  return {
    site: driver.siteId,
    root,
    task,
    rounds: turn.rounds,
    actions: turn.actions,
    ran: turn.ran,
    endReason: turn.endReason,
    note: turn.note,
    reply: turn.reply, // 最终回复原文（诊断"动作块没被识别"时用）
    // 普通任务保持旧 Receipt 字段形状；仅 audit 失败时附加缺失段落。
    ...(turn.auditMissing ? { auditMissing: turn.auditMissing } : {}),
    error: turn.error,
  };
}
