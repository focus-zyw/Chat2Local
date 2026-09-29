/**
 * MCP stdio 客户端 —— 换行分隔 JSON-RPC 2.0（MCP 官方 stdio transport）。
 *
 * 两种用法，同一套协议实现：
 * - 常驻：`createMcpClient()` 完成握手后返回，listTools/callTool 在同一 server
 *   进程上复用（保留 server 的内存状态与连接），close() 统一释放。watch 使用此形态。
 * - 一次性：`listMcpTools(spec)` / `callMcpTool(spec, …)` 兼容包装，内部就是
 *   createMcpClient + close，每次一个进程。
 *
 * 生命周期约定（与 watch 对齐）：
 * - 每 watch 独享一个 client，不跨项目共享；不自动重连、不自动重放调用。
 * - 工具返回 isError / JSON-RPC error 是普通失败，连接继续可用。
 * - 请求发出后超时、断线、进程崩溃、单帧超限：结果不明
 *   （error:"mcp-outcome-unknown", requiresConfirmation:true），连接立即停用并
 *   清理，不判断"是否仍安全"。超时尽力发送 notifications/cancelled，但取消无
 *   成功确认，不能据此认定操作未发生（MCP cancellation 规范）。
 * - 连接不可用/忙碌时的调用明确未执行（error:"mcp-unavailable"/"mcp-busy"）。
 * - 接收防护：按字节缓冲、整行再解码（多字节字符不跨块损坏）；单帧超过
 *   MCP_FRAME_MAX_BYTES 视为协议破坏；stderr 只保留固定尾部。
 * - 服务端请求：只应答 ping；其余方法明确回 -32601，绝不当作工具响应；
 *   通知里 tools/list_changed 触发自动重新发现：连接与在途调用不受影响，
 *   允许列表由 Host 层冻结（授权只缩不扩），重新发现失败才按协议破坏停用。
 * - 串行调用：忙时新调用立即返回 mcp-busy，不排队。
 * - close() 幂等：MCP 无 shutdown 请求——先关 stdin 等自然退出，超时进程树清理；
 *   释放在途请求（已发出 → 结果不明，据此保留人工核对断点）。
 *
 * 信任边界：server 脚本由用户经 --mcp 指定（模型只能选工具名和参数，永远
 * 不能选 server 或命令）。工具入参对 host 不透明，路径等语义由 server 自行
 * 约束——接入非只读 server 等于扩权，写入类门控是后续独立改进。
 */

import { spawn } from "node:child_process";
import process from "node:process";
import { terminateProcessTree } from "./kill-tree.mjs";

export const MCP_TIMEOUT_MS = 60000; // 单次调用默认超时
export const MCP_TIMEOUT_MAX_MS = 600000; // 超时上限
export const MCP_RESULT_MAX_CHARS = 8000; // 工具输出字符上限（与 RUN_MAX_CHARS 同级）
export const MCP_ARGS_MAX_CHARS = 16384; // tools/call 参数体积上限（host-actions 侧校验）
export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_TOOLS_MAX = 12; // 工具目录/允许列表上限：开场白展示多少，执行就只放行多少（提示词预算护栏，目录单行另有字符封顶）
export const MCP_FRAME_MAX_BYTES = 1024 * 1024; // 单帧接收上限：超限即协议破坏，停用连接
export const MCP_STDERR_TAIL_BYTES = 4096; // stderr 诊断尾部按 UTF-8 原始字节计数
export const MCP_STDERR_TAIL_CHARS = MCP_STDERR_TAIL_BYTES; // 兼容旧导出名
export const MCP_CLOSE_GRACE_MS = 3000; // close 等自然退出的时间，超时进程树清理
const PROP_DESC_CHARS = 60; // 目录里单参数描述的截断

// capabilities 留空：未实现的 sampling/elicitation/roots 等能力不声明
const CLIENT_INFO = { name: "chat2local", version: "0.1.0" };

