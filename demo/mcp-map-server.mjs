#!/usr/bin/env node
/**
 * 只读符号地图 MCP server（stdio transport，零依赖）——aider repo-map 思想的
 * 零依赖轻量版：行级启发式（正则 + 缩进状态机）抽取 JS/TS/Python 的函数/
 * 类/方法/函数值常量，输出带行号的紧凑符号地图；引用排序用「标识符出现次数」
 * 轻量替代引用图，字符预算内优先展示被引用最多的文件。
 *
 * 用法：node demo/mcp-map-server.mjs <root1> [root2 ...]
 * 行号与内置 read 的行号模式同坐标（同 search 的 文件:行号: 约定）：地图里的
 * L12 就是 read {"op":"read","path":…,"line":12} 读到的那一行。
 * 授权根启动时 realpath 冻结，越界/敏感路径拒绝，依赖与构建目录不下钻；
 * 启发式抽取可能有个别误报/漏报，行号以 read 实读为准。
 * 协议：stdin/stdout 上的换行分隔 JSON-RPC 2.0（MCP stdio transport）。
 */

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { isSensitivePath } from "../src/sensitive-paths.mjs";
import { LS_IGNORED_DIRS } from "../src/host-actions.mjs";

const OUTPUT_DEFAULT_CHARS = 4000;
const OUTPUT_MAX_CHARS = 7000; // 回填上限需低于桥接端 8000：给截断提示留余量
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_000_000;
const REF_TEXT_MAX_BYTES = 3 * 1024 * 1024; // 出现次数统计的扫描语料上限
const REF_NAMES_MAX = 600; // 超出后只统计前 600 个符号名（按文件顺序）
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py"]);

const roots = [];
for (const raw of process.argv.slice(2)) {
  const real = await fs.realpath(path.resolve(raw)).catch(() => null);
  const st = real ? await fs.stat(real).catch(() => null) : null;
  if (!st?.isDirectory()) {
    process.stderr.write(`[mcp-map-readonly] 授权目录不存在或不是目录：${raw}\n`);
    process.exit(1);
  }
  roots.push(real);
}
if (roots.length === 0) {
  process.stderr.write("[mcp-map-readonly] 用法：node demo/mcp-map-server.mjs <root1> [root2 ...]\n");
  process.exit(1);
}
process.stderr.write(
  `[mcp-map-readonly] 就绪，授权目录（realpath，已冻结）：${roots.map((r, i) => `R${i + 1}=${r}`).join(" ")}\n`
);

// ---- 符号抽取（行级启发式） ----

const JS_COMMENT = /^\s*(\/\/|\/\*|\*|<!--)/;
const RE_JS_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const RE_JS_CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const RE_JS_FN_CONST =
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
const RE_JS_METHOD = /^([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const METHOD_PREFIX_RE = /^(?:static\s+|async\s+|get\s+|set\s+)*/;
const JS_CONTROL_FLOW = new Set(["if", "for", "while", "switch", "catch", "do", "try", "else", "function", "class"]);
const RE_PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const RE_PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;

function extractJsSymbols(lines) {
  const out = [];
  let cls = null; // 当前类体（用于方法归属与缩进判断）
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (JS_COMMENT.test(line)) continue;
    let m = line.match(RE_JS_FUNCTION);
    if (m) {
      out.push({ line: i + 1, kind: "fn", name: m[1] });
      cls = null;
      continue;
    }
    m = line.match(RE_JS_CLASS);
    if (m) {
      out.push({ line: i + 1, kind: "class", name: m[1] });
      cls = m[1];
      continue;
    }
    m = line.match(RE_JS_FN_CONST);
    if (m) {
      out.push({ line: i + 1, kind: "fn", name: m[1] });
      cls = null;
      continue;
    }
    if (cls) {
      const indent = line.match(/^\s*/)[0].length;
      if (indent === 0) {
        cls = null;
        continue;
      }
      const stripped = line.trimStart().replace(METHOD_PREFIX_RE, "");
      const mm = stripped.match(RE_JS_METHOD);
      if (mm && !JS_CONTROL_FLOW.has(mm[1])) {
        out.push({ line: i + 1, kind: "method", name: mm[1], of: cls });
      }
    }
  }
  return out;
}

function extractPySymbols(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith("#")) continue;
    let m = line.match(RE_PY_CLASS);
    if (m) {
      out.push({ line: i + 1, kind: "class", name: m[2] });
      continue;
    }
    m = line.match(RE_PY_DEF);
    if (m) {
      out.push({ line: i + 1, kind: m[1] ? "method" : "fn", name: m[2] });
    }
  }
  return out;
}

