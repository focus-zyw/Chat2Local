import test from "node:test";
import assert from "node:assert/strict";
import { interpretDiagnosis } from "../src/diagnose.mjs";

const visible = (selectors) => ({
  anyMatched: selectors.length > 0,
  anyVisible: true,
  detail: selectors.map((selector) => ({ selector, matched: 1, visible: 1 })),
});
const matchedOnly = (selectors) => ({
  anyMatched: selectors.length > 0,
  anyVisible: false,
  detail: selectors.map((selector) => ({ selector, matched: 1, visible: 0 })),
});
const missed = (selectors) => ({
  anyMatched: false,
  anyVisible: false,
  detail: selectors.map((selector) => ({ selector, matched: 0, visible: 0 })),
});

const COMPOSERS = ["#composer"];
const ROOTS = [".bubble.assistant"];

test("诊断: 输入框可见 → healthy", () => {
  const v = interpretDiagnosis(
    { composer: visible(COMPOSERS), messageRoots: missed(ROOTS) },
    "DeepSeek"
  );
  assert.equal(v.state, "healthy");
  assert.equal(v.cause, "composer-ok");
});

test("诊断: 输入框存在但不可见 → 遮挡/未加载，建议关弹窗重试", () => {
  const v = interpretDiagnosis(
    { composer: matchedOnly(COMPOSERS), messageRoots: missed(ROOTS) },
    "DeepSeek"
  );
  assert.equal(v.state, "unknown");
  assert.equal(v.cause, "composer-invisible");
  assert.match(v.advice, /弹窗/);
  assert.match(v.advice, /composers/);
});

test("诊断: 输入框未命中但回复区可见 → 输入框选择器失效，指向 composers", () => {
  const v = interpretDiagnosis(
    { composer: missed(COMPOSERS), messageRoots: visible(ROOTS) },
    "DeepSeek"
  );
  assert.equal(v.state, "unknown");
  assert.equal(v.cause, "composer-selector-miss");
  assert.match(v.summary, /输入框选择器未命中/);
  assert.match(v.summary, /回复区选择器正常/);
  assert.match(v.advice, /DeepSeek 改版/);
  assert.match(v.advice, /composers/);
});

test("诊断: 输入框与回复区都未命中 → 登录/大改版，指向 setup", () => {
  const v = interpretDiagnosis(
    { composer: missed(COMPOSERS), messageRoots: missed(ROOTS) },
    "DeepSeek"
  );
  assert.equal(v.state, "unknown");
  assert.equal(v.cause, "no-chat-dom");
  assert.match(v.advice, /npm run setup/);
  assert.match(v.advice, /composers 与 messageRoots/);
});

test("诊断: 缺失字段按未命中处理（防御）", () => {
  const v = interpretDiagnosis({}, "DeepSeek");
  assert.equal(v.cause, "no-chat-dom");
});
