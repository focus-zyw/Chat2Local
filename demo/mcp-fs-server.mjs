#!/usr/bin/env node
/**
 * 只读+受控写入文件系统 MCP server（stdio transport，零依赖）。
 *
 * 只读四工具：目录遍历隐藏敏感文件，显式读取敏感路径拒绝，语义与内置 host
 * 动作同源（复用 src/sensitive-paths.mjs 与 LS_IGNORED_DIRS，改一处两边同步）。
 * 写入两工具（P60）：write_file（dryRun 预览 + 覆盖留 .bak 备份）与
 * create_directory（幂等）；写入仍拒敏感路径/越界/符号链接，并且 host 侧
 * 另有会话级写入门控（默认拒绝，用户终端 允许写入 后本会话放行）——双层门。
 *
 * 用法：node demo/mcp-fs-server.mjs <root1> [root2 ...]
 * 授权根目录启动时冻结（realpath 解析后比对），越界（含符号链接/目录联接逃逸）
 * 一律拒绝；相对路径按第一个根解析，与启动 cwd 无关。
 * 协议：stdin/stdout 上的换行分隔 JSON-RPC 2.0（MCP stdio transport）。
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { isSensitivePath } from "../src/sensitive-paths.mjs";
import { LS_IGNORED_DIRS } from "../src/host-actions.mjs";

const OUTPUT_MAX_CHARS = 7000; // 回填上限需低于桥接端 8000：给截断提示留余量
const READ_MAX_FILES = 10;
const READ_FILE_MAX_BYTES = 1_000_000;
const TREE_MAX_ENTRIES = 400;
const TREE_MAX_DEPTH = 6;

const roots = [];
for (const raw of process.argv.slice(2)) {
  const real = await fs.realpath(path.resolve(raw)).catch(() => null);
  const st = real ? await fs.stat(real).catch(() => null) : null;
  if (!st?.isDirectory()) {
    process.stderr.write(`[mcp-fs-readonly] 授权目录不存在或不是目录：${raw}\n`);
    process.exit(1);
  }
  roots.push(real);
}
if (roots.length === 0) {
  process.stderr.write("[mcp-fs-readonly] 用法：node demo/mcp-fs-server.mjs <root1> [root2 ...]\n");
  process.exit(1);
}
process.stderr.write(
  `[mcp-fs-readonly] 就绪，授权目录（realpath，已冻结）：${roots.map((r, i) => `R${i + 1}=${r}`).join(" ")}\n`
);

function clip(text) {
  const t = String(text ?? "").trimEnd();
  if (t.length <= OUTPUT_MAX_CHARS) return t;
  return `${t.slice(0, OUTPUT_MAX_CHARS)}\n[输出超过 ${OUTPUT_MAX_CHARS} 字符已截断——收窄范围后重试]`;
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function display(root, rel) {
  const norm = rel.split(path.sep).join("/");
  return roots.length > 1 ? `[R${roots.indexOf(root) + 1}] ${norm}` : norm;
}

function withinRoot(root, candidate) {
  const base = process.platform === "win32" ? root.toLowerCase() : root;
  const target = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return target === base || target.startsWith(prefix);
}

/** 请求路径 → 授权根内的真实路径；缺失/越界/敏感分别给出明确错误。
 * createMode: 目标自身允许不存在（写入/建目录），realpath 失败时回退到
 * 最近存在的父目录做越界与敏感复核，最终路径按请求路径拼回。 */
