/**
 * 本地文件操作执行器 —— file-tool 的三个能力：读文件 / 读目录结构 / 运行测试文件。
 *
 * 参考 web-tool/native-host/host-actions.js 的路径沙箱设计，但只保留三个只读+
 * 运行 op（read / ls / run），不提供任何写入口，安全面更小：
 * - 所有路径必须是 Host Root 下的相对路径；`..`、绝对路径、盘符一律拒绝。
 * - run 只接受白名单扩展名，带超时（超时 kill 子进程）与输出上限。
 * - read 带 offset/length 分段读；超上限截断并提示续读。
 * - ls 支持递归树，条目封顶；缺失路径返回 "(missing)" 而非报错（便宜探测）。
 *
 * 纯函数式："action in → result out"，无浏览器依赖，可被 node --test 直接测。
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { isSensitivePath } from "./sensitive-paths.mjs";

// ── 上限（与协议提示保持一致；改这里要同步 src/protocol.mjs 的文案）──
export const READ_MAX_CHARS = 12000; // 单次 read 返回的字符上限
export const READ_LINE_DEFAULT_LINES = 40; // read 行号模式默认行数
export const READ_LINE_MAX_LINES = 400; // read 行号模式行数上限
export const READ_LINE_CHARS = 500; // read 行号模式单行字符上限
export const RUN_MAX_CHARS = 8000; // 单次 run 输出的字符上限
export const RUN_TIMEOUT_MS = 120000; // 单次 run 的默认超时
export const RUN_TIMEOUT_MAX_MS = 600000; // run 超时上限
export const LS_MAX_ENTRIES = 500; // 单次 ls 的条目上限
export const SEARCH_DEFAULT_MAX = 50; // search 默认命中数上限
export const SEARCH_MAX_RESULTS = 200; // search 命中数硬上限
export const SEARCH_LINE_CHARS = 200; // search 单行字符上限
export const SEARCH_MAX_FILE_BYTES = 1_000_000; // 超过此大小的文件跳过搜索
export const SEARCH_MAX_FILES = 2000; // 单次 search 最多扫描的文件数
export const SEARCH_MAX_CONTEXT = 3; // search 上下文行数上限
export const KNOWN_OPS = ["read", "ls", "run", "search"];

// 递归 ls 默认跳过的目录：第三方依赖、版本库、构建产物、缓存。
// 它们对理解项目结构是噪音，还会把 LS_MAX_ENTRIES 的清单额度烧光，诱导
// 模型接着去读依赖包内部的文件、浪费后续轮次（真实事故：导师递归读项目，
// 一半条目是 node_modules，然后又去读里面的 package.json）。
// 注意：目录本身仍会出现在清单里（如 `node_modules/`），只是不下钻；
// 单层 ls / 目录 read 不受影响——显式列一层是刻意行为。
export const LS_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "target",
]);

// run 允许的扩展名 → 解释器。不认识的扩展名直接拒绝，避免 EFTYPE 之类的
// spawn 错误让模型摸不着头脑（同 web-tool runFile 的 readable-reason 做法）。
const RUN_WINDOWS_SHELL_EXTS = new Set([".bat", ".cmd"]);

/** 超时时终止整个进程树，避免测试脚本派生的服务或 watcher 留在后台。 */
function terminateProcessTree(child) {
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

/** candidate 必须等于 base 或落在 base 内。两者都应是绝对路径。 */
function isUnderRoot(base, candidate) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(candidate);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolved === resolvedBase || resolved.startsWith(prefix);
}

/** 文本路径必须落在 root 内；返回解析后的绝对路径，越界返回 null。 */
export function underRoot(root, rel) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, rel);
  return isUnderRoot(base, resolved) ? resolved : null;
}

/**
 * 跟随已有路径中的符号链接/目录联接后再次检查沙箱边界。
 * 目标不存在时保留原路径，让 read/ls 延续各自既有的 not-found 语义；
 * 其他真实路径解析错误一律失败关闭，避免权限或链接异常绕过检查。
 */
