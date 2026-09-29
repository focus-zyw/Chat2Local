/**
 * 有状态 fixture MCP server —— 验证常驻客户端的验收点：
 * 内存状态跨调用保留、发现与调用同一进程、握手仅一次、服务端请求应答
 * （ping 应答 / 未实现方法拒绝）、普通工具错误后连接复用、崩溃/超时/超大帧/
 * 无换行输出/杂散与重复响应的处理。只服务于 tests/mcp-resident.test.mjs。
 */

const state = { counter: 0, initializes: 0, calls: 0, sawPingReply: false, sawSamplingReject: false };

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reply(id, result, error) {
  const payload = { jsonrpc: "2.0", id };
  if (error) payload.error = error;
  else payload.result = result;
  writeLine(payload);
}

function text(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const TOOLS = [
  { name: "stats", description: "返回 {pid, initializes, calls, sawPingReply, sawSamplingReject} 的 JSON。" },
  { name: "state", description: "内存计数器：{op:'inc'|'get'}，跨调用保留。", inputSchema: { type: "object", properties: { op: { type: "string", description: "inc 或 get" } }, required: ["op"] } },
  { name: "fail", description: "返回工具级错误（isError），连接应继续可用。" },
  { name: "slow", description: "等待 {ms} 后返回，用于超时。", inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] } },
  { name: "crash", description: "调用中途 process.exit(7)。" },
  { name: "huge", description: "输出 2MiB 单行（超过客户端 1MiB 帧上限）。" },
  { name: "exact_frame", description: "返回总字节数恰为 {bytes} 的单帧响应（用于上限边界验证）。", inputSchema: { type: "object", properties: { bytes: { type: "number" } }, required: ["bytes"] } },
  { name: "oversize_banner", description: "先输出一条超过 1MiB 的非 JSON 行，再正常响应。" },
  { name: "flood_nonl", description: "持续输出无换行数据块，直到被终止（验证接收上限及时生效）。" },
  { name: "burst", description: "在同一次 write 里输出 20 条合法消息（总量约 2MiB，每条均低于上限），最后一条是对本次调用的响应。" },
  { name: "stderr_flood", description: "向 stderr 持续写约 10MB 后正常响应（验证 stderr 保留尾部有界）。" },
  { name: "stderr_unicode", description: "输出多字节 stderr 尾部。" },
  { name: "hang_nonl", description: "输出无换行的残帧后挂起。" },
  { name: "noisy", description: "先发一条杂散响应（未知 id）再正常响应。" },
  { name: "dup", description: "对同一请求响应两次。" },
  { name: "announce_change", description: "先发 notifications/tools/list_changed 再响应。" },
  { name: "change_slow", description: "目录变化后延迟调用与重新发现，用于忙时拒绝测试。" },
];

let delayNextList = false;