async function resolveTarget(rawPath, { createMode = false } = {}) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return { error: "缺少路径参数" };
  if (isSensitivePath(raw)) return { error: "已拒绝：敏感路径不通过本工具暴露", sensitive: true };
  const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(roots[0], raw));
  if (!roots.some((r) => withinRoot(r, abs))) {
    return { error: `路径越界（不在授权目录内）：${raw}` };
  }
  let real = await fs.realpath(abs).catch(() => null);
  if (!real) {
    if (!createMode) return { error: `路径不存在或不可访问：${raw}` };
    // 自底向上找最近存在的祖先：逐段 realpath，父级也缺失时继续上溯
    let parent = path.dirname(abs);
    let ancestor = null;
    while (parent !== path.dirname(parent)) {
      ancestor = await fs.realpath(parent).catch(() => null);
      if (ancestor) break;
      parent = path.dirname(parent);
    }
    if (!ancestor) return { error: `路径不存在且无法定位父目录：${raw}` };
    const rootA = roots.find((r) => withinRoot(r, ancestor)) ?? null;
    if (!rootA) return { error: `路径越界（不在授权目录内）：${raw}` };
    const relA = path.relative(rootA, ancestor);
    if (isSensitivePath(relA) || isSensitivePath(path.relative(rootA, abs))) {
      return { error: "已拒绝：敏感路径不通过本工具暴露", sensitive: true };
    }
    // 最终路径不得逃出该根：按前缀关系复核
    if (!withinRoot(rootA, abs)) return { error: `路径越界（不在授权目录内）：${raw}` };
    return { real: abs, root: rootA, rel: path.relative(rootA, abs) };
  }
  const root = roots.find((r) => withinRoot(r, real)) ?? null;
  if (!root) return { error: `路径越界（不在授权目录内）：${raw}` };
  const rel = path.relative(root, real);
  if (isSensitivePath(rel)) return { error: "已拒绝：敏感路径不通过本工具暴露", sensitive: true };
  return { real, root, rel };
}

async function readBoundedText(file) {
  // 支持的平台上禁止最终路径被换成链接，且打开 FIFO 等特殊文件时不阻塞。
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const fh = await fs.open(file, flags);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: st.isDirectory() ? "directory" : "not-file" };
    if (st.size > READ_FILE_MAX_BYTES) return { kind: "too-large" };
    const chunks = [];
    let offset = 0;
    while (offset <= READ_FILE_MAX_BYTES) {
      const buf = Buffer.allocUnsafe(Math.min(65536, READ_FILE_MAX_BYTES + 1 - offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (!bytesRead) break;
      const part = buf.subarray(0, bytesRead);
      if (part.includes(0)) return { kind: "binary" };
      chunks.push(part);
      offset += bytesRead;
    }
    if (offset > READ_FILE_MAX_BYTES) return { kind: "too-large" };
    return { kind: "text", text: Buffer.concat(chunks).toString("utf8") };
  } finally {
    await fh.close();
  }
}

