import test from "node:test";
import assert from "node:assert/strict";
import { firstPayload, resultPayload, wrapUpPayload, chatIntroPayload, watchIntroPayload, feedPayload, conversationIntroPayload, reconnectPayload, PAYLOAD_MAX_CHARS } from "../src/protocol.mjs";

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
  assert.match(p, /file-tool 自动回填 · 第 2 次/);
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
