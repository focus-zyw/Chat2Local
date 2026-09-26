import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { orchestrate, runTurn } from "../src/loop.mjs";

function fakeDriver(script, { siteId = "deepseek" } = {}) {
  let round = 0;
  const sent = [];
  return {
    siteId,
    sent,
    async send(payload) {
      sent.push(payload);
      const reply =
        typeof script === "function" ? script(round + 1, payload) : script[Math.min(round, script.length - 1)];
      round++;
      return typeof reply === "string" ? { ok: true, text: reply } : reply;
    },
  };
}

const okExec = async () => ({ ok: true, text: "stub-result" });

test("完整流程：动作轮 → done 终态", async () => {
  const driver = fakeDriver([
    "我先看看目录。\n```host\n[{\"op\":\"ls\",\"path\":\"src\"}]\n```",
    "目录里有 main.js。\n```done\n项目结构已确认：src/main.js 为唯一入口。\n```",
  ]);
  const receipt = await orchestrate({
    driver,
    task: "看下结构",
    root: os.tmpdir(),
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "complete");
  assert.equal(receipt.rounds, 2);
  assert.match(receipt.note, /main\.js 为唯一入口/);
  assert.equal(receipt.actions.length, 1);
  assert.ok(receipt.actions[0].ok);
  // 第二条 payload 是结果回填
  assert.match(driver.sent[1], /\[1\] ls src → ok/);
});

test("排障任务只替换开场模板，仍沿用动作、回填和 Receipt", async () => {
  const driver = fakeDriver([
    '```host\n[{"op":"read","path":"src/app.js","line":8,"lines":4},{"op":"run","path":"tests/app.test.js"}]\n```',
    '```done\n原因：src/app.js:9 的判断错误。测试 tests/app.test.js 退出码 1。\n```',
  ]);
  const receipt = await orchestrate({
    driver,
    task: "测试失败",
    root: os.tmpdir(),
    diagnose: true,
    execAction: async (action) => action.op === "run"
      ? { ok: false, exit: 1, text: "FAIL" }
      : { ok: true, text: "8: if (ready) {\n9:   return false;" },
  });
  assert.match(driver.sent[0], /故障排查任务/);
  assert.match(driver.sent[1], /\[1\] read src\/app\.js → ok/);
  assert.match(driver.sent[1], /\[2\] run tests\/app\.test\.js → 失败/);
  assert.equal(receipt.endReason, "complete");
  assert.equal(receipt.ran[0].exit, 1);
  assert.match(receipt.note, /src\/app\.js:9/);
});

test("无动作回复 = 直接完成", async () => {
  const driver = fakeDriver(["你好，我没有需要执行的操作。一切就绪。"]);
  const receipt = await orchestrate({
    driver,
    task: "hi",
    root: os.tmpdir(),
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "complete");
  assert.equal(receipt.rounds, 1);
  assert.match(receipt.note, /一切就绪/);
  assert.equal("auditMissing" in receipt, false, "普通任务 Receipt 保持原有字段形状");
});

test("停滞：连续相同回复判定 stalled", async () => {
  const same = "```host\n[{\"op\":\"ls\",\"path\":\".\"}]\n```";
  const driver = fakeDriver([same]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "stalled");
  assert.equal(receipt.rounds, 3);
});

test("轮数预算：先收尾再 round-limit", async () => {
  // 每轮动作路径不同，避免误触停滞闸
  const driver = fakeDriver((round) => `\`\`\`host\n[{"op":"ls","path":"d${round}"}]\n\`\`\``);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
    maxRounds: 2,
  });
  assert.equal(receipt.endReason, "round-limit");
  // 第 maxRounds+1 轮发出的是收尾请求
  assert.match(driver.sent[2], /轮数上限 2/);
});

test("驱动错误映射 driver-error", async () => {
  const driver = fakeDriver([{ ok: false, error: "watch-timeout" }]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "driver-error");
  assert.equal(receipt.error, "watch-timeout");
});