async function listDirectory(args) {
  const t = await resolveTarget(args?.path ?? ".");
  if (t.error) return { isError: true, text: t.error };
  const entries = (await fs.readdir(t.real, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const lines = [];
  let hidden = 0;
  for (const e of entries) {
    if (isSensitivePath(e.name)) {
      hidden += 1;
      continue;
    }
    const tag = e.isDirectory() ? "[DIR] " : "";
    let size = "";
    if (args?.withSizes === true && e.isFile()) {
      // lstat 不跟随符号链接/目录联接；目录项在 readdir 后变成链接也不会越界查询目标。
      const st = await fs.lstat(path.join(t.real, e.name)).catch(() => null);
      if (st?.isFile()) size = ` (${fmtSize(st.size)})`;
    }
    lines.push(`${tag}${e.name}${size}`);
  }
  const note = hidden ? `\n(已隐藏 ${hidden} 个敏感文件/目录)` : "";
  return { text: (lines.length ? lines.join("\n") : "(空目录)") + note };
}

async function directoryTree(args) {
  const t = await resolveTarget(args?.path ?? ".");
  if (t.error) return { isError: true, text: t.error };
  const maxDepth = Math.min(Math.max(Math.floor(Number(args?.maxDepth)) || TREE_MAX_DEPTH, 1), TREE_MAX_DEPTH);
  const lines = [];
  let hidden = 0;
  let skipped = false;
  let count = 0;
  const walk = async (dir, depth, prefix) => {
    if (count >= TREE_MAX_ENTRIES) return;
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const e of entries) {
      if (count >= TREE_MAX_ENTRIES) return;
      if (isSensitivePath(e.name)) {
        hidden += 1;
        continue;
      }
      count += 1;
      const isDir = e.isDirectory();
      const noDescend = isDir && LS_IGNORED_DIRS.has(e.name);
      if (noDescend) skipped = true;
      lines.push(`${prefix}${isDir ? "[DIR] " : ""}${e.name}${noDescend ? "（未下钻）" : ""}`);
      if (isDir && !noDescend && depth < maxDepth) await walk(path.join(dir, e.name), depth + 1, `${prefix}  `);
    }
  };
  await walk(t.real, 1, "");
  const notes = [];
  if (hidden) notes.push(`已隐藏 ${hidden} 个敏感文件/目录`);
  if (count >= TREE_MAX_ENTRIES) notes.push(`已达 ${TREE_MAX_ENTRIES} 项上限，截断`);
  if (skipped) notes.push("依赖/构建目录未下钻");
  return { text: `${lines.join("\n") || "(空目录)"}${notes.length ? `\n(${notes.join("；")})` : ""}` };
}

async function readMultipleFiles(args) {
  const rawList = Array.isArray(args?.paths) ? args.paths.map(String) : [];
  if (!rawList.length) return { isError: true, text: "缺少 paths（字符串数组，最多 10 个）" };
  if (rawList.length > READ_MAX_FILES) rawList.length = READ_MAX_FILES;
  const parts = [];
  for (const raw of rawList) {
    const t = await resolveTarget(raw);
    if (t.error) {
      parts.push(`${raw}: ✗ ${t.error}`);
      continue;
    }
    let read;
    try {
      read = await readBoundedText(t.real);
    } catch {
      parts.push(`${raw}: ✗ 路径不存在或不可访问`);
      continue;
    }
    if (read.kind === "directory") parts.push(`${raw}: ✗ 是目录不是文件`);
    else if (read.kind === "too-large") parts.push(`${raw}: ✗ 超过单文件上限（1 MB）`);
    else if (read.kind === "binary") parts.push(`${raw}: (二进制文件，未读取)`);
    else if (read.kind === "not-file") parts.push(`${raw}: ✗ 不是普通文件`);
    else parts.push(`${display(t.root, t.rel)}:\n${read.text.trimEnd()}`);
  }
  return { text: parts.join("\n---\n") };
}

async function getFileInfo(args) {
  const t = await resolveTarget(args?.path ?? "");
  if (t.error) return { isError: true, text: t.error };
  const st = await fs.stat(t.real).catch(() => null);
  if (!st) return { isError: true, text: `路径不存在或不可访问：${args?.path}` };
  const type = st.isDirectory() ? "目录" : "文件";
  const size = st.isDirectory() ? "（目录不统计）" : `${st.size} 字节（${fmtSize(st.size)}）`;
  return {
    text:
      `路径: ${display(t.root, t.rel)}\n类型: ${type}\n大小: ${size}\n` +
      `创建: ${st.birthtime.toISOString()}\n修改: ${st.mtime.toISOString()}`,
  };
}

// ── 写入类工具（P60/P61）：写入属于副作用操作，除 server 自身边界外还受
// host 侧审批模式约束（逐笔询问默认，详见 src/write-gate.mjs）。
// 敏感路径与越界一律拒绝；write 覆盖已有文件前在同一目录留 .bak 备份；
// dryRun 返回风险分级（首行「风险: X」供 host 解析）+ 统一 diff，不落盘。
// 本会话成功写入记录进撤销栈，undo_write 工具逐笔回退（user/模型都可调用，
// 模型调用同样受写门控）。

const WRITE_MAX_BYTES = 1_000_000;
const UNDO_STACK_MAX = 50;
const sessionTouched = new Set(); // 本会话成功写过的 rel（风险评估用）
const undoStack = []; // {describe, kind:"file"|"dir", real, rel, prevExisted, prevContent|null}

/** LCS 行级差异（+/- 前缀），输出限 maxLines 行。 */
function lineDiff(oldText, newText, maxLines = 60) {
  const a = String(oldText).split("\n");
  const b = String(newText).split("\n");
  if (a.length > 1500 || b.length > 1500) {
    return `（内容过长，仅显示规模：${a.length} 行 → ${b.length} 行）`;
  }
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  const push = (line) => {
    out.push(line);
    return out.length >= maxLines;
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      if (push(`- ${a[i]}`)) return `${out.join("\n")}\n（差异过大，已省略）`;
      i += 1;
    } else {
      if (push(`+ ${b[j]}`)) return `${out.join("\n")}\n（差异过大，已省略）`;
      j += 1;
    }
  }
  while (i < n) {
    if (push(`- ${a[i]}`)) return `${out.join("\n")}\n（差异过大，已省略）`;
    i += 1;
  }
  while (j < m) {
    if (push(`+ ${b[j]}`)) return `${out.join("\n")}\n（差异过大，已省略）`;
    j += 1;
  }
  return out.join("\n") || "（无差异）";
}

const NEW_LINES_PREVIEW = 40;