// ---- 收集与统计 ----

function withinRoot(rootDir, p) {
  return p === rootDir || p.startsWith(rootDir + path.sep);
}

async function resolveStart(rawPath) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return { real: roots[0], root: roots[0] };
  // 请求路径与真实路径双重核对（与 host 动作及 P56 fs server 同款纪律）：
  // 先拒敏感段与越界的请求路径，再对解析后的真实路径复核，堵联接绕过。
  if (isSensitivePath(raw)) return { error: "已拒绝：敏感路径不通过本工具暴露" };
  const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(roots[0], raw));
  if (!roots.some((r) => withinRoot(r, abs))) return { error: `路径越界（不在授权目录内）：${raw}` };
  const real = await fs.realpath(abs).catch(() => null);
  if (!real) return { error: `路径不存在或不可访问：${raw}` };
  const root = roots.find((r) => withinRoot(r, real)) ?? null;
  if (!root) return { error: `路径越界（不在授权目录内）：${raw}` };
  const rel = path.relative(root, real);
  if (isSensitivePath(rel)) return { error: "已拒绝：敏感路径不通过本工具暴露" };
  return { real, root };
}

/** 单句柄有界读取：fstat 后同句柄最多读 1MB+1 字节（并发增长兜底），含 NUL 视为非代码。 */
async function readBoundedText(file) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const fh = await fs.open(file, flags);
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { kind: st.isDirectory() ? "directory" : "not-file" };
    if (st.size > MAX_FILE_BYTES) return { kind: "too-large" };
    const chunks = [];
    let offset = 0;
    while (offset <= MAX_FILE_BYTES) {
      const buf = Buffer.allocUnsafe(Math.min(65536, MAX_FILE_BYTES + 1 - offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      if (!bytesRead) break;
      if (buf.subarray(0, bytesRead).includes(0)) return { kind: "binary" };
      chunks.push(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) return { kind: "too-large" };
    return { text: Buffer.concat(chunks).toString("utf8") };
  } finally {
    await fh.close();
  }
}

async function collectCodeFiles(startDir, root, out) {
  let names;
  try {
    names = await fs.readdir(startDir, { withFileTypes: true });
  } catch {
    return;
  }
  names.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of names) {
    if (out.length >= MAX_FILES) return;
    const p = path.join(startDir, e.name);
    const rel = path.relative(root, p);
    if (isSensitivePath(rel)) continue;
    if (e.isDirectory()) {
      // 不跟随符号链接/目录联接：防止无邪名联接绕过敏感过滤或逃出授权根
      if (!e.isSymbolicLink() && !LS_IGNORED_DIRS.has(e.name)) await collectCodeFiles(p, root, out);
    } else if (e.isFile() && CODE_EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push({ abs: p, rel });
    }
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function symbolMap(args) {
  const start = await resolveStart(args?.path);
  if (start.error) return { isError: true, text: start.error };
  const maxChars = Math.min(
    Math.max(Math.floor(Number(args?.maxChars)) || OUTPUT_DEFAULT_CHARS, 500),
    OUTPUT_MAX_CHARS
  );

  const files = [];
  await collectCodeFiles(start.real, start.root, files);
  if (!files.length) return { text: "(授权范围内没有代码文件——支持 .js/.mjs/.cjs/.ts/.tsx/.jsx/.py)" };

  const refChunks = [];
  let refBytes = 0;
  const perFile = [];
  let skipped = 0;
  for (const f of files) {
    const r = await readBoundedText(f.abs).catch(() => null);
    if (!r || r.kind) {
      if (r?.kind === "too-large" || r?.kind === "binary") skipped += 1;
      continue;
    }
    const text = r.text;
    const lines = text.split("\n");
    const syms = path.extname(f.abs) === ".py" ? extractPySymbols(lines) : extractJsSymbols(lines);
    if (syms.length) perFile.push({ rel: f.rel.split(path.sep).join("/"), syms });
    if (refBytes < REF_TEXT_MAX_BYTES) {
      refChunks.push(text);
      refBytes += Buffer.byteLength(text, "utf8");
    }
  }
  if (!perFile.length) return { text: "(扫描完成，未抽取到任何符号——启发式仅覆盖函数/类/方法/函数值常量)" };

  // 出现次数（含声明）：轻量替代 aider 的引用图排序
  const names = [];
  const seen = new Set();
  outer: for (const f of perFile) {
    for (const s of f.syms) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      names.push(s.name);
      if (names.length >= REF_NAMES_MAX) break outer;
    }
  }
  const refText = refChunks.join("\n");
  const counts = new Map();
  for (const name of names) {
    counts.set(name, (refText.match(new RegExp(`\\b${escapeRe(name)}\\b`, "g")) || []).length);
  }

  // 文件按「本文件符号的最高出现次数」降序，同分按路径升序——被引用最多的先进预算
  const ranked = perFile
    .map((f) => ({ ...f, top: Math.max(...f.syms.map((s) => counts.get(s.name) ?? 0)) }))
    .sort((a, b) => b.top - a.top || a.rel.localeCompare(b.rel));

  const outLines = [];
  let used = 0;
  let shown = 0;
  for (const f of ranked) {
    const parts = f.syms.map(
      (s) =>
        `L${s.line} ${s.kind} ${s.name}${s.of ? `(${s.of})` : ""}${(counts.get(s.name) ?? 0) > 1 ? ` ×${counts.get(s.name)}` : ""}`
    );
    const line = `${f.rel}: ${parts.join(" · ")}`;
    if (used + line.length > maxChars) break;
    outLines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  const totalSymbols = ranked.reduce((n, f) => n + f.syms.length, 0);
  const notes = [
    `共 ${files.length} 个代码文件、${totalSymbols} 个符号`,
    "行号与 read 的 line 参数同坐标；×N 为全库标识符出现次数（含声明）",
  ];
  if (skipped) notes.push(`${skipped} 个超大/二进制文件已跳过`);
  if (shown < ranked.length) notes.push(`已按 ${maxChars} 字符预算截断，${ranked.length - shown} 个文件未展示`);
  return { text: `${outLines.join("\n")}\n(${notes.join("；")})` };
}

// ---- MCP stdio 协议 ----

const TOOLS = [
  {
    name: "symbol_map",
    description:
      "生成代码符号地图（只读）：每个代码文件一行，列出函数/类/方法/函数值常量及行号，被引用最多的文件排前。行号与 read 动作的 line 参数同坐标，可按行号直接精读；支持 .js/.mjs/.cjs/.ts/.tsx/.jsx/.py。",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "只扫描该子目录（默认整个授权目录）" },
        maxChars: { type: "number", description: `输出字符预算，默认 ${OUTPUT_DEFAULT_CHARS}，最小 500，最大 ${OUTPUT_MAX_CHARS}` },
      },
    },
    run: symbolMap,
  },
];

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-map-readonly", version: "0.1.0" },
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
        return { error: { code: -32602, message: `未知工具：${name || "(缺失)"}——本 server 只提供 symbol_map` } };
      }
      try {
        const r = await tool.run(msg.params?.arguments ?? {});
        const t = String(r.text ?? "").trimEnd();
        const clipped = t.length <= OUTPUT_MAX_CHARS ? t : `${t.slice(0, OUTPUT_MAX_CHARS)}\n[输出超过 ${OUTPUT_MAX_CHARS} 字符已截断]`;
        return { result: { content: [{ type: "text", text: clipped }], isError: Boolean(r.isError) } };
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
