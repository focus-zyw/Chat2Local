#!/usr/bin/env node
/**
 * 只读 git MCP server（stdio transport，零依赖，仅用 Node 内置模块）。
 *
 * 用途：把 Host Root 所在 git 仓库的状态/差异/历史暴露给网页模型——既是
 * 「模型能读仓库历史」的桥接能力，也是后续写入类操作的审查兜底（diff 先行）。
 * 官方 reference git server 是 Python 包且允许调用时传 repo_path 覆盖作用域，
 * 与本项目「作用域由用户在启动时决定、模型不可选」的信任模型冲突，故自带本实现。
 *
 * 用法：node demo/mcp-git-server.mjs [仓库路径]
 * 缺省取当前目录（watch 桥接以 Host Root 为 cwd 启动，即默认圈住 Host Root）。
 * 仓库路径在启动时冻结：工具入参一律不接受路径，模型无法切换到其他仓库。
 *
 * 只读保证：只执行 status / diff / log 三类 git 子命令，参数只用固字面量与
 * 已消毒的数字（max/skip），模型字符串永不进入 argv；无任何写操作。
 * 协议：stdin/stdout 上的换行分隔 JSON-RPC 2.0（MCP stdio transport）。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { isSensitivePath } from "../src/sensitive-paths.mjs";

const GIT_TIMEOUT_MS = 15000; // 单次 git 调用超时：慢仓库/大 diff 不拖垮会话
const OUTPUT_MAX_CHARS = 7000; // 回填上限需低于桥接端 8000：给截断提示留余量，避免提示本身被桥接端切掉
const TEXT_CAPTURE_BYTES = 4 * (OUTPUT_MAX_CHARS + 1);
const PATH_LIST_MAX_BYTES = 1024 * 1024;
const LOG_DEFAULT_MAX = 20;
const LOG_MAX_LIMIT = 100;
const LOG_SKIP_LIMIT = 10000;

const repoDir = path.resolve(process.argv[2] ?? ".");
// Git 的环境变量可覆盖 -C 指定的仓库，也可打开外部 diff；本 server 不继承它们。
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
);
gitEnv.GIT_OPTIONAL_LOCKS = "0";

function clip(text, truncated = false) {
  const t = String(text ?? "").trimEnd();
  if (!truncated && t.length <= OUTPUT_MAX_CHARS) return t;
  return `${t.slice(0, OUTPUT_MAX_CHARS)}\n[输出超过 ${OUTPUT_MAX_CHARS} 字符已截断]`;
}

function toolFailure(message) {
  return Object.assign(new Error(clip(message)), { toolError: true });
}

// 持续排空子进程管道，只保留需要回填的前缀；Git 输出再大也不会积入内存。
function git(args, { maxBytes = TEXT_CAPTURE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repoDir, ...args,
    ], { env: gitEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      const available = Math.max(0, maxBytes - stdoutBytes);
      if (available) stdout.push(chunk.subarray(0, available));
      stdoutBytes += Math.min(chunk.length, available);
      if (chunk.length > available) truncated = true;
    });
    child.stderr.on("data", (chunk) => {
      const available = Math.max(0, TEXT_CAPTURE_BYTES - stderrBytes);
      if (available) stderr.push(chunk.subarray(0, available));
      stderrBytes += Math.min(chunk.length, available);
    });
    child.on("error", (err) => { spawnError = err; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (spawnError || timedOut || code !== 0) {
        reject(toolFailure(errorText || (timedOut ? "git 调用超时" : spawnError?.message || `git ${args[0]} 失败（退出码 ${code}）`)));
        return;
      }
      resolve({ output: Buffer.concat(stdout), truncated });
    });
  });
}

async function gitText(args) {
  const { output, truncated } = await git(args);
  return clip(output.toString("utf8"), truncated);
}

function clampInt(value, fallback, limit) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, limit);
}

async function gitStatus() {
  const { output, truncated } = await git(
    ["status", "--porcelain=v1", "-b", "-z", "--no-renames"],
    { maxBytes: PATH_LIST_MAX_BYTES }
  );
  const records = output.toString("utf8").split("\0");
  if (truncated) records.pop(); // 不显示不完整的路径
  const visible = [];
  let hidden = 0;
  for (const record of records) {
    if (!record) continue;
    if (!record.startsWith("## ") && isSensitivePath(record.slice(3))) hidden += 1;
    else visible.push(record);
  }
  if (hidden) visible.push(`[已隐藏 ${hidden} 个敏感路径]`);
  if (truncated) visible.push("[状态路径过多，清单已截断]");
  return clip(visible.join("\n"));
}

async function gitDiff(staged) {
  const base = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", ...(staged ? ["--cached"] : [])];
  const names = await git([...base, "--name-status", "-z"], { maxBytes: PATH_LIST_MAX_BYTES });
  const fields = names.output.toString("utf8").split("\0");
  if (names.truncated) fields.pop();
  const visible = [];
  let hidden = 0;
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const pair = status.startsWith("R") || status.startsWith("C");
    const count = pair ? 2 : 1;
    if (i + count > fields.length) break;
    const paths = fields.slice(i, i + count);
    i += count;
    // 重命名的来源或目标只要有一个敏感，就不回填任一端的补丁。
    if (paths.some(isSensitivePath)) hidden += 1;
    else visible.push(...paths);
  }
  let result = "";
  let truncated = names.truncated;
  // 路径只来自 Git，逐组作为 literal pathspec 传回；模型入参不会进入 argv。
  for (let i = 0; i < visible.length; i += 40) {
    const paths = visible.slice(i, i + 40).map((name) => `:(literal)${name}`);
    const part = await git([...base, "--", ...paths]);
    result += part.output.toString("utf8");
    if (part.truncated || result.length > OUTPUT_MAX_CHARS || i + 40 < visible.length && result.length >= OUTPUT_MAX_CHARS) {
      truncated = true;
      break;
    }
  }
  const suffix = hidden ? `${result ? "\n" : ""}[已隐藏 ${hidden} 个敏感路径的改动]` : "";
  const available = OUTPUT_MAX_CHARS - suffix.length;
  return clip(result.slice(0, available) + suffix, truncated || result.length > available);
}

const TOOLS = [
  {
    name: "git_status",
    description: "查看当前分支与工作区改动列表（只读，porcelain 格式：## 分支行 + XY 路径）。仓库范围启动时已冻结，不接受路径参数。",
    run: gitStatus,
  },
  {
    name: "git_diff_unstaged",
    description: "查看未暂存改动的完整 diff（只读）。空输出表示没有未暂存改动；仓库范围启动时已冻结。",
    run: () => gitDiff(false),
  },
  {
    name: "git_diff_staged",
    description: "查看已暂存改动的完整 diff（只读）。空输出表示没有已暂存改动；仓库范围启动时已冻结。",
    run: () => gitDiff(true),
  },
  {
    name: "git_log",
    description: "查看提交历史（只读），每行一条：短哈希 作者 日期 摘要。",
    schema: {
      type: "object",
      properties: {
        max: { type: "number", description: `最多返回几条，默认 ${LOG_DEFAULT_MAX}，上限 ${LOG_MAX_LIMIT}` },
        skip: { type: "number", description: `跳过最近几条再返回（翻页用），上限 ${LOG_SKIP_LIMIT}` },
      },
    },
    run: (args) =>
      gitText([
        "log",
        `--pretty=format:%h %an %ad %s`,
        "--date=short",
        "-n",
        String(clampInt(args?.max, LOG_DEFAULT_MAX, LOG_MAX_LIMIT)),
        "--skip",
        String(clampInt(args?.skip, 0, LOG_SKIP_LIMIT)),
      ]),
  },
];

async function handle(msg) {
  switch (msg.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-git-readonly", version: "0.1.0" },
        },
      };
    case "tools/list":
      return {
        result: {
          tools: TOOLS.map(({ name, description, schema }) => ({
            name,
            description,
            inputSchema: schema ?? { type: "object", properties: {} },
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
      const args = msg.params?.arguments ?? {};
      try {
        return { result: { content: [{ type: "text", text: clip(await tool.run(args)) }] } };
      } catch (err) {
        if (err?.toolError) {
          return { result: { content: [{ type: "text", text: clip(err.message) }], isError: true } };
        }
        return { error: { code: -32603, message: String(err?.message || err) } };
      }
    }
    case "ping":
      return { result: {} };
    default:
      return { error: { code: -32601, message: `方法不存在：${msg.method}` } };
  }
}

// 启动即校验：路径必须是 git 工作区，失败直接退出（桥接会按探测失败降级）
try {
  await gitText(["rev-parse", "--is-inside-work-tree"]);
} catch (err) {
  process.stderr.write(`[mcp-git-readonly] 目录不在 git 工作区内：${repoDir}\n${err.message}\n`);
  process.exit(1);
}
const toplevel = (await gitText(["rev-parse", "--show-toplevel"])).trim();
process.stderr.write(`[mcp-git-readonly] 就绪，仓库：${toplevel}（执行目录 ${repoDir}，作用域已冻结）\n`);

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
