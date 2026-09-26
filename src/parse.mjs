/**
 * 从网页聊天回复文本里解析 Host 动作。
 *
 * 主路径：```host 围栏块（协议规定的格式）。兜底路径：裸 JSON 数组——
 * 页面端会把 <pre> 重建为围栏，但站点改版/渲染异常时围栏标记仍可能丢失，
 * 这时只要正文里有一段能 parse 成动作数组的 JSON 就照常执行（便宜且安全：
 * 动作本身仍要过 host-actions 的沙箱）。
 *
 * 终态信号：```done 围栏块（含最终总结）优先；其次整条回复没有任何动作块
 * （由 loop 判定 complete）。
 */

import { KNOWN_OPS } from "./host-actions.mjs";

// ```lang\n...``` —— lang 行允许 [a-zA-Z0-9_-]*；非贪婪到最近的 ```
const FENCE_RE = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

// ── 标点归一化 ──
// 不少站点渲染代码块时会把直引号转成中文弯引号（“ ”）、冒号/逗号变全角
// （：，）——JSON.parse 对这些直接报错，动作块就会"看不见"。web-tool 的
// 设计文档把这叫 transformed punctuation，是它改用复制按钮读剪贴板的原因。
// 我们在 DOM 提取路线上用解析前归一化兜底：先原样 parse，失败再归一化重试，
// 避免误伤内容里本来就有的全角字符。
const PUNCT_MAP = [
  [/[\u201c\u201d]/g, '"'], // “ ” → "
  [/[\u2018\u2019]/g, "'"], // ‘ ’ → '
  [/\uff1a/g, ":"], // ：  → :
  [/\uff0c/g, ","], // ，  → ,
  [/\uff1b/g, ";"], // ；  → ;
  [/\uff3b/g, "["], // ［  → [
  [/\uff3d/g, "]"], // ］  → ]
  [/\uff5b/g, "{"], // ｛  → {
  [/\uff5d/g, "}"], // ｝  → }
];

export function normalizeJsonPunct(text) {
  let t = String(text ?? "");
  for (const [re, to] of PUNCT_MAP) t = t.replace(re, to);
  return t;
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function looksLikeActionArray(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  return (
    value.length <= 12 &&
    value.every(
      (item) =>
        item && typeof item === "object" && !Array.isArray(item) &&
        KNOWN_OPS.includes(String(item.op || ""))
    )
  );
}

/** 单个动作对象（op 在白名单内）；否则 null。 */
function asSingleAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return KNOWN_OPS.includes(String(value.op || "")) ? value : null;
}

function tryParseActionBlock(raw, lang) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  let value = parseJsonLoose(text) ?? parseJsonLoose(normalizeJsonPunct(text));
  // {"actions":[...]} 也可（有些模型爱包一层对象）
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.actions)) {
    value = value.actions;
  }
  // 单对象动作 {"op":...}：DeepSeek 实测会不加数组直接发一个，包成数组
  const single = asSingleAction(value);
  if (single) value = [single];
  if (!looksLikeActionArray(value)) return null;
  return value;
}

// 无围栏时的兜底：找正文里平衡的 `[...]` JSON 数组（必须含 "op"）。
// 从每个候选 `[` 起做括号配对，parse 成功且像动作数组就收。
function findBareActionArray(text) {
  let best = null;
  const start = text.indexOf(`[`);
  if (start === -1) return null;
  for (let i = text.indexOf("["); i !== -1; i = text.indexOf("[", i + 1)) {
    // 快速预筛：动作 JSON 的特征在开头 200 字符内应可见
    const probe = text.slice(i, i + 200);
    if (!/"op"/.test(probe)) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = tryParseActionBlock(text.slice(i, j + 1), "bare");
          if (candidate && (!best || candidate.length > best.length)) best = candidate;
          break;
        }
        if (depth < 0) break;
      }
    }
    if (best) return best; // 第一个成功的就够了（多个动作数组并存是模型犯错）
  }
  return best;
}

/**
 * @returns {{actions: Array<{op:string,[k:string]:unknown}>, done: string|null}}
 *   actions: 本轮要执行的动作（已保序去重同一块内不处理）
 *   done:    ```done 块里的总结文本；没有则 null
 */
export function extractActions(text) {
  const t = String(text ?? "");
  const out = { actions: [], done: null };

  // done 块优先识别（即使同回复里还有动作块，done 也算终态——模型明确收工）
  const doneRe = /```done[ \t]*\r?\n?([\s\S]*?)```/i;
  const doneM = t.match(doneRe);
  if (doneM) {
    out.done = doneM[1].trim();
    return out;
  }
  // ```done 单行无闭合（流渲染被截断时也可能这样收尾）——只要出现就当收工信号
  if (/```done\b/i.test(t)) {
    out.done = t.replace(/```done\b/i, "").replace(/```/g, "").trim();
    return out;
  }

  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(t)) !== null) {
    const [, lang, body] = m;
    if (lang && lang.toLowerCase() !== "host" && lang.toLowerCase() !== "json") continue;
    const actions = tryParseActionBlock(body, lang);
    if (actions) {
      out.actions.push(...actions);
    }
  }

  if (out.actions.length === 0) {
    const bare = findBareActionArray(t) ?? findBareActionArray(normalizeJsonPunct(t));
    if (bare) out.actions = bare;
  }
  return out;
}

/** 回复规范化（停滞检测用）：去空白差异，只比内容骨架。 */
export function normalizeReply(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * 剥掉回复里的动作相关围栏，留下给人看的正文（chat 模式显示用）。
 * 只剥 ```host 与 ```done 块——```json 可能是正常内容（示例配置等），
 * ```js 等代码围栏更是讲解的一部分，全部保留。
 */
export function stripActionBlocks(text) {
  let t = String(text ?? "");
  t = t.replace(/```done[ \t]*\r?\n[\s\S]*?```/gi, "");
  t = t.replace(/```done\b[\s\S]*$/i, ""); // 未闭合的 done（流截断）
  t = t.replace(/```host[ \t]*\r?\n[\s\S]*?```/gi, "");
  t = t.replace(/```host\b[\s\S]*$/i, ""); // 未闭合的 host
  return t.replace(/\n{3,}/g, "\n\n").trim();
}