async function resolveUnderRoot(root, full, rel) {
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch (err) {
    return {
      ok: false,
      error: "host-root",
      text: `Host Root 无法访问：${err.message}`,
    };
  }

  let realFull;
  try {
    realFull = await fs.realpath(full);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return { ok: true, full, realRoot };
    }
    return {
      ok: false,
      error: "host-path",
      text: `无法安全解析路径 "${rel}"：${err.message}`,
    };
  }

  if (!isUnderRoot(realRoot, realFull)) {
    return {
      ok: false,
      error: "host-path",
      text: `路径越界 "${rel}" — 符号链接或目录联接不能指向 Host Root 外`,
    };
  }
  return { ok: true, full: realFull, realRoot };
}

function clip(text, max, hint) {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[truncated ${t.length - max} chars; total ${t.length}${hint}]`;
}

/** 执行一个动作：{op, path, ...} → {ok, text, ...}。root 为 Host Root 绝对路径。 */
export async function runAction(msg, root) {
  if (!msg || typeof msg !== "object") return { ok: false, error: "bad-action" };
  const op = String(msg.op || "");
  if (!KNOWN_OPS.includes(op)) {
    return {
      ok: false,
      error: "unknown-op",
      text: `未知 op "${op}" — 只支持 read / ls / run`,
    };
  }
  const rel = String(msg.path ?? "").trim();
  if (!rel) return { ok: false, error: "bad-path", text: "动作缺少 path" };
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("\\\\")) {
    return {
      ok: false,
      error: "host-path",
      text: `拒绝绝对路径 "${rel}" — 只能用 Host Root 下的相对路径`,
    };
  }
  const full = underRoot(root, rel);
  if (!full) {
    return {
      ok: false,
      error: "host-path",
      text: `路径越界 "${rel}" — 不能用 .. 或越出 Host Root`,
    };
  }
  const checked = await resolveUnderRoot(root, full, rel);
  if (!checked.ok) return checked;
  const realRel = path.relative(checked.realRoot, checked.full);
  if (isSensitivePath(rel) || isSensitivePath(realRel)) {
    return {
      ok: false,
      error: "sensitive-path",
      text: "已拒绝访问敏感路径；请在本机自行检查，勿将凭据回填网页",
    };
  }
  if (op === "read") return readPath(checked.full, rel, msg);
  if (op === "ls") return listPath(checked.full, rel, msg);
  if (op === "run") return runFile(root, checked.full, rel, msg);
  if (op === "search") return searchRoot(checked.realRoot, checked.full, rel, msg);
  return { ok: false, error: "unknown-op" };
}

// ── read：文件内容；两种坐标——字符 offset/length 与 行号 line/lines ──
// 目录读 = 单层清单
async function readUtf8Window(full, offset, requestedLength) {
  const decoder = new StringDecoder("utf8");
  const captureMax = Math.min(requestedLength, READ_MAX_CHARS);
  let captured = "";
  let totalChars = 0;

  const consume = (text) => {
    const chunkStart = totalChars;
    totalChars += text.length;
    if (captured.length >= captureMax || totalChars <= offset) return;
    const from = Math.max(0, offset - chunkStart);
    if (from >= text.length) return;
    captured += text.slice(from, from + captureMax - captured.length);
  };

  for await (const chunk of createReadStream(full)) {
    consume(decoder.write(chunk));
  }
  consume(decoder.end());

  const available = Math.max(0, totalChars - offset);
  const sliceLength = Math.min(requestedLength, available);
  return { captured, sliceLength, totalChars };
}

/**
 * 行号模式开窗：流式计行，返回 [startLine, startLine+requestedLines-1]
 * 的行（1 起始），内存与输出双重有界：
 * - 超长行只保留输出所需前缀（≤ LINE_KEEP），其余直接丢弃，继续计行——
 *   单行再大也不会整行进内存；
 * - 输出累计达到 READ_MAX_CHARS 或行数集满后，停止解码，改为字节级换行
 *   计数（UTF-8 的 0x0A 不会出现在多字节序列内部，字节计数精确），
 *   直到 EOF——totalLines 语义与全量扫描完全一致。
 * 起始行超过总行数时由上层用 totalLines 报错。
 */
const LINE_KEEP = READ_LINE_CHARS; // 超长行保留的前缀（恰为单行输出上限，516 之类余量会造成超发）

async function readLinesWindow(full, startLine, requestedLines) {
  const decoder = new StringDecoder("utf8");
  let kept = ""; // 当前行已保留的前缀（≤ LINE_KEEP）
  let lineNo = 0; // 已确认完成的行数
  let trailing = false; // done 阶段：文件末尾存在无换行符的残余行
  let done = false; // 行收集结束（行数集满或输出达字符上限）
  let used = 0; // 已收集的输出字符数（含行间换行）
  const out = [];
  const endLine = startLine + requestedLines - 1;

  const collectLine = () => {
    lineNo += 1;
    if (done || lineNo < startLine || lineNo > endLine) return;
    const line = `${lineNo}: ${kept.replace(/\r$/, "")}`;
    if (out.length > 0 && used + line.length > READ_MAX_CHARS) {
      done = true; // 总字符到顶：本行起不再收集，剩余行只计数
      return;
    }
    out.push(line);
    used += line.length + 1;
    if (out.length >= requestedLines) done = true;
  };

  const consume = (piece) => {
    while (piece.length > 0) {
      const nl = piece.indexOf("\n");
      if (nl === -1) {
        if (kept.length < LINE_KEEP) kept += piece.slice(0, LINE_KEEP - kept.length);
        // done 后同 chunk 的残余是未终止行：留给 EOF 计数（trailing）
        if (done) trailing = true;
        return; // 行未结束；超长行超出前缀的部分直接丢弃
      }
      if (kept.length < LINE_KEEP) kept += piece.slice(0, Math.min(nl, LINE_KEEP - kept.length));
      collectLine();
      kept = "";
      piece = piece.slice(nl + 1);
    }
  };

  const countNewlines = (buf) => {
    let from = 0;
    let idx;
    while ((idx = buf.indexOf(10, from)) !== -1) {
      lineNo += 1;
      from = idx + 1;
    }
    trailing = from < buf.length; // 末尾无换行的残余字节是一行
  };

  for await (const chunk of createReadStream(full)) {
    if (!done) consume(decoder.write(chunk));
    else countNewlines(chunk);
  }
  if (!done) {
    consume(decoder.end());
    if (kept !== "") {
      // 末行无换行符：计行；若仍在窗口内且未到字符上限则输出
      lineNo += 1;
      if (lineNo >= startLine && lineNo <= endLine) {
        const line = `${lineNo}: ${kept.replace(/\r$/, "")}`;
        if (!(out.length > 0 && used + line.length > READ_MAX_CHARS)) out.push(line);
      }
    }
  } else if (trailing) {
    // done 阶段字节计数确认的末尾残余行（kept 属于已计数行，不能再 +1）
    lineNo += 1;
  }

  return { out, totalLines: lineNo, capped: done && out.length < requestedLines };
}

function clipLine(text, max) {
  const t = String(text ?? "");
  return t.length <= max ? t : t.slice(0, max) + "…";
}

async function readPath(full, rel, msg) {
  let st;
  try {
    st = await fs.stat(full);
  } catch {
    return { ok: false, error: "not-found", text: `read ${rel}: 文件不存在` };
  }
  if (st.isDirectory()) {
    const entries = await fs.readdir(full, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const visible = entries.filter((e) => !isSensitivePath(e.name));
    const truncated = visible.length > LS_MAX_ENTRIES;
    const lines = visible
      .slice(0, LS_MAX_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (truncated) {
      lines.push(`[listing truncated at ${LS_MAX_ENTRIES} entries — 换更窄的 path]`);
    }
    return {
      ok: true,
      op: "read",
      path: rel,
      dir: true,
      text: lines.length ? lines.join("\n") : "(empty)",
    };
  }
  // 行号模式：有 line 参数即按行开窗（1 起始），与 search 输出同坐标
  if (Number.isFinite(Number(msg.line)) && Number(msg.line) >= 1) {
    const startLine = Math.floor(Number(msg.line));
    const requestedLines =
      Number.isFinite(Number(msg.lines)) && Number(msg.lines) > 0
        ? Math.min(Math.floor(Number(msg.lines)), READ_LINE_MAX_LINES)
        : READ_LINE_DEFAULT_LINES;
    let win;
    try {
      win = await readLinesWindow(full, startLine, requestedLines);
    } catch (err) {
      return { ok: false, error: "read-failed", text: `read ${rel}: ${err.message}` };
    }
    if (startLine > win.totalLines) {
      return {
        ok: false,
        error: "out-of-range",
        text: `read ${rel}: line ${startLine} 超出范围（文件共 ${win.totalLines} 行）`,
      };
    }
    let text = win.out.join("\n");
    const nextLine = startLine + win.out.length;
    if (win.capped) {
      // 输出达到总字符上限：窗口内剩余行未返回，续读行号衔接
      text += `\n[结果达到 ${READ_MAX_CHARS} 字符上限，窗口内其余行未返回 — 用 {"op":"read","path":"${rel}","line":${nextLine},"lines":${requestedLines}} 继续读]`;
    } else if (nextLine <= win.totalLines) {
      text += `\n（后续行用 {"op":"read","path":"${rel}","line":${nextLine}} 续读）`;
    } else {
      text += `\n（已到文件末尾，共 ${win.totalLines} 行）`;
    }
    return { ok: true, op: "read", path: rel, lineMode: true, text, totalLines: win.totalLines };
  }

  const offset =
    Number.isFinite(Number(msg.offset)) && Number(msg.offset) >= 0
      ? Math.floor(Number(msg.offset))
      : 0;
  const requestedLength =
    Number.isFinite(Number(msg.length)) && Number(msg.length) > 0
      ? Math.floor(Number(msg.length))
      : Number.POSITIVE_INFINITY;
  let window;
  try {
    window = await readUtf8Window(full, offset, requestedLength);
  } catch (err) {
    return { ok: false, error: "read-failed", text: `read ${rel}: ${err.message}` };
  }
  let body = window.captured;
  if (window.sliceLength > READ_MAX_CHARS) {
    body +=
      `\n[truncated ${window.sliceLength - READ_MAX_CHARS} chars; total ${window.sliceLength}` +
      ` — 用 {"op":"read","path":"${rel}","offset":${offset + READ_MAX_CHARS}} 续读]`;
  }
  return { ok: true, op: "read", path: rel, text: body, size: window.totalChars };
}

// ── ls：单层或递归树；缺失返回 "(missing)"（探测便宜，不烧一轮）──
async function listPath(full, rel, msg) {
  let st;
  try {
    st = await fs.stat(full);
  } catch {
    return { ok: true, op: "ls", path: rel, dir: true, text: "(missing)" };
  }
  if (!st.isDirectory()) {
    return { ok: true, op: "ls", path: rel, dir: true, text: path.basename(full) };
  }
  const entries = [];
  const walk = async (dir, prefix) => {
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不可读子目录跳过，不致命
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of names) {
      if (entries.length >= LS_MAX_ENTRIES) return;
      const isDir = e.isDirectory();
      const r = prefix ? `${prefix}/${e.name}` : e.name;
      if (isSensitivePath(r)) continue;
      entries.push(isDir ? `${r}/` : r);
      // 递归时跳过依赖/构建目录（目录名本身已出现在清单里）
      if (msg.recursive === true && isDir && !LS_IGNORED_DIRS.has(e.name)) {
        await walk(path.join(dir, e.name), r);
      }
    }
  };
  await walk(full, "");
  let text = entries.length ? entries.join("\n") : "(empty)";
  if (entries.length >= LS_MAX_ENTRIES) {
    text += `\n[listing truncated at ${LS_MAX_ENTRIES} entries — 换更窄的 path 或去掉 recursive]`;
  }
  return { ok: true, op: "ls", path: rel, dir: true, text };
}

// ── run：白名单扩展名 + 超时 kill + 输出封顶；cwd = Host Root ──
function runFile(root, full, rel, msg) {
  return new Promise((resolve) => {
    // 白名单以用户请求的路径为准，避免链接目标扩展名改变执行方式。
    const ext = path.extname(rel).toLowerCase();
    let command = null;
    let commandArgs = [];
    let fileOpts = { cwd: root };
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      command = process.execPath;
      commandArgs = [full];
    } else if (ext === ".py") {
      command = process.platform === "win32" ? "python" : "python3";
      commandArgs = [full];
    } else if (ext === ".ps1") {
      command = "powershell";
      commandArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", full];
    } else if (RUN_WINDOWS_SHELL_EXTS.has(ext)) {
      command = "cmd.exe";
      commandArgs = ["/c", full];
    } else if (ext === ".exe") {
      command = full;
    } else {
      return resolve({
        ok: false,
        error: "cannot-execute",
        text: `cannot run ${rel}: 不支持的文件类型 (${ext || "无扩展名"}) — 可运行 .js/.mjs/.cjs/.py/.ps1/.bat/.cmd/.exe`,
      });
    }

    const args = Array.isArray(msg.args) ? msg.args.map(String).slice(0, 8) : [];
    const timeoutMs =
      Number.isFinite(Number(msg.timeoutMs)) && Number(msg.timeoutMs) > 0
        ? Math.min(Math.floor(Number(msg.timeoutMs)), RUN_TIMEOUT_MAX_MS)
        : RUN_TIMEOUT_MS;

    let child;
    try {
      child = spawn(command, [...commandArgs, ...args], {
        ...fileOpts,
        windowsHide: true,
        // 类 Unix 平台借此获得可整体终止的独立进程组。
        detached: process.platform !== "win32",
      });
    } catch (err) {
      return resolve({ ok: false, error: err.message || "spawn-failed", text: err.message });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (d) => {
      if (stdout.length < RUN_MAX_CHARS * 2) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < RUN_MAX_CHARS * 2) stderr += d.toString("utf8");
    });
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcessTree(child);
      resolve({
        ok: false,
        error: "timeout",
        text: `run ${rel}: 超时 (${Math.round(timeoutMs / 1000)}s) 已终止 — 输出前段:\n${clip(
          [stdout, stderr].filter(Boolean).join("\n"),
          2000,
          ""
        )}`,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || "spawn-failed", text: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve({
        ok: code === 0,
        op: "run",
        path: rel,
        exit: code,
        text: text
          ? clip(text, RUN_MAX_CHARS, " — 输出过长，改用重定向写文件再分段 read")
          : `exit ${code}`,
        error: code === 0 ? "" : `exit ${code}`,
      });
    });
  });
}

// ── search：内容搜索（单文件或目录递归），输出 文件:行号: 内容 ──
// 与 read 行号模式共用行号坐标：search 命中后用 read line=... 精读上下文。

function splitFileLines(text) {
  const arr = String(text ?? "").split("\n");
  if (arr.length && arr[arr.length - 1] === "") arr.pop(); // 末尾换行不产生空行
  return arr.map((l) => l.replace(/\r$/, ""));
}

// 文件名通配：仅支持一个 *（前后缀），如 *.ts、app*、精确名
function wildcardMatch(name, pattern) {
  const i = pattern.indexOf("*");
  if (i === -1) return name === pattern;
  const head = pattern.slice(0, i);
  const tail = pattern.slice(i + 1);
  return (
    name.startsWith(head) && name.endsWith(tail) && name.length >= head.length + tail.length
  );
}

function buildMatcher(msg) {
  const pattern = String(msg.pattern ?? "");
  const ignoreCase = msg.ignoreCase !== false;
  if (msg.regex === true) {
    let re;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (err) {
      return { error: `search: 非法正则 "${pattern}"：${err.message}` };
    }
    return { match: (line) => re.test(line) };
  }
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  return { match: (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle) };
}

/** 搜索单个文件（已过 1MB 筛），返回带 context 的输出行；无命中返回 null。 */
async function searchFile(full, rel, match, context, maxHits = Number.POSITIVE_INFINITY) {
  const text = await fs.readFile(full, "utf8");
  const lines = splitFileLines(text);
  const hitNos = [];
  let truncated = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (!match(lines[idx])) continue;
    if (hitNos.length >= maxHits) {
      truncated = true;
      break;
    }
    hitNos.push(idx + 1);
  }
  if (hitNos.length === 0) return null;
  // 合并相邻命中区间，避免 context 重叠时重复输出同一行
  const ranges = [];
  for (const h of hitNos) {
    const lo = Math.max(1, h - context);
    const hi = Math.min(lines.length, h + context);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else ranges.push({ lo, hi });
  }
  const out = [];
  for (const r of ranges) {
    for (let n = r.lo; n <= r.hi; n++) {
      out.push(`${rel}:${n}: ${clipLine(lines[n - 1], SEARCH_LINE_CHARS)}`);
    }
  }
  return { out, hits: hitNos.length, truncated };
}

async function searchRoot(root, full, rel, msg) {
  let st;
  try {
    st = await fs.stat(full);
  } catch {
    return { ok: true, op: "search", path: rel, text: "(missing)" };
  }
  if (!String(msg.pattern ?? "")) {
    return { ok: false, error: "bad-pattern", text: "search 缺少 pattern" };
  }
  const matcher = buildMatcher(msg);
  if (matcher.error) return { ok: false, error: "bad-regex", text: matcher.error };

  const maxResults =
    Number.isFinite(Number(msg.maxResults)) && Number(msg.maxResults) > 0
      ? Math.min(Math.floor(Number(msg.maxResults)), SEARCH_MAX_RESULTS)
      : SEARCH_DEFAULT_MAX;
  const context = Math.min(
    Math.max(Math.floor(Number(msg.context)) || 0, 0),
    SEARCH_MAX_CONTEXT
  );
  const include = msg.include ? String(msg.include) : null;

  // 单文件：path 直接指到文件
  if (!st.isDirectory()) {
    if (st.size > SEARCH_MAX_FILE_BYTES) {
      return {
        ok: true,
        op: "search",
        path: rel,
        text: `(no matches)\n（共搜索 0 个文件，跳过 1 个超大/不可读文件）`,
      };
    }
    let hit;
    try {
      hit = await searchFile(full, rel, matcher.match, context, maxResults);
    } catch {
      return {
        ok: true,
        op: "search",
        path: rel,
        text: `(no matches)\n（共搜索 0 个文件，跳过 1 个超大/不可读文件）`,
      };
    }
    const tail = hit?.truncated
      ? `\n[截断于 ${maxResults} 处命中——收窄 pattern/path/include 或提高 maxResults]`
      : "";
    return {
      ok: true,
      op: "search",
      path: rel,
      text: `${hit ? hit.out.join("\n") : "(no matches)"}${tail}`,
    };
  }

  // 目录：递归收集（跳 LS_IGNORED_DIRS 与超限文件），按文件名排序保证输出稳定。
  // include 在收集阶段过滤：不匹配的文件不占用上限，也不计入 filesTruncated。
  const files = [];
  let filesTruncated = false; // 达到文件数上限后，仍有未扫描的「匹配文件」
  const collect = async (dir) => {
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不可读子目录跳过
    }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (isSensitivePath(path.relative(root, p))) continue;
      if (e.isDirectory()) {
        if (!LS_IGNORED_DIRS.has(e.name)) await collect(p);
      } else if (e.isFile()) {
        if (include && !wildcardMatch(e.name, include)) continue;
        if (files.length >= SEARCH_MAX_FILES) {
          filesTruncated = true;
          return;
        }
        files.push(p);
      }
    }
  };
  await collect(full);
  files.sort();

  const prefix = rel === "." || rel === "" ? "" : rel.replace(/\/+$/, "") + "/";
  const out = [];
  let hits = 0;
  let searched = 0;
  let skipped = 0;
  let truncated = false;
  for (const file of files) {
    if (hits >= maxResults) {
      truncated = true;
      break;
    }
    // include 已在 collect 阶段过滤（不占扫描上限），此处无需重复判断
    let size;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      continue;
    }
    if (size > SEARCH_MAX_FILE_BYTES) {
      skipped += 1;
      continue;
    }
    const fileRel = prefix + path.relative(full, file).split(path.sep).join("/");
    let hit;
    const remain = maxResults - hits;
    try {
      hit = await searchFile(file, fileRel, matcher.match, context, remain);
    } catch {
      skipped += 1; // 二进制/非 UTF-8 等
      continue;
    }
    searched += 1;
    if (!hit) continue;
    out.push(...hit.out);
    hits += hit.hits;
    if (hit.truncated) {
      truncated = true;
      break;
    }
  }

  const tail = [
    truncated ? `[截断于 ${maxResults} 处命中——收窄 pattern/path/include 或提高 maxResults]` : null,
    filesTruncated
      ? `[目录扫描达到 ${SEARCH_MAX_FILES} 个文件上限，超出部分未参与搜索——结果可能不完整；请用更窄的 path/include 分次搜索]`
      : null,
    `（共搜索 ${searched} 个文件${skipped ? `，跳过 ${skipped} 个超大/不可读文件` : ""}）`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ok: true,
    op: "search",
    path: rel,
    text: (out.length ? out.join("\n") : "(no matches)") + "\n" + tail,
  };
}