function handle(msg) {
  if (!msg || typeof msg !== "object") return;
  // 客户端对"服务端请求"的应答：记录 ping 是否被应答、未知方法是否被明确拒绝
  if (msg.method === undefined && msg.id === "srv-ping" && msg.result) state.sawPingReply = true;
  if (msg.method === undefined && msg.id === "srv-samp" && msg.error) state.sawSamplingReject = true;
  if (typeof msg.method !== "string") return;
  if (msg.id === undefined || msg.id === null) return; // 客户端通知：忽略
  switch (msg.method) {
    case "initialize":
      state.initializes += 1;
      reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-state-fixture", version: "1.0.0" },
      });
      // 服务端主动请求：客户端必须应答 ping、明确拒绝未实现的方法，
      // 且绝不把这些请求/响应当作工具调用的结果
      writeLine({ jsonrpc: "2.0", id: "srv-ping", method: "ping" });
      writeLine({ jsonrpc: "2.0", id: "srv-samp", method: "sampling/createMessage", params: {} });
      break;
    case "tools/list":
      if (delayNextList) {
        delayNextList = false;
        setTimeout(() => reply(msg.id, { tools: TOOLS }), 500);
      } else reply(msg.id, { tools: TOOLS });
      break;
    case "tools/call": {
      state.calls += 1;
      const name = String(msg.params?.name ?? "");
      const args = msg.params?.arguments ?? {};
      switch (name) {
        case "stats":
          reply(msg.id, text(JSON.stringify({ pid: process.pid, initializes: state.initializes, calls: state.calls, sawPingReply: state.sawPingReply, sawSamplingReject: state.sawSamplingReject })));
          break;
        case "state":
          if (args.op === "inc") {
            state.counter += 1;
            reply(msg.id, text(String(state.counter)));
          } else if (args.op === "get") {
            reply(msg.id, text(String(state.counter)));
          } else {
            reply(msg.id, text(`未知 op：${args.op}`, true));
          }
          break;
        case "fail":
          reply(msg.id, text("刻意失败（工具级错误，连接应继续可用）", true));
          break;
        case "slow":
          setTimeout(() => reply(msg.id, text(`slow done after ${args.ms}ms`)), Math.max(0, Number(args.ms) || 0));
          break;
        case "crash":
          process.exit(7);
          break;
        case "huge":
          reply(msg.id, text("x".repeat(2 * 1024 * 1024)));
          break;
        case "exact_frame": {
          // 构造总字节数恰为 bytes 的完整响应行（ASCII filler，字节长度可精确控制）
          const target = Math.max(64, Math.min(Number(args.bytes) || 0, 4 * 1024 * 1024));
          const base = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "" }] } });
          const filler = target - base.length;
          if (filler < 0) {
            reply(msg.id, text(`目标 ${target} 字节小于基础帧 ${base.length} 字节`, true));
            break;
          }
          const payload = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "f".repeat(filler) }] } };
          process.stdout.write(JSON.stringify(payload) + "\n");
          break;
        }
        case "oversize_banner":
          process.stdout.write("z".repeat(1024 * 1024 + 10) + "\n");
          reply(msg.id, text("banner 之后本应正常返回"));
          break;
        case "flood_nonl": {
          // 每 10ms 写 64KB 且不含换行：无界实现会让缓冲持续增长
          const floodTimer = setInterval(() => {
            process.stdout.write("w".repeat(64 * 1024));
          }, 10);
          floodTimer.unref?.();
          break;
        }
        case "burst": {
          // 同一次 write：19 条合法的无关消息 + 1 条真实响应，总量约 2MiB
          const parts = [];
          for (let i = 0; i < 19; i++) {
            parts.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: i, progress: i, total: 19, padding: "b".repeat(100 * 1024) } }) + "\n");
          }
          parts.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `burst ok（${parts.length + 1} 条消息在同一数据块序列中）` }] } }) + "\n");
          process.stdout.write(parts.join(""));
          break;
        }
        case "stderr_flood": {
          let written = 0;
          const pump = () => {
            while (written < 10 * 1024 * 1024) {
              process.stderr.write("e".repeat(200 * 1024));
              written += 200 * 1024;
              setImmediate(pump);
              return;
            }
            reply(msg.id, text(`stderr flood done (${written} bytes)`));
          };
          pump();
          break;
        }
        case "stderr_unicode":
          process.stderr.write("汉".repeat(3000) + "终点");
          reply(msg.id, text("unicode stderr done"));
          break;
        case "hang_nonl":
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "y".repeat(200 * 1024) }].map((c) => c.text).join("") } }).slice(0, 200 * 1024));
          // 残帧无换行且不再发送；保持进程存活等客户端超时/清理
          setInterval(() => {}, 1000);
          break;
        case "noisy":
          reply(987654, text("杂散响应：不属于任何在途请求"));
          reply(msg.id, text("noisy ok"));
          break;
        case "dup":
          reply(msg.id, text("dup first"));
          reply(msg.id, text("dup second"));
          break;
        case "announce_change":
          writeLine({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          reply(msg.id, text("目录已变化"));
          break;
        case "change_slow":
          delayNextList = true;
          writeLine({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          setTimeout(() => reply(msg.id, text("change slow done")), 800);
          break;
        default:
          reply(msg.id, undefined, { code: -32602, message: `未知工具：${name}` });
      }
      break;
    }
    case "ping":
      reply(msg.id, {});
      break;
    default:
      reply(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