function writeFileDryRun(t, content, old) {
  const newBytes = Buffer.byteLength(content, "utf8");
  if (!old) {
    const preview = content
      .split("\n")
      .slice(0, NEW_LINES_PREVIEW)
      .map((l) => `+ ${l}`)
      .join("\n");
    const more = content.split("\n").length > NEW_LINES_PREVIEW ? `\n（其余 ${content.split("\n").length - NEW_LINES_PREVIEW} 行省略）` : "";
    return `风险: 新建\n${preview}${more}`;
  }
  if (old.kind === "binary") return { isError: true, text: "目标是二进制文件，拒绝覆盖（保护未知内容）" };
  if (old.kind !== "text") return { isError: true, text: "原内容不可读取，拒绝覆盖" };
  if (old.text === content) return `风险: 无变化\n（新旧内容完全一致，写入为空操作）`;
  const risk = sessionTouched.has(t.rel) ? "会话内已写" : "覆盖已有内容";
  return `风险: ${risk}\n${lineDiff(old.text, content)}`;
}

async function writeFileTool(args) {
  const dryRun = args?.dryRun === true;
  const t = await resolveTarget(args?.path ?? "", { createMode: true });
  if (t.error) return { isError: true, text: t.error };
  const content = typeof args?.content === "string" ? args.content : "";
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX_BYTES) {
    return { isError: true, text: `写入内容超过 ${WRITE_MAX_BYTES} 字节上限` };
  }
  const st = await fs.lstat(t.real).catch(() => null);
  if (st?.isDirectory()) return { isError: true, text: `目标是目录，不能作为文件写入：${args?.path}` };
  if (st?.isSymbolicLink()) return { isError: true, text: "目标是符号链接，拒绝写入" };
  const old = st?.isFile() ? await readBoundedText(t.real).catch(() => null) : null;
  if (dryRun) return { text: writeFileDryRun(t, content, old) };
  if (old?.kind === "binary") return { isError: true, text: "目标是二进制文件，拒绝覆盖（保护未知内容）" };
  let backupNote = "";
  if (old?.kind === "text") {
    // 覆盖前备份：同目录 .bak，覆盖旧备份（只保留一代，避免无限堆积）
    await fs.copyFile(t.real, t.real + ".bak").catch(() => {});
    backupNote = "（原内容已备份为 .bak）";
  }
  await fs.writeFile(t.real, content, "utf8");
  sessionTouched.add(t.rel);
  undoStack.push({
    kind: "file",
    real: t.real,
    rel: t.rel,
    prevExisted: Boolean(old?.kind === "text"),
    prevContent: old?.kind === "text" ? old.text : null,
    describe: `write_file ${display(t.root, t.rel)}${old?.kind === "text" ? `（已恢复 ${Buffer.byteLength(old.text, "utf8")} 字节原内容）` : "（已删除新建文件）"}`,
  });
  if (undoStack.length > UNDO_STACK_MAX) undoStack.shift();
  return { text: `已写入 ${display(t.root, t.rel)}（${Buffer.byteLength(content, "utf8")} 字节）${backupNote}` };
}

async function createDirectoryTool(args) {
  const dryRun = args?.dryRun === true;
  const t = await resolveTarget(args?.path ?? "", { createMode: true });
  if (t.error) return { isError: true, text: t.error };
  const st = await fs.lstat(t.real).catch(() => null);
  if (st?.isDirectory()) return { text: dryRun ? "风险: 无变化\n（目录已存在）" : `目录已存在：${display(t.root, t.rel)}` };
  if (st) return { isError: true, text: `路径已存在且不是目录：${args?.path}` };
  if (dryRun) return { text: "风险: 新建\n（将创建目录）" };
  await fs.mkdir(t.real, { recursive: true });
  undoStack.push({
    kind: "dir",
    real: t.real,
    rel: t.rel,
    describe: `create_directory ${display(t.root, t.rel)}（目录需为空才能撤销）`,
  });
  if (undoStack.length > UNDO_STACK_MAX) undoStack.shift();
  return { text: `已创建目录 ${display(t.root, t.rel)}` };
}

