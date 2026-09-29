import test from "node:test";
import assert from "node:assert/strict";
import { firstPayload, resultPayload, wrapUpPayload, chatIntroPayload, watchIntroPayload, feedPayload, conversationIntroPayload, reconnectPayload, compressPayload, mcpSyncPayload, ROLE_DEFINITIONS, ROLE_IDS, PAYLOAD_MAX_CHARS } from "../src/protocol.mjs";

test("firstPayload: 含任务、root 与协议要点", () => {
  const p = firstPayload("跑通所有测试", "D:\\demo");
  assert.match(p, /跑通所有测试/);
  assert.match(p, /D:\\demo/);
  assert.match(p, /```host/);
  assert.match(p, /```done/);
  assert.match(p, /"op":"run"/);
});

test("排障模板要求定位证据、验证假设并给出可核查结论", () => {
  const p = firstPayload("启动时报错 E42", "D:\\demo", { diagnose: true });
  assert.match(p, /启动时报错 E42/);
  assert.match(p, /```host/);
  assert.match(p, /```done/);
  assert.match(p, /文件.*行号/);
  assert.match(p, /测试.*结果/);
  assert.match(p, /已验证.*推测/);
  assert.match(p, /无法复现/);
  assert.match(p, /下一步/);
  assert.doesNotMatch(firstPayload("普通任务", "D:\\demo"), /故障排查任务/);
});

test("search 已写入任务协议与两种导师开场白（先 search 定位再 read 精读）", () => {
  for (const p of [
    firstPayload("t", "D:\\demo"),
    chatIntroPayload("D:\\demo"),
    watchIntroPayload("D:\\demo"),
  ]) {
    assert.match(p, /"op":"search"/);
    assert.match(p, /先 search 定位/);
    assert.match(p, /"line":/);
  }
});

test("resultPayload: 状态与输出格式正确", () => {
  const p = resultPayload(
    [
      { action: { op: "ls", path: "src" }, result: { ok: true, text: "a.js\nb.js" } },
      { action: { op: "run", path: "t.js" }, result: { ok: false, exit: 1, error: "exit 1", text: "FAIL x" } },
    ],
    2,
    12
  );
  assert.match(p, /\[1\] ls src → ok/);
  assert.match(p, /a\.js/);
  assert.match(p, /\[2\] run t\.js → 失败\(exit 1\)/);
  assert.match(p, /FAIL x/);
  assert.match(p, /第 2 轮结果/);
});

test("read 回填标出 offset/length，避免把分段结果误认作从头读取", () => {
  const action = { op: "read", path: "src/requests/sessions.py", offset: 120, length: 180 };
  const result = { ok: true, text: "第 120 个字符后的内容" };
  const payload = feedPayload([{ action, result }], 1);
  assert.match(payload, /\[1\] read src\/requests\/sessions\.py → ok/);
  assert.match(payload, /offset=120/);
  assert.match(payload, /length=180/);
});

test("resultPayload: 超总限被压缩而不是塞爆", () => {
  const big = "x".repeat(PAYLOAD_MAX_CHARS); // 单个结果就超总限
  const p = resultPayload([{ action: { op: "read", path: "big.txt" }, result: { ok: true, text: big } }], 1, 12);
  assert.ok(p.length <= PAYLOAD_MAX_CHARS + 500, `payload 过大: ${p.length}`);
  assert.match(p, /已截断|被省略/);
});