function clip(text, max) {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[truncated ${t.length - max} chars; total ${t.length}]`;
}

/** 从 tools/call 结果提取文本：content[].text 优先，退回 structuredContent。 */
export function mcpResultText(result) {
  if (!result || typeof result !== "object") return "";
  if (Array.isArray(result.content) && result.content.length) {
    return result.content
      .map((c) => (c?.type === "text" ? String(c.text ?? "") : `[${c?.type || "unknown"} 内容已省略]`))
      .filter((s) => s !== "")
      .join("\n");
  }
  if (result.structuredContent != null) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

function mcpErrorMessage(resp, method) {
  if (!resp) return `MCP server 对 ${method} 无响应`;
  const e = resp.error;
  if (!e) return `MCP server 对 ${method} 返回异常`;
  return `MCP server 错误（code ${e.code ?? "?"}）：${e.message || JSON.stringify(e)}`;
}

/** 工具目录条目：保留 inputSchema 的必填项与参数类型/描述（开场白据此呈现
 * 合法示例）；schema 缺失时字段为空数组——呈现端据此省略。 */
function catalogEntry(t) {
  const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((n) => typeof n === "string")
    : [];
  const props = Object.entries(schema.properties ?? {})
    .filter(([n, p]) => typeof n === "string" && p && typeof p === "object")
    .map(([n, p]) => ({
      name: n,
      type: typeof p.type === "string" ? p.type : "any",
      required: required.includes(n),
      description: String(p.description ?? "").slice(0, PROP_DESC_CHARS),
    }));
  return { name: t.name, description: String(t.description ?? ""), required, props };
}

class McpClient {
  // 握手期间进程退出时的 reject 句柄；握手成功后置空
  #startupExitReject = null;
  #handshakeTimer = null;

  constructor(spec) {
    this.spec = spec;
    this.proc = null;
    this.state = "new"; // new → handshaking → ready（此后只有 unusable/closed）
    this.unusableReason = null;
    this.closed = false;
    this.closePromise = null;
    this.busy = false; // 串行调用锁：不排队，忙时直接拒绝
    this.nextId = 0;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.buf = Buffer.alloc(0); // 按字节缓冲；整行后再解码，多字节字符不跨块损坏
    this.stderrTail = "";
    this.stderrTailBytes = Buffer.alloc(0);
    this.exitSeen = false;
    this.protocolVersion = null;
    this.catalogStale = false; // 目录变化后、重新发现完成前为 true
    this.rediscovering = false;
    this.pendingRediscovery = false;
    // 目录重新发现完成后的回调：(tools) => void。授权边界在 Host 层（冻结的
    // 允许列表），回调只负责把最新目录交付给聊天，不会自动扩权。
    this.onCatalogUpdate = null;
  }

  isReady() {
    return this.state === "ready" && !this.closed && !this.unusableReason;
  }

  #failAllPending(message, unknown) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(this.#outcomeError(message, unknown));
    }
    this.pending.clear();
  }

  #outcomeError(message, unknown) {
    const err = new Error(message);
    err.code = unknown ? "mcp-outcome-unknown" : "mcp-unavailable";
    err.requiresConfirmation = unknown;
    return err;
  }

  /** 连接停用：ready 期间的在途请求一律按"结果不明"处理，进程随后清理。 */
  #markUnusable(reason) {
    if (this.unusableReason) return;
    this.unusableReason = reason;
    if (this.state === "ready") {
      this.#failAllPending(`${reason}——已发出请求的结果不明，请人工核对`, true);
    }
    this.#killProc();
  }

  #killProc() {
    const proc = this.proc;
    if (proc?.pid && !this.exitSeen) {
      terminateProcessTree(proc).catch(() => {});
    }
  }

  #describeExit(info) {
    const why = info.error
      ? `MCP server 进程异常：${info.error.message}`
      : info.signal
        ? `MCP server 收到信号 ${info.signal} 退出`
        : `MCP server 提前退出（退出码 ${info.code}）`;
    const tail = this.stderrTail.trim();
    return `${why}${tail ? `；stderr 尾部：${clip(tail, 800)}` : ""}`;
  }

  #onExit(info) {
    if (this.exitSeen) return;
    this.exitSeen = true;
    const message = this.#describeExit(info);
    if (this.#startupExitReject) {
      const reject = this.#startupExitReject;
      this.#startupExitReject = null;
      this.unusableReason = this.unusableReason ?? message;
      reject(new Error(message)); // 握手失败：无业务调用在途，按普通失败处理
      return;
    }
    this.#markUnusable(message);
  }

  async #start(startupTimeoutMs) {
    this.state = "handshaking";
    this.proc = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.proc.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on("data", (d) => {
      const combined = this.stderrTailBytes.length ? Buffer.concat([this.stderrTailBytes, d]) : d;
      const tail = combined.subarray(Math.max(0, combined.length - MCP_STDERR_TAIL_BYTES));
      let start = 0;
      while (start < tail.length && (tail[start] & 0xc0) === 0x80) start += 1;
      this.stderrTailBytes = Buffer.from(tail.subarray(start));
      this.stderrTail = this.stderrTailBytes.toString("utf8");
      while (Buffer.byteLength(this.stderrTail, "utf8") > MCP_STDERR_TAIL_BYTES) {
        this.stderrTail = this.stderrTail.slice(this.stderrTail.codePointAt(0) > 0xffff ? 2 : 1);
      }
    });
    // EPIPE / write-after-end 都是连接终态：吞掉流错误，真实失败由进程退出事件承载
    this.proc.stdin.on("error", () => {});
    this.proc.on("error", (error) => this.#onExit({ error }));
    this.proc.on("close", (code, signal) => this.#onExit({ code, signal }));

    const exitDuringStartup = new Promise((_, reject) => {
      this.#startupExitReject = reject;
    });
    let handshakeTimer = null;
    const handshakeTimeout = new Promise((_, reject) => {
      handshakeTimer = setTimeout(() => {
        reject(new Error(`MCP 握手超时（${Math.round(startupTimeoutMs / 1000)}s）——已停止连接`));
      }, startupTimeoutMs);
    });
    try {
      const initResult = await Promise.race([
        this.#request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        }),
        exitDuringStartup,
        handshakeTimeout,
      ]);
      if (!initResult || initResult.error) {
        throw new Error(mcpErrorMessage(initResult, "initialize"));
      }
      const result = initResult.result ?? {};
      // 校验协商结果：版本必须明示；工具能力必须声明。对版本号本身不做白名单——
      // 本客户端只依赖 initialize/tools/ping/cancellation 这组自 2024-11-05 起稳定的基础面
      if (typeof result.protocolVersion !== "string" || !result.protocolVersion) {
        throw new Error("MCP server 的 initialize 应答缺少 protocolVersion");
      }
      if (!result.capabilities || typeof result.capabilities.tools === "undefined") {
        throw new Error("MCP server 未声明 tools 能力，无法桥接工具调用");
      }
      this.protocolVersion = result.protocolVersion;
      await this.#request("notifications/initialized", undefined, { notification: true });
    } catch (err) {
      this.#markUnusable(err?.message || "握手失败");
      throw err;
    } finally {
      clearTimeout(handshakeTimer);
    }
    this.#startupExitReject = null;
    this.state = "ready";
  }

  #writeMessage(obj) {
    try {
      this.proc?.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false; // 同步写失败（stdin 已本地销毁）：请求完全未发出
    }
  }

  #onStdout(chunk) {
    // 停用/关闭后不再累积任何字节：超限到进程真正退出之间可能有后续数据
    if (this.unusableReason || this.closed) return;
    const data = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.buf = Buffer.alloc(0);
    let start = 0;
    let nl;
    while ((nl = data.indexOf(0x0a, start)) !== -1) {
      if (nl - start > MCP_FRAME_MAX_BYTES) {
        this.#receiveViolation();
        return;
      }
      const line = data.toString("utf8", start, nl).replace(/\r$/, "");
      start = nl + 1;
      this.#handleLine(line);
      if (this.unusableReason || this.closed) return; // 行处理可能触发停用
    }
    // 无换行残余超过上限：不可能再成为合法帧
    if (data.length - start > MCP_FRAME_MAX_BYTES) {
      this.#receiveViolation();
    } else if (start < data.length) {
      this.buf = Buffer.from(data.subarray(start)); // 复制残帧，释放完整帧的底层块
    }
  }

  #receiveViolation() {
    this.#markUnusable(
      `MCP server 输出单帧超过 ${Math.round(MCP_FRAME_MAX_BYTES / 1024)}KB 接收上限——协议破坏，已发出请求的结果不明`
    );
    // 立即停止累积并释放已缓冲字节：进程退出前可能还有数据到达，
    // 不摘除监听器会让接收缓冲越过上限继续增长
    try {
      this.proc?.stdout?.removeAllListeners("data");
    } catch {
      /* already gone */
    }
    this.buf = Buffer.alloc(0);
    this.#killProc();
  }

  /** 目录变化后重新发现：与用户调用并发是安全的（响应按 id 匹配）；
   * 失败时按协议破坏停用（P38 结果不明语义）。 */
  #scheduleRediscovery() {
    if (this.closed || this.unusableReason) return;
    this.catalogStale = true;
    if (this.rediscovering) {
      this.pendingRediscovery = true;
      return;
    }
    this.#rediscover().catch(() => {});
  }

  async #rediscover() {
    this.rediscovering = true;
    try {
      do {
        this.pendingRediscovery = false;
        const resp = await this.#request("tools/list", {}, { timeoutMs: 30000 });
        if (!resp || resp.error) {
          throw new Error(mcpErrorMessage(resp, "tools/list"));
        }
        const tools = (resp.result?.tools ?? [])
          .filter((t) => t && typeof t.name === "string")
          .map(catalogEntry);
        this.catalogStale = false;
        try {
          this.onCatalogUpdate?.(tools);
        } catch {
          /* 回调失败不影响连接 */
        }
      } while (this.pendingRediscovery);
    } catch (err) {
      this.#markUnusable(`tools/list_changed 后重新发现失败：${err?.message || err}——已发出请求的结果不明`);
      this.#killProc();
    } finally {
      this.rediscovering = false;
    }
  }

  /** 目录过期时短暂等待自动重新发现完成（毫秒级往返）；超时仍过期则失败。 */
  async #waitForCatalog(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.catalogStale && !this.unusableReason && !this.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // banner / 非协议日志行：容忍跳过
    }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method === "string") {
      if (msg.id !== undefined && msg.id !== null) {
        // 服务端请求：只应答 ping；其余明确拒绝，绝不与工具响应混淆
        if (msg.method === "ping") {
          this.#writeMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
        } else {
          this.#writeMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          });
        }
        return;
      }
      if (msg.method === "notifications/tools/list_changed") {
        // 目录变化：连接与在途调用不受影响（已发出请求的语义在调用时已确定）；
        // 冻结允许列表的前提下自动重新发现，期间新调用短暂等待/拒绝
        this.#scheduleRediscovery();
        return;
      }
      return; // 其他通知忽略
    }
    if (Number.isInteger(msg.id)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return; // 迟到/重复/杂散响应：忽略，不能匹配到新调用
      this.pending.delete(msg.id);
      waiter.resolve(msg);
    }
  }

  #request(method, params, { timeoutMs = MCP_TIMEOUT_MS, notification = false } = {}) {
    if (notification) {
      this.#writeMessage({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
      return Promise.resolve(null);
    }
    if (!this.isReady() && this.state !== "handshaking") {
      return Promise.reject(
        this.#outcomeError(`MCP 连接不可用（${this.unusableReason || "未就绪"}）——调用未执行`, false)
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 尽力取消：无成功确认，不能据此认定操作未发生
        this.#writeMessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "client timeout" },
        });
        this.#markUnusable(
          `MCP 调用超时（${Math.round(timeoutMs / 1000)}s，method=${method}）——按首版约定连接停用`
        );
        reject(
          this.#outcomeError(
            `MCP 调用超时（${Math.round(timeoutMs / 1000)}s）——请求已发出，结果不明，请人工核对`,
            true
          )
        );
      }, timeoutMs);
      const waiter = {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.pending.set(id, waiter);
      const sent = this.#writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      if (!sent) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this.#outcomeError("写入 MCP server 失败（stdin 已关闭）——请求未发出", false));
      }
    });
  }

  #callFailure(err) {
    if (err?.code === "mcp-outcome-unknown") {
      return { ok: false, error: "mcp-outcome-unknown", requiresConfirmation: true, text: err.message };
    }
    if (err?.code === "mcp-unavailable") {
      return { ok: false, error: "mcp-unavailable", text: err.message };
    }
    return { ok: false, error: "mcp-failed", text: err?.message || "MCP 调用失败" };
  }

  /** 列出工具目录：{ok, tools:[{name,description,required,props}]}。 */
  async listTools({ timeoutMs = MCP_TIMEOUT_MS } = {}) {
    if (!this.isReady()) {
      return { ok: false, error: "mcp-unavailable", text: `MCP 连接不可用（${this.unusableReason || "未就绪"}）——调用未执行` };
    }
    if (this.busy) {
      return { ok: false, error: "mcp-busy", text: "上一个 MCP 调用尚未返回（串行调用，不排队）——本次未执行" };
    }
    this.busy = true;
    try {
      if (this.catalogStale) {
        await this.#waitForCatalog();
        if (this.unusableReason || this.closed) {
          return { ok: false, error: "mcp-unavailable", text: `MCP 连接不可用（${this.unusableReason || "已关闭"}）——调用未执行` };
        }
        if (this.catalogStale) {
          return { ok: false, error: "mcp-catalog-stale", text: "工具目录已变化且重新发现未完成——本次未执行" };
        }
      }
      const resp = await this.#request("tools/list", {}, { timeoutMs });
      if (!resp || resp.error) {
        return { ok: false, error: "mcp-error", text: mcpErrorMessage(resp, "tools/list") };
      }
      const tools = (resp.result?.tools ?? [])
        .filter((t) => t && typeof t.name === "string")
        .map(catalogEntry);
      return { ok: true, tools };
    } catch (err) {
      return this.#callFailure(err);
    } finally {
      this.busy = false;
    }
  }

  /** 调用工具：{ok, text, error?}；结果不明时带 requiresConfirmation:true。 */
  async callTool(toolName, toolArgs, { timeoutMs = MCP_TIMEOUT_MS } = {}) {
    if (!this.isReady()) {
      return { ok: false, error: "mcp-unavailable", text: `MCP 连接不可用（${this.unusableReason || "未就绪"}）——调用未执行` };
    }
    if (this.busy) {
      return { ok: false, error: "mcp-busy", text: "上一个 MCP 调用尚未返回（串行调用，不排队）——本次未执行" };
    }
    this.busy = true;
    try {
      if (this.catalogStale) {
        await this.#waitForCatalog();
        if (this.unusableReason || this.closed) {
          return { ok: false, error: "mcp-unavailable", text: `MCP 连接不可用（${this.unusableReason || "已关闭"}）——调用未执行` };
        }
        if (this.catalogStale) {
          return { ok: false, error: "mcp-catalog-stale", text: "工具目录已变化且重新发现未完成——本次未执行" };
        }
      }
      const resp = await this.#request("tools/call", { name: toolName, arguments: toolArgs }, { timeoutMs });
      if (!resp || resp.error) {
        return {
          ok: false,
          error: "mcp-error",
          text: `工具调用被 MCP server 拒绝：${mcpErrorMessage(resp, "tools/call")}`,
        };
      }
      const result = resp.result ?? {};
      const text = mcpResultText(result);
      if (result.isError) {
        return {
          ok: false,
          error: "tool-error",
          text: `MCP 工具报告失败：${clip(text || "(无错误详情)", 2000)}`,
        };
      }
      return { ok: true, text: clip(text || "(空结果)", MCP_RESULT_MAX_CHARS) };
    } catch (err) {
      return this.#callFailure(err);
    } finally {
      this.busy = false;
    }
  }

  /** 幂等关闭：stdin 结束 → 短暂等自然退出 → 超时进程树清理；释放在途请求。 */
  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.#close();
    return this.closePromise;
  }

  async #close() {
    this.closed = true;
    this.unusableReason = this.unusableReason ?? "客户端已关闭";
    // 在途请求都已发出 → 结果不明（watch 停止期间据此保留人工核对断点）
    this.#failAllPending(
      `${this.unusableReason}——已发出请求的结果不明，请人工核对`,
      this.state === "ready"
    );
    const proc = this.proc;
    if (proc?.pid && !this.exitSeen) {
      try {
        proc.stdin.end();
      } catch {
        /* already gone */
      }
      await Promise.race([
        new Promise((r) => proc.once("close", r)),
        new Promise((r) => setTimeout(r, MCP_CLOSE_GRACE_MS)),
      ]);
      if (!this.exitSeen) await terminateProcessTree(proc);
    }
  }

  /** 创建常驻客户端：完成 initialize + initialized 握手并校验能力后返回；
   * 失败时自行清理已启动进程再抛出。每 watch 独享一个，不跨项目共享。 */
  static async create(spec, { startupTimeoutMs = MCP_TIMEOUT_MS } = {}) {
    if (!spec || !spec.command) {
      throw new Error("createMcpClient 需要 {command, args?, cwd} 形式的 server 配置");
    }
    const client = new McpClient(spec);
    try {
      await client.#start(startupTimeoutMs);
    } catch (err) {
      await client.close();
      throw err;
    }
    return client;
  }
}

/** 创建常驻客户端（McpClient.create 的模块级出口）。 */
export function createMcpClient(spec, opts = {}) {
  return McpClient.create(spec, opts);
}

/** 一次性兼容包装：探测工具目录（内部 createMcpClient + close）。 */
export async function listMcpTools(spec, { timeoutMs = MCP_TIMEOUT_MS } = {}) {
  let client;
  try {
    client = await createMcpClient(spec, { startupTimeoutMs: timeoutMs });
  } catch (err) {
    return { ok: false, error: "mcp-failed", text: err?.message || "MCP 连接失败" };
  }
  try {
    return await client.listTools({ timeoutMs });
  } finally {
    await client.close();
  }
}

/** 一次性兼容包装：调用工具（内部 createMcpClient + close）。 */
export async function callMcpTool(spec, toolName, toolArgs, { timeoutMs = MCP_TIMEOUT_MS } = {}) {
  let client;
  try {
    client = await createMcpClient(spec, { startupTimeoutMs: timeoutMs });
  } catch (err) {
    return { ok: false, error: "mcp-failed", text: err?.message || "MCP 连接失败" };
  }
  try {
    return await client.callTool(toolName, toolArgs, { timeoutMs });
  } finally {
    await client.close();
  }
}