test("单轮动作超上限被截断并告知模型", async () => {
  const actions = Array.from({ length: 8 }, (_, i) => `{"op":"ls","path":"d${i}"}`);
  // 第 1 轮发 8 个动作；之后用 done 收尾，避免预算闸干扰计数
  const driver = fakeDriver((round) =>
    round === 1 ? `\`\`\`host\n[${actions.join(",")}]\n\`\`\`` : "\`\`\`done\nok\n\`\`\`"
  );
  let executed = 0;
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: async () => {
      executed++;
      return { ok: true, text: "x" };
    },
    maxRounds: 2,
  });
  assert.equal(executed, 6);
  assert.equal(receipt.actions.length, 6);
  assert.match(driver.sent[1], /只执行了前 6 个/);
});

test("run 动作记入 receipt.ran（含输出尾巴）", async () => {
  const driver = fakeDriver([
    "```host\n[{\"op\":\"run\",\"path\":\"tests/x.test.js\"}]\n```",
    "```done\nok\n```",
  ]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: path.join(os.tmpdir()),
    execAction: async () => ({ ok: true, exit: 0, text: "1 passing" }),
  });
  assert.equal(receipt.ran.length, 1);
  assert.equal(receipt.ran[0].path, "tests/x.test.js");
  assert.equal(receipt.ran[0].exit, 0);
  assert.equal(receipt.ran[0].output, "1 passing");
});

test("动作失败把错误回填给模型（自纠错）", async () => {
  const driver = fakeDriver([
    "```host\n[{\"op\":\"read\",\"path\":\"../escape.txt\"}]\n```",
    "路径被拒，我换个方式。\n```done\n无法越界读取，任务结束。\n```",
  ]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: async () => ({ ok: false, error: "host-path", text: "路径越界" }),
  });
  assert.equal(receipt.endReason, "complete");
  assert.match(driver.sent[1], /失败\(host-path\)/);
  assert.match(driver.sent[1], /路径越界/);
});

// ── chat 模式（runTurn 单轮原语）──

test("chat 轮：动作 → 讲解，complete 返回最终讲解", async () => {
  const driver = fakeDriver([
    "我先看看入口。\n```host\n[{\"op\":\"read\",\"path\":\"src/index.js\"}]\n```",
    "入口逻辑分三步：第一步……",
  ]);
  const turn = await runTurn({
    driver,
    payload: "这个项目的入口在哪？",
    root: os.tmpdir(),
    execAction: okExec,
    maxRounds: 6,
  });
  assert.equal(turn.endReason, "complete");
  assert.match(turn.reply, /入口逻辑分三步/);
  assert.equal(turn.actions.length, 1);
  assert.equal(turn.rounds, 2);
  // 第二条 payload 是动作结果回填
  assert.match(driver.sent[1], /\[1\] read src\/index\.js → ok/);
});

test("chat 轮：纯讲解回复直接完成（rounds=1）", async () => {
  const driver = fakeDriver(["入口就是 src/index.js，无需看其他文件。"]);
  const turn = await runTurn({
    driver,
    payload: "入口在哪",
    root: os.tmpdir(),
    execAction: okExec,
  });
  assert.equal(turn.endReason, "complete");
  assert.equal(turn.rounds, 1);
  assert.match(turn.note, /入口就是/);
});

test("chat 轮：动作预算耗尽 → round-limit，note 剥掉动作块", async () => {
  const driver = fakeDriver(() => "我再看看。\n```host\n[{\"op\":\"ls\",\"path\":\".\"}]\n```");
  const turn = await runTurn({
    driver,
    payload: "讲讲结构",
    root: os.tmpdir(),
    execAction: okExec,
    maxRounds: 2,
  });
  assert.equal(turn.endReason, "round-limit");
  assert.ok(!turn.note.includes("```host"));
  assert.match(turn.note, /我再看看/);
});

test("chat 轮：默认无停滞终止，同回复继续执行直到预算", async () => {
  const driver = fakeDriver(() => "```host\n[{\"op\":\"ls\",\"path\":\".\"}]\n```");
  const turn = await runTurn({
    driver,
    payload: "t",
    root: os.tmpdir(),
    execAction: okExec,
    maxRounds: 3,
  });
  assert.equal(turn.endReason, "round-limit");
  assert.equal(turn.actions.length, 3);
});

// ── audit 完成条件校验（评审 P29：不能只靠提示词）──

