#!/usr/bin/env node
/**
 * demo MCP server —— 只读跨目录文件搜索（stdio transport，零依赖）。
 *
 * 用途：验证 Chat2Local 的 mcp 动作桥接。search_files 一次搜索多个授权目录
 * —— 这是内置 search 动作做不到的（Host Root 只有一个），用来证明跨工具
 * 桥接的价值：网页模型 → host 动作 → MCP server → 本地能力 → 结果回填。
 *
 * 用法：node demo/mcp-search-server.mjs <root1> <root2> ...
 * 协议：stdin/stdout 上的换行分隔 JSON-RPC 2.0（MCP stdio transport）。
 *
 * 只读保证：只用 stat/readdir/readFile，不提供任何写工具；请求路径必须落
 * 在对应授权目录内（拒绝绝对路径与 ..），跳过敏感文件名与依赖/构建目录。
 * 这是 demo 级实现：敏感名筛选是简化版，正式接入其他 server 前自行评估。
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const SEARCH_DEFAULT_MAX = 50;
const SEARCH_MAX_RESULTS = 200;
const SEARCH_LINE_CHARS = 200;
const SEARCH_MAX_FILE_BYTES = 1_000_000;
const SEARCH_MAX_FILES_PER_ROOT = 2000;

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "coverage",
  ".next", ".nuxt", ".cache", ".parcel-cache", "__pycache__", ".venv", "venv",
  ".tox", "target",
]);

// demo 级敏感名筛选：常见凭据/私钥不进搜索
const SENSITIVE_NAMES = new Set([".env", ".netrc", "id_rsa", "id_ed25519", "id_ecdsa", "credentials.json"]);
const SENSITIVE_EXTS = /\.(pem|key|p12|pfx|kdbx|keystore|crt)$/i;

const roots = [];
for (const raw of process.argv.slice(2)) {
  const abs = path.resolve(raw);
  let st = null;
  try {
    st = await fs.stat(abs);
  } catch {
    /* missing */
  }
  if (!st || !st.isDirectory()) {
    process.stderr.write(`[mcp-search-demo] 授权目录不存在或不是目录：${abs}\n`);
    process.exit(1);
  }
  roots.push({ label: `R${roots.length + 1}`, abs });
}
if (roots.length === 0) {
  process.stderr.write("[mcp-search-demo] 用法：node demo/mcp-search-server.mjs <root1> <root2> ...\n");
  process.exit(1);
}
process.stderr.write(`[mcp-search-demo] 就绪，授权目录：${roots.map((r) => `${r.label}=${r.abs}`).join(" ")}\n`);

function isSensitiveRel(rel) {
  for (const seg of rel.split(/[\\/]/)) {
    if (SENSITIVE_NAMES.has(seg.toLowerCase()) || SENSITIVE_EXTS.test(seg)) return true;
  }
  return false;
}

function wildcardMatch(name, pattern) {
  const i = pattern.indexOf("*");
  if (i === -1) return name === pattern;
  const head = pattern.slice(0, i);
  const tail = pattern.slice(i + 1);
  return name.startsWith(head) && name.endsWith(tail) && name.length >= head.length + tail.length;
}

function buildMatcher(args) {
  const query = String(args.query ?? "");
  const ignoreCase = args.ignoreCase !== false;
  if (args.regex === true) {
    let re;
    try {
      re = new RegExp(query, ignoreCase ? "i" : "");
    } catch (err) {
      return { error: `非法正则 "${query}"：${err.message}` };
    }
    return { match: (line) => re.test(line) };
  }
  const needle = ignoreCase ? query.toLowerCase() : query;
  return { match: (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle) };
}

function clipLine(text) {
  const t = String(text ?? "").replace(/\r$/, "");
  return t.length <= SEARCH_LINE_CHARS ? t : t.slice(0, SEARCH_LINE_CHARS) + "…";
}

/** 递归收集一个 root 下的候选文件（跳过依赖/构建目录与敏感名）。 */
async function collectFiles(rootDir) {
  const files = [];
  const walk = async (dir) => {
    if (files.length >= SEARCH_MAX_FILES_PER_ROOT) return;
    let names;
    try {
      names = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of names) {
      if (files.length >= SEARCH_MAX_FILES_PER_ROOT) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(p);
      } else if (e.isFile() && !isSensitiveRel(path.relative(rootDir, p))) {
        files.push(p);
      }
    }
  };
  await walk(rootDir);
  return files;
}

async function searchRoots(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { isError: true, text: "参数必须是对象：{query, regex?, include?, maxResults?}" };
  }
  const query = String(args.query ?? "").trim();
  if (!query) return { isError: true, text: "缺少 query（搜索词）" };
  const matcher = buildMatcher(args);
  if (matcher.error) return { isError: true, text: matcher.error };
  const maxResults = Math.min(
    Math.max(Math.floor(Number(args.maxResults)) || SEARCH_DEFAULT_MAX, 1),
    SEARCH_MAX_RESULTS
  );
  const include = args.include ? String(args.include) : null;

  const out = [];
  let hits = 0;
  let truncated = false;
  let searched = 0;
  for (const root of roots) {
    if (hits >= maxResults) {
      truncated = true;
      break;
    }
    for (const file of await collectFiles(root.abs)) {
      if (hits >= maxResults) {
        truncated = true;
        break;
      }
      if (include && !wildcardMatch(path.basename(file), include)) continue;
      let text;
      try {
        if ((await fs.stat(file)).size > SEARCH_MAX_FILE_BYTES) continue;
        text = await fs.readFile(file, "utf8");
      } catch {
        continue; // 不可读/二进制跳过
      }
      const lines = text.split("\n");
      searched += 1;
      for (let i = 0; i < lines.length; i += 1) {
        if (!matcher.match(lines[i])) continue;
        const rel = path.relative(root.abs, file).split(path.sep).join("/");
        out.push(`[${root.label}] ${rel}:${i + 1}: ${clipLine(lines[i])}`);
        hits += 1;
        if (hits >= maxResults) break;
      }
    }
  }
  const rootsDesc = roots.map((r) => `${r.label}=${path.basename(r.abs)}`).join("、");
  const tail = `${truncated ? `[截断于 ${maxResults} 处命中——收窄 query/include 或提高 maxResults]\n` : ""}（共搜索 ${searched} 个文件，命中 ${hits} 处；目录：${rootsDesc}）`;
  return { text: (out.length ? out.join("\n") : "(no matches)") + "\n" + tail };
}

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-search-demo", version: "0.1.0" },
        },
      };
    case "tools/list":
      return {
        result: {
          tools: [
            {
              name: "search_files",
              description:
                "跨多个授权目录搜索文件内容（只读）。输出行格式：[R1] 相对路径:行号: 行内容；R1/R2… 标明命中所在目录。",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "搜索词" },
                  regex: { type: "boolean", description: "按正则解释 query（默认 false，子串匹配）" },
                  ignoreCase: { type: "boolean", description: "忽略大小写（默认 true）" },
                  include: { type: "string", description: "文件名通配，如 *.md（仅支持一个 *）" },
                  maxResults: { type: "number", description: "命中上限，默认 50，最大 200" },
                },
                required: ["query"],
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      };
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (name !== "search_files") {
        return { error: { code: -32602, message: `未知工具：${name || "(缺失)"}——本 server 只提供 search_files` } };
      }
      const r = await searchRoots(msg.params?.arguments ?? {});
      return { result: { content: [{ type: "text", text: r.text }], isError: Boolean(r.isError) } };
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
