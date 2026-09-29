/**
 * 受限堆验证 runner —— 由 tests/mcp-bounded.test.mjs 以
 * `node --max-old-space-size=64 mcp-heap-runner.mjs <state-server>` 启动。
 *
 * 目的：证明洪峰输出下客户端"主动报告超限"先于任何内存失控——
 * - 主证据：打印 HEAP-RUNNER-OK（客户端以帧上限语义报错），进程正常退出；
 * - 辅证：运行期间持续采样 RSS，超过安全阈值即自判失败（不是事后单点读数）。
 * 若接收无界，洪峰会在阈值告警或超时前持续推高 RSS，测试失败。
 */

import { createMcpClient } from "../../src/mcp-client.mjs";

const stateServer = process.argv[2];
if (!stateServer) {
  process.stderr.write("用法：node mcp-heap-runner.mjs <state-server 路径>\n");
  process.exit(2);
}

const RSS_LIMIT = 256 * 1024 * 1024; // 修好的实现峰值 ≈ Node 基线 + 1MiB，远低于此
let maxRss = 0;
const rssTimer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > maxRss) maxRss = rss;
  if (rss > RSS_LIMIT) {
    console.error(`HEAP-RUNNER-FAIL rss=${Math.round(rss / 1048576)}MB 超过 ${Math.round(RSS_LIMIT / 1048576)}MB——接收疑似无界`);
    process.exit(2);
  }
}, 100);

let client;
try {
  client = await createMcpClient(
    { command: process.execPath, args: [stateServer], cwd: process.cwd() },
    { startupTimeoutMs: 15000 }
  );
  // 不设短超时：超限必须由帧上限触发，而不是由超时触发
  const result = await client.callTool("flood_nonl", {}, { timeoutMs: 120000 });
  if (result.ok !== false || result.error !== "mcp-outcome-unknown") {
    console.error(`HEAP-RUNNER-FAIL 洪峰调用返回了非预期结果：${JSON.stringify({ ok: result.ok, error: result.error })}`);
    process.exit(2);
  }
  if (!/接收上限/.test(result.text)) {
    console.error(`HEAP-RUNNER-FAIL 超限原因不是帧上限：${result.text}`);
    process.exit(2);
  }
  console.log(`HEAP-RUNNER-OK 超限已主动报告（maxRss=${Math.round(maxRss / 1048576)}MB）；${result.text}`);
  process.exit(0);
} catch (err) {
  console.error(`HEAP-RUNNER-FAIL ${err?.stack || err}`);
  process.exit(2);
} finally {
  clearInterval(rssTimer);
  try {
    await client?.close();
  } catch {
    /* 收尾失败不影响结论 */
  }
}
