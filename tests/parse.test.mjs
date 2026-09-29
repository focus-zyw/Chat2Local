import test from "node:test";
import assert from "node:assert/strict";
import { extractActions, normalizeReply, stripActionBlocks } from "../src/parse.mjs";

test("解析 ```host 围栏块（多动作保序）", () => {
  const reply = [
    "我先看一下目录结构。",
    "```host",
    '[{"op":"ls","path":"src","recursive":true},',
    ' {"op":"read","path":"src/app.js"}]',
    "```",
    "然后我会读入口文件。",
  ].join("\n");
  const r = extractActions(reply);
  assert.equal(r.done, null);
  assert.deepEqual(r.actions, [
    { op: "ls", path: "src", recursive: true },
    { op: "read", path: "src/app.js" },
  ]);
});

test("```json 围栏里的动作数组也接受；其他语言围栏忽略", () => {
  const r = extractActions(
    '```json\n[{"op":"ls","path":"."}]\n```\n```js\nconst x = [{"op":"ls","path":"fake"}];\n```'
  );
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].path, ".");
});

test('{"actions":[...]} 包装对象解包', () => {
  const r = extractActions('```host\n{"actions":[{"op":"run","path":"t.js"}]}\n```');
  assert.deepEqual(r.actions, [{ op: "run", path: "t.js" }]);
});

test("回归：语言标签渲染在围栏外 + 单对象动作（DeepSeek 真实样本）", () => {
  // DeepSeek 把语言标签渲染成代码块上方的独立元素，且导师会发不带数组的单对象
  const captured =
    "我先看看项目的整体结构。\nhost\n```\n" +
    '{"op":"ls","path":".","recursive":true}' +
    "\n```";
  const r = extractActions(captured);
  assert.deepEqual(r.actions, [{ op: "ls", path: ".", recursive: true }]);
});

test("单对象动作被接受；未知 op 的单对象仍拒绝", () => {
  assert.deepEqual(
    extractActions('```host\n{"op":"read","path":"a.js"}\n```').actions,
    [{ op: "read", path: "a.js" }]
  );
  assert.equal(extractActions('```\n{"op":"write","path":"x","content":"y"}\n```').actions.length, 0);
});

test("done 块返回终态与总结", () => {
  const r = extractActions("任务完成。\n```done\n所有测试通过：3 passed, 0 failed。\n```");
  assert.equal(r.done, "所有测试通过：3 passed, 0 failed。");
  assert.equal(r.actions.length, 0);
});

test("孤立 ```done 标记（无闭合）也算终态", () => {
  const r = extractActions("结论如下 ```done 全部通过");
  assert.ok(r.done !== null);
  assert.match(r.done, /全部通过/);
});

test("兜底：无围栏时识别正文里的裸 JSON 动作数组", () => {
  const reply = '我看下目录：[{"op":"ls","path":"src"},{"op":"read","path":"src/a.js"}] 请稍等';
  const r = extractActions(reply);
  assert.equal(r.actions.length, 2);
  assert.equal(r.actions[0].op, "ls");
});

test("归一化：站点把 JSON 渲染成弯引号/全角标点后仍能解析", () => {
  // 站点渲染常见变换："→“ ”、:→：、,→，
  const curly = [
    "我先看看文件。",
    "```host",
    "[",
    "  {\u201cop\u201d: \u201cread\u201d, \u201cpath\u201d: \u201csrc/app.js\u201d}",
    "]",
    "```",
  ].join("\n");
  const r = extractActions(curly);
  assert.deepEqual(r.actions, [{ op: "read", path: "src/app.js" }]);
});

test("归一化：裸 JSON 用全角括号/标点也能兜底", () => {
  const fullwidth = "我看下目录：［｛\u201cop\u201d\uff1a\u201cls\u201d\uff0c\u201cpath\u201d\uff1a\u201csrc\u201d｝］ 请稍等";
  const r = extractActions(fullwidth);
  assert.deepEqual(r.actions, [{ op: "ls", path: "src" }]);
});

test("非动作 JSON / 普通代码围栏不误判", () => {
  const r = extractActions('```json\n{"name":"demo","deps":[]}\n```\n```host\nnot json at all\n```');
  assert.equal(r.actions.length, 0);
  assert.equal(r.done, null);
});

test("含未知 op 的数组不当作动作（防误执行任意结构）", () => {
  const r = extractActions('```host\n[{"op":"write","path":"x","content":"y"}]\n```');
  assert.equal(r.actions.length, 0);
});

test("normalizeReply: 空白差异归零", () => {
  assert.equal(normalizeReply("a  b\r\n\r\nc"), normalizeReply("a b\nc"));
});

// ── stripActionBlocks（chat 模式显示）──

test("stripActionBlocks: 剥 host 与 done 块，保留代码讲解围栏", () => {
  const reply = [
    "入口在 src/index.js：",
    "```host",
    '[{"op":"read","path":"src/index.js"}]',
    "```",
    "它调用 main()：",
    "```js",
    "main();",
    "```",
    "```done",
    "完事了",
    "```",
  ].join("\n");
  const out = stripActionBlocks(reply);
  assert.ok(!out.includes("```host"));
  assert.ok(!out.includes('"op"'));
  assert.ok(!out.includes("完事了"));
  assert.ok(out.includes("```js"));
  assert.ok(out.includes("main();"));
  assert.ok(out.includes("入口在"));
  assert.ok(out.includes("它调用"));
});

test("stripActionBlocks: 未闭合的 host/done 块也剥掉", () => {
  const out = stripActionBlocks('我先看下\n```host\n[{"op":"ls","path":"."}');
  assert.equal(out, "我先看下");
});

test("stripActionBlocks: 空输入与纯正文直通", () => {
  assert.equal(stripActionBlocks(""), "");
  assert.equal(stripActionBlocks("讲解文本"), "讲解文本");
});

test("mcp 动作：host 围栏与裸 JSON 数组都能识别", () => {
  const fenced = '我用 MCP 工具搜。\n```host\n[{"op":"mcp","tool":"search_files","args":{"query":"x"}}]\n```';
  assert.deepEqual(extractActions(fenced).actions, [
    { op: "mcp", tool: "search_files", args: { query: "x" } },
  ]);
  const bare = '先查一下：[{"op":"mcp","tool":"search_files","args":{"query":"y"}}]';
  assert.deepEqual(extractActions(bare).actions, [
    { op: "mcp", tool: "search_files", args: { query: "y" } },
  ]);
});
