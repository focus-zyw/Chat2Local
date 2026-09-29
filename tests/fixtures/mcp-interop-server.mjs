/**
 * 互操作 fixture MCP server —— 刻意独立实现，用于验证 mcp-client 不依赖
 * 自带 demo server 的特殊行为。与 demo/mcp-search-server.mjs 的差异点：
 *
 * - 手写缓冲 + `for await` 读 stdin（demo 用 readline）
 * - 响应使用 CRLF 行尾；server 主动推送一条 notification
 * - initialize 应答不同的 protocolVersion（"2025-06-18"），客户端必须照单全收
 * - 启动时先向 stdout 写一行非 JSON banner
 * - 一个工具带完整 inputSchema（required + 参数描述），另一个完全没有 schema
 * - tools/call 同时返回 content 与 structuredContent
 * - 中文输出按字节在多字节字符内部切开、分两次 write——验证客户端跨块解码
 *
 * 本文件只服务于 tests/mcp-interop.test.mjs，不进入 src/。
 */

const SERVER_INFO = { name: "interop-fixture", version: "9.9.9" };

async function main() {
  let buf = Buffer.alloc(0);
  const pendingWrites = [];

  const writeLine = (obj) => {
    pendingWrites.push(Buffer.from(JSON.stringify(obj) + "\r\n", "utf8"));
  };

  /** 把一行按字节切开分两次写，切口落在多字节字符内部（跨块解码验证）。 */
  const writeLineSplitMidChar = (obj) => {
    const bytes = Buffer.from(JSON.stringify(obj) + "\r\n", "utf8");
    let cut = -1;
    for (let i = 10; i < bytes.length; i++) {
      if ((bytes[i] & 0xc0) === 0x80) {
        cut = i; // UTF-8 续字节：切口前一个字符必然被切成两半
        break;
      }
    }
    if (cut === -1) {
      pendingWrites.push(bytes);
      return;
    }
    // 两半跨事件循环写出，避免管道把连续 write 合并成同一个 data 事件。
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 20);
  };

  const tools = [
    {
      name: "echo_cn",
      title: "中文回声",
      description: "把 text 参数原样返回（含中文与长文本）。用于验证调用与解码链路。",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "要回声的文本" },
          repeat: { type: "number", description: "重复次数（可选，默认 1）" },
        },
        required: ["text"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "bare_tool",
      description: "没有 inputSchema 的工具（schema 缺失是合法形态）。",
    },
  ];

  const handle = (msg) => {
    if (typeof msg.method !== "string") return;
    if (msg.id === undefined || msg.id === null) return; // 客户端 notification：忽略
    switch (msg.method) {
      case "initialize":
        // 故意应答一个比客户端请求更新的 protocolVersion
        writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        });
        // 随后主动推送一条 notification（客户端必须安静忽略）。
        // 注意：不用 tools/list_changed——常驻语义下它会正确地停用连接，
        // 该行为由 tests/mcp-resident.test.mjs 的 announce_change 用例覆盖。
        writeLine({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 0, total: 1 } });
        break;
      case "tools/list":
        writeLine({ jsonrpc: "2.0", id: msg.id, result: { tools } });
        break;
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        if (name !== "echo_cn") {
          writeLine({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: `未知工具：${name || "(缺失)"}` },
          });
          break;
        }
        const text = String(msg.params?.arguments?.text ?? "");
        const repeat = Math.max(1, Math.min(Number(msg.params?.arguments?.repeat) || 1, 3));
        const echoed = text.repeat(repeat);
        const result = {
          content: [{ type: "text", text: `回声：${echoed}` }],
          structuredContent: { length: echoed.length },
          isError: false,
        };
        if (text.includes("分块")) {
          result.content[0].text += "\n[fixture:split-write]";
          writeLineSplitMidChar({ jsonrpc: "2.0", id: msg.id, result });
        } else writeLine({ jsonrpc: "2.0", id: msg.id, result });
        break;
      }
      case "ping":
        writeLine({ jsonrpc: "2.0", id: msg.id, result: {} });
        break;
      default:
        writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        });
    }
  };

  const flush = () => {
    for (const chunk of pendingWrites.splice(0)) process.stdout.write(chunk);
  };

  process.stdout.write("interop-fixture ready (这一行不是 JSON)\n");
  for await (const chunk of process.stdin) {
    buf = Buffer.concat([buf, chunk]);
    let nl;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handle(msg);
    }
    flush();
  }
}

main().catch((err) => {
  process.stderr.write(`interop-fixture crashed: ${err?.stack || err}\n`);
  process.exit(1);
});