test("wrapUpPayload: 禁止再发动作并要求 done", () => {
  const p = wrapUpPayload("轮数上限 12");
  assert.match(p, /轮数上限 12/);
  assert.match(p, /```done/);
});

test("feedPayload: 自动回填措辞，无轮数预算语义", () => {
  const p = feedPayload(
    [{ action: { op: "ls", path: "src" }, result: { ok: true, text: "a.js" } }],
    2
  );
  assert.match(p, /Chat2Local 自动回填 · 第 2 次/);
  assert.match(p, /\[1\] ls src → ok/);
  assert.ok(!p.includes("轮预算"), "watcher 回填不应有任务模式的轮数预算");
  assert.match(p, /不要用 \`\`\`done/);
  assert.match(p, /二选一/);
  assert.match(p, /有 host.*不提问/);
});

test("chatIntroPayload: 导师带教纪律完整，无 done 终态", () => {
  const p = chatIntroPayload("D:\\demo");
  // 基础机制
  assert.match(p, /D:\\demo/);
  assert.match(p, /```host/);
  assert.match(p, /"op":"run"/);
  assert.match(p, /不要输出 \`\`\`done/);
  assert.match(p, /不会结束/);
  // 导师人设与带教纪律（提示词的核心承诺，防回归）
  assert.match(p, /代码导师/); // smoke:chat 的 mock 页靠这个词识别导师模式
  assert.match(p, /反问/);
  assert.match(p, /行号/);
  assert.match(p, /类比/);
  assert.match(p, /先让我猜/);
  assert.match(p, /一小步/);
  assert.match(p, /退回上一小步/);
  assert.match(p, /显然/); // 严禁清单里有它
  // host 块回复不投递给用户的机制说明（讲解必须放在无动作块的回复里）
  assert.match(p, /看不到/);
});

test("watch 开场白要求 host 取材料与用户教学互动逐条二选一", () => {
  const p = watchIntroPayload("D:\\demo");
  assert.match(p, /二选一/);
  assert.match(p, /取材料.*host/);
  assert.match(p, /取材料.*不提问/);
  assert.match(p, /教学互动.*不含.*host/);
  assert.match(p, /等.*回答/);
  assert.doesNotMatch(p, /正文用户看不到/);
});

test("文本问答角色引用文件行号，不带代码导师带教纪律", () => {
  for (const watch of [false, true]) {
    const p = conversationIntroPayload("D:\\notes", "text", watch);
    assert.match(p, /文本目录问答/);
    assert.match(p, /search/);
    assert.match(p, /read/);
    assert.match(p, /路径.*行号/);
    assert.match(p, /不确定/);
    assert.doesNotMatch(p, /我是学生|反问|关键代码先让我猜/);
    assert.match(p, /不要输出 ```done/);
  }
  assert.match(reconnectPayload("D:\\notes", "text"), /文本目录问答/);
  assert.doesNotMatch(feedPayload([], 1, "text"), /教学互动|反问/);
  assert.equal(conversationIntroPayload("D:\\code", "code", true), watchIntroPayload("D:\\code"));
});

test("一次性文本问答任务保留 done 终态并要求引用文本来源", () => {
  const p = firstPayload("审批时限是多少？", "D:\\notes", { role: "text" });
  assert.match(p, /审批时限是多少/);
  assert.match(p, /文本目录问答/);
  assert.match(p, /```host/);
  assert.match(p, /```done/);
  assert.match(p, /相对路径.*行号/);
  assert.doesNotMatch(p, /只关注项目自己的代码/);
});

test("audit 模板：四段结构写入开场白，且与 diagnose 互斥", () => {
  const p = firstPayload("核查 README 的 search 承诺", "D:\demo", { audit: true });
  assert.match(p, /文档承诺/);
  assert.match(p, /代码证据/);
  assert.match(p, /验证结果/);
  assert.match(p, /未确认项/);
  assert.match(p, /每个标题独占一行/);
  assert.match(p, /文件:行号/);
  assert.match(p, /不要修改任何文件/);
  assert.throws(
    () => firstPayload("t", "D:\demo", { audit: true, diagnose: true }),
    /互斥/
  );
});

test("mcp: 回填标签用 tool 名（mcp 动作没有 path）", () => {
  const p = feedPayload(
    [{ action: { op: "mcp", tool: "search_files", args: { query: "x" } }, result: { ok: true, text: "[R1] a.md:1: x" } }],
    1
  );
  assert.match(p, /\[1\] mcp search_files \{"query":"x"\} → ok/);
  assert.match(p, /\[R1\] a\.md:1: x/);
});