test("audit 校验：done 缺段时请求补全，四段齐全才完成", async () => {
  const driver = fakeDriver([
    "```done\n只有一句总结\n```",
    // 修正后的回复：四段写在 done 围栏内（最终展示的内容即合格结论）
    "```done\n①文档承诺：README 说 search 忽略大小写。\n②代码证据：host-actions.mjs buildMatcher。\n③验证结果：已运行测试，33/33 通过。\n④未确认项：无。\n```",
  ]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
      audit: true,
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "complete");
  assert.equal("auditMissing" in receipt, false, "成功的 audit Receipt 不增加空字段");
  assert.match(driver.sent[1], /audit 校验未通过/);
  assert.match(driver.sent[1], /未确认项/);
  assert.match(receipt.note, /补全后的完整结论|文档承诺/);
});

test("audit 校验：无动作讲解缺段同样触发补全", async () => {
  const driver = fakeDriver([
    "一段没有四段结构的讲解。",
    "## 文档承诺\nREADME 的承诺。\n## 代码证据\nsrc/a.mjs:1。\n## 验证结果\n测试通过。\n## 未确认项\n无。",
  ]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
      audit: true,
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "complete");
  assert.match(driver.sent[1], /audit 校验未通过/);
  assert.match(receipt.note, /文档承诺/);
});

test("audit 校验：两次补全仍缺段则标记 audit-incomplete（不报告成功）", async () => {
  const driver = fakeDriver(() => "```done\n只有总结\n```");
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
      audit: true,
    execAction: okExec,
    maxRounds: 6,
  });
  assert.equal(receipt.endReason, "audit-incomplete", "补全耗尽仍缺段不得报告成功");
  assert.equal(receipt.auditMissing.length, 4);
  const fixes = driver.sent.filter((p) => p.includes("audit 校验未通过")).length;
  assert.equal(fixes, 2, "补全请求最多 2 次");
});

test("audit 校验：段落标签出现在围栏外、done 内无实体（评审 Spec-1 样本）", async () => {
  // 四个标签只在围栏外出现，done 里只有"只有总结"——不得据此判为合格
  const reply =
    "①文档承诺 ②代码证据 ③验证结果 ④未确认项\n```done\n只有总结\n```";
  const driver = fakeDriver(() => reply);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
    audit: true,
    maxRounds: 6,
  });
  assert.equal(receipt.endReason, "audit-incomplete", "围栏外的标签不能替代围栏内的段落");
});

test("audit 校验：段落只有标签没有实体内容同样算缺段", async () => {
  // done 内有四个标签但每个标签后没有任何说明文字
  const driver = fakeDriver(() =>
    "```done\n文档承诺 代码证据 验证结果 未确认项\n```"
  );
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
    audit: true,
    maxRounds: 6,
  });
  assert.equal(receipt.endReason, "audit-incomplete");
});

test("audit 校验：正文提及四个段名不能冒充四段结构", async () => {
  const reply =
    "```done\n文档承诺：README 要求结果包含“代码证据”，并给出验证结果和未确认项。\n```";
  const driver = fakeDriver(() => reply);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
    audit: true,
    maxRounds: 6,
  });
  assert.equal(receipt.endReason, "audit-incomplete");
  assert.deepEqual(receipt.auditMissing, ["代码证据", "验证结果", "未确认项"]);
});

test("audit 校验：四段标题顺序错误不能判为完成", async () => {
  const reply = [
    "```done",
    "④未确认项：无。",
    "③验证结果：测试通过。",
    "②代码证据：src/loop.mjs:1。",
    "①文档承诺：README 说明行为。",
    "```",
  ].join("\n");
  const driver = fakeDriver(() => reply);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
    audit: true,
    maxRounds: 6,
  });
  assert.equal(receipt.endReason, "audit-incomplete");
  assert.deepEqual(receipt.auditMissing, ["文档承诺", "代码证据", "验证结果", "未确认项"]);
});

test("非 audit 模式不触发四段校验（回归）", async () => {
  const driver = fakeDriver(["```done\n普通任务的简短总结\n```"]);
  const receipt = await orchestrate({
    driver,
    task: "t",
    root: os.tmpdir(),
    execAction: okExec,
  });
  assert.equal(receipt.endReason, "complete");
  assert.equal(receipt.rounds, 1);
});