async function undoWriteTool() {
  const rec = undoStack[undoStack.length - 1];
  if (!rec) {
    return { isError: true, text: "没有可撤销的写入（本会话尚未成功写入，或已全部撤销）" };
  }
  try {
    if (rec.kind === "file") {
      if (rec.prevExisted) await fs.writeFile(rec.real, rec.prevContent ?? "", "utf8");
      else await fs.unlink(rec.real);
      sessionTouched.delete(rec.rel);
    } else {
      await fs.rmdir(rec.real); // 非空目录会抛错：不撤销、不弹出，保留现场
    }
  } catch (err) {
    return { isError: true, text: `撤销失败：${err?.message || err}（记录保留，可重试）` };
  }
  undoStack.pop();
  return { text: `已撤销最近一次写入：${rec.describe}` };
}

const TOOLS = [
  {
    name: "list_directory",
    description: "列出目录的直接子项（只读）。敏感文件/目录不展示并提示隐藏数量；withSizes=true 附带文件大小。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标目录，相对路径按第一个授权目录解析（默认根目录）" },
        withSizes: { type: "boolean", description: "附带文件大小（默认 false）" },
      },
    },
    run: listDirectory,
  },
  {
    name: "directory_tree",
    description: "递归目录树（只读，默认深度 6、上限 400 项）。隐藏敏感文件/目录，依赖与构建目录不展开。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "起点目录（默认第一个授权目录）" },
        maxDepth: { type: "number", description: "递归深度上限，默认 6，最大 6" },
      },
    },
    run: directoryTree,
  },
  {
    name: "read_multiple_files",
    description: "一次读取多个文本文件（只读，最多 10 个）。缺失/越界/敏感/超大文件逐项报错，不影响其余文件。",
    schema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "文件路径数组" },
      },
      required: ["paths"],
    },
    run: readMultipleFiles,
  },
  {
    name: "get_file_info",
    description: "查看文件/目录元数据（只读）：类型、大小、创建与修改时间。敏感路径拒绝。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径" },
      },
      required: ["path"],
    },
    run: getFileInfo,
  },
  {
    name: "write_file",
    description: "写入文本文件（写入类，host 侧审批模式约束）。dryRun:true 返回风险分级与新旧内容 diff，不落盘；覆盖已有文件自动留 .bak 备份；本会话写入可用 undo_write 撤销。敏感路径/越界/二进制/符号链接拒绝。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径" },
        content: { type: "string", description: "要写入的完整文本内容" },
        dryRun: { type: "boolean", description: "只预览不写入（默认 false）" },
      },
      required: ["path", "content"],
    },
    run: writeFileTool,
  },
  {
    name: "create_directory",
    description: "创建目录（写入类，host 侧审批模式约束；已存在时幂等成功）。dryRun:true 只预览不创建。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标目录路径" },
        dryRun: { type: "boolean", description: "只预览不创建（默认 false）" },
      },
      required: ["path"],
    },
    run: createDirectoryTool,
  },
  {
    name: "undo_write",
    description: "撤销本会话最近一次成功的 write_file/create_directory（写入类，host 侧审批模式约束）：覆盖型恢复原内容，新建型删除文件；逐笔回退，不能跨越。",
    schema: { type: "object", properties: {} },
    run: undoWriteTool,
  },
];

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-fs-readonly", version: "0.1.0" },
        },
      };
    case "tools/list":
      return {
        result: {
          tools: TOOLS.map(({ name, description, schema }) => ({
            name,
            description,
            inputSchema: schema,
            annotations: { readOnlyHint: true },
          })),
        },
      };
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return { error: { code: -32602, message: `未知工具：${name || "(缺失)"}——本 server 只提供 ${TOOLS.map((t) => t.name).join("/")}` } };
      }
      try {
        const r = await tool.run(msg.params?.arguments ?? {});
        return { result: { content: [{ type: "text", text: clip(r.text) }], isError: Boolean(r.isError) } };
      } catch (err) {
        return { error: { code: -32603, message: String(err?.message || err) } };
      }
    }
    case "ping":
      return { result: {} };
    default:
      return { error: { code: -32601, message: `方法不存在：${msg.method}` } };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  if (msg.id === undefined || msg.id === null) return; // notification：无需应答
  handle(msg).then((res) => {
    const payload = { jsonrpc: "2.0", id: msg.id };
    if (res.error) payload.error = res.error;
    else payload.result = res.result;
    process.stdout.write(JSON.stringify(payload) + "\n");
  }).catch((err) => {
    const payload = { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message || err) } };
    process.stdout.write(JSON.stringify(payload) + "\n");
  });
});