test("mcp: 开场白呈现必填参数的合法示例与参数结构；续接同步 payload 以目录为准", () => {
  const withMcp = conversationIntroPayload("D:\\demo", "code", true, {
    mcpTools: [
      {
        name: "search_files",
        description: "跨多个授权目录搜索文件内容（只读）",
        required: ["query"],
        props: [
          { name: "query", type: "string", required: true, description: "搜索词" },
          { name: "regex", type: "boolean", required: false, description: "按正则解释" },
        ],
      },
    ],
  });
  assert.match(withMcp, /"op":"mcp","tool":"search_files"/);
  assert.match(withMcp, /\{"query":"<query>"\}/, "必填 string 参数应生成合法调用示例");
  assert.match(withMcp, /query（string，必填）搜索词/);
  assert.match(withMcp, /regex（boolean，可选）/);
  const sync = mcpSyncPayload([
    { name: "t1", description: "d1", required: ["q"], props: [{ name: "q", type: "string", required: true, description: "" }] },
  ]);
  assert.match(sync, /以本条为准/);
  assert.match(sync, /"op":"mcp","tool":"t1","args":\{"q":"<q>"\}/);
  assert.doesNotMatch(sync, /```done/);
  const disabled = mcpSyncPayload([]);
  assert.match(disabled, /本次未授权任何 mcp 工具/);
  assert.doesNotMatch(disabled, /"op":"mcp"/);
});

test("mcp: 合法示例保留全部必填参数及其 JSON 类型，且不截断调用 JSON", () => {
  const tools = [
    {
      name: "batch_lookup",
      description: "批量查询",
      required: ["ids", "query", "limit", "dryRun", "options"],
      props: [
        { name: "ids", type: "array", required: true, description: "编号列表" },
        { name: "query", type: "string", required: true, description: "查询词" },
        { name: "limit", type: "integer", required: true, description: "上限" },
        { name: "dryRun", type: "boolean", required: true, description: "试运行" },
        { name: "options", type: "object", required: true, description: "选项" },
      ],
    },
  ];
  const line = mcpSyncPayload(tools).split("\n")[1];
  const callText = line.match(/^\s*(\{.*\})\s+调用本地 MCP server 工具：/)?.[1];
  assert.ok(callText, "调用示例必须是完整、未截断的 JSON 对象");
  assert.deepEqual(JSON.parse(callText), {
    op: "mcp",
    tool: "batch_lookup",
    args: { ids: [], query: "<query>", limit: 1, dryRun: true, options: {} },
  });
  assert.ok(line.length <= 560, "单条工具目录仍遵守 560 字符上限");
});

test("mcp: 配置了工具时开场白列出 mcp 动作；未配置则不提", () => {
  const withMcp = conversationIntroPayload("D:\demo", "code", true, {
    mcpTools: [{ name: "search_files", description: "跨多个授权目录搜索文件内容（只读）" }],
  });
  assert.match(withMcp, /"op":"mcp","tool":"search_files"/);
  assert.match(withMcp, /跨多个授权目录搜索/);
  // text 角色的 watch 开场白同样支持注入
  const textRole = conversationIntroPayload("D:\demo", "text", true, {
    mcpTools: [{ name: "search_files", description: "跨目录搜索" }],
  });
  assert.match(textRole, /"op":"mcp"/);
  const without = conversationIntroPayload("D:\demo", "code", true);
  assert.doesNotMatch(without, /"op":"mcp"/);
});

test("task 角色：连续执行纪律开场白，无教学反问，done 以结论+证据收尾", () => {
  assert.ok(ROLE_IDS.includes("task"), "ROLE_IDS 应包含 task");
  assert.deepEqual(ROLE_IDS, ROLE_DEFINITIONS.map((role) => role.id), "角色 ID 由统一元数据派生");
  assert.equal(new Set(ROLE_DEFINITIONS.map((role) => role.label)).size, ROLE_DEFINITIONS.length, "角色标签不得重复");
  const p = conversationIntroPayload("D:\\demo", "task", true, {
    mcpTools: [{ name: "search_files", description: "跨目录搜索", required: ["query"], props: [{ name: "query", type: "string", required: true, description: "搜索词" }] }],
  });
  assert.match(p, /任务执行助手/);
  assert.match(p, /连续执行/);
  assert.match(p, /按需取材料/);
  assert.match(p, /开场白本身不是任务/);
  assert.match(p, /给出明确任务之前.*不得发送 host 块或调用任何工具/);
  assert.match(p, /可验证证据/);
  assert.match(p, /"op":"mcp","tool":"search_files"/);
  assert.match(p, /D:\\demo/);
  // 会话型工具（浏览器页面）纪律
  assert.match(p, /会话型工具/);
  assert.match(p, /页面发生变化后重新获取元素引用/);
  assert.match(p, /不要擅自刷新、重新导航或重建页面/);
  assert.match(p, /暂停恢复后先检查当前状态/);
  assert.match(p, /不要重试可能产生副作用的操作/);
  // done 结论三分：已完成 / 失败 / 待人工核对
  assert.match(p, /已完成 \/ 失败 \/ 待人工核对/);
  // 不携带导师/文本问答的纪律关键词
  assert.doesNotMatch(p, /反问|每轮一小步|二选一|文本目录问答助手/);
  // 仅 watch 支持：终端 chat 抛错
  assert.throws(() => conversationIntroPayload("D:\\demo", "task", false), /仅支持 watch/);
  // 未知角色仍报错
  assert.throws(() => conversationIntroPayload("D:\\demo", "nope", true), /未知任务角色/);
});

test("task 角色：回填注记为继续执行，重连消息要求汇报任务状态", () => {
  const feed = feedPayload(
    [{ action: { op: "read", path: "package.json" }, result: { ok: true, text: "{}" } }],
    2,
    "task"
  );
  assert.match(feed, /收到结果后继续执行/);
  assert.doesNotMatch(feed, /二选一|教学互动/);
  const re = reconnectPayload("D:\\demo", "task");
  assert.match(re, /上次任务的状态与剩余步骤/);
  assert.match(re, /不要自行开始新动作/);
  // 重连消息先于 MCP 建连：只能确认旧状态不可沿用，不能预告新连接已建立
  assert.match(re, /上次运行中的工具会话已结束/);
  assert.match(re, /标签页、元素引用和页面内存状态均不可沿用/);
  assert.match(re, /如本次启用了相应工具且连接成功/);
  assert.doesNotMatch(re, /已重建全部工具会话/);
});

test("压缩续接：compressPayload 请求 summary 围栏且禁用工具；摘要注入三角色开场白", () => {
  const c = compressPayload("D:\proj");
  assert.match(c, /```summary/);
  assert.match(c, /不要调用任何工具/);
  assert.match(c, /D:\proj/);
  // 结构化分节模板（吸收 pi compaction：Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context）
  assert.match(c, /①目标/);
  assert.match(c, /②约束与偏好/);
  assert.match(c, /③进度/);
  assert.match(c, /④关键决策/);
  assert.match(c, /⑤下一步/);
  assert.match(c, /⑥关键上下文/);
  assert.match(c, /相对路径:行号/);
  assert.match(c, /⑦涉及文件/);
  assert.match(c, /不要输出其他内容/);

  // 摘要注入：三角色开场白都带摘要段；不带 summary 时开场白不变
  const base = conversationIntroPayload("D:\proj", "task", true, { mcpTools: null });
  const withSummary = conversationIntroPayload("D:\proj", "task", true, { mcpTools: null, summary: "旧线程：任务进行到第 3 步" });
  assert.match(withSummary, /【压缩续接摘要】/);
  assert.match(withSummary, /任务进行到第 3 步/);
  assert.match(withSummary, /事实来源仍以本对话与实际工具结果为准/);
  assert.ok(withSummary.length > base.length);
  assert.doesNotMatch(base, /压缩续接摘要/);

  // 导师与文本角色同样注入（协议正文关键词测试锁定的内容不受影响）
  const tutor = conversationIntroPayload("D:\proj", "code", true, { summary: "上学到循环" });
  assert.match(tutor, /【压缩续接摘要】/);
  assert.match(tutor, /专属代码导师/);
  const text = conversationIntroPayload("D:\proj", "text", true, { summary: "已核对审批时限" });
  assert.match(text, /【压缩续接摘要】/);

  // 空白摘要不产生注入段
  const blank = conversationIntroPayload("D:\proj", "task", true, { summary: "   " });
  assert.doesNotMatch(blank, /压缩续接摘要/);
});
