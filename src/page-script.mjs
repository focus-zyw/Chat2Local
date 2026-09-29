/**
 * 页面端驱动脚本 —— 一个自包含函数，由 page-driver.mjs 通过 page.evaluate
 * 注入聊天页执行（Playwright 会序列化函数源码，所以内部不能引用任何外部
 * 变量/import，所有辅助逻辑必须内联）。
 *
 * 职责（移植 web-tool/extension/content/runtime.js + read-utils.js 的核心）：
 *   找输入框 → 填 payload（contenteditable 全选+insertText，大文本/怪癖走合成
 *   paste）→ 点发送（不可用则回车）→ 轮询观看（stop 按钮/思考指示/完成标记，
 *   文本稳定 2.5s 即收）→ 提取回复（剥思考块与按钮行，<pre> 重建为 ``` 围栏）。
 *
 * <pre>→围栏重建是本项目相对 web-tool 的关键差异：web-tool 用站点复制按钮
 * 读剪贴板拿字节级 markdown，这里改为 DOM 序列化时把代码块重新包上 ```，
 * 使 ```host 动作块在无剪贴板权限的情况下也能完整存活。
 */

export async function pageMain({ site, payload, watchMs, mode = "sendAndWait" }) {
  // STABLE_MS：文本稳定多久算"回复完成"。站点流式输出在段落间会有几秒停顿
  // （DeepSeek 实测），太短会截在半截回复上——曾在 2500ms 时过早收货，
  // 动作块还没渲染出来就被当作完整回复返回。3000ms 是延迟与稳健的折中；
  // 若仍发生过早收货，优先怀疑该站点的 busy 信号（stop 按钮等）失效。
  const STABLE_MS = 3000;
  const POLL_MS = 200;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function visible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function first(selectors) {
    for (const selector of selectors || []) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue; // 站点改版后的坏选择器直接跳过
      }
      for (const node of nodes) {
        if (visible(node)) return node;
      }
    }
    return null;
  }

  function allVisible(selectors, scope) {
    const found = [];
    for (const selector of selectors || []) {
      let nodes;
      try {
        nodes = (scope || document).querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (visible(node) && !found.includes(node)) found.push(node);
      }
    }
    // outermost：嵌套匹配只留最外层，避免同一回复被读 N 次
    return found.filter((n) => !found.some((o) => o !== n && o.contains(n)));
  }

  // ── 填充 ──
  function selectContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function fillPlainControl(el, text) {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function syntheticPaste(el, text) {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const paste = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    try {
      Object.defineProperty(paste, "clipboardData", { value: dt });
    } catch {
      /* 已有 */
    }
    el.dispatchEvent(paste);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }

  async function settlePaste(el, text) {
    const min = Math.min(80, String(text || "").length);
    for (let i = 0; i < 6; i++) {
      await sleep(50);
      const got = (el.innerText || el.textContent || "").length;
      if (got >= min) return;
    }
    const got = (el.innerText || el.textContent || "").length;
    if (got > 0) return; // 部分 paste 已落地——绝不再插一遍（会翻倍）
    document.execCommand("selectAll", false, undefined);
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }

  async function pasteReplace(el, text) {
    el.focus();
    selectContents(el);
    syntheticPaste(el, text);
    await settlePaste(el, text);
  }

  async function fillComposer(el, text, cfg) {
    const editable =
      el.getAttribute?.("contenteditable") === "true" || el.isContentEditable;
    if (!editable) {
      fillPlainControl(el, text);
      return;
    }
    // 大文本直接走 paste：Lexical/ProseMirror 对超长 insertText 会卡死
    if (cfg.pasteFill || text.length > 2000) {
      await pasteReplace(el, text);
      return;
    }
    el.focus();
    if (cfg.clearQuillBlank) el.classList?.remove("ql-blank");
    selectContents(el);
    if (cfg.beforeinput) {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text,
        })
      );
    }
    document.execCommand("insertText", false, text);
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
    );
    // 发送按钮仍禁用 = 站点只认真实 paste 提交 → 重新全选后合成 paste（替换而非追加）
    const btn = first(cfg.sendButtons);
    if (btn && btn.disabled) {
      selectContents(el);
      syntheticPaste(el, text);
      await settlePaste(el, text);
    }
  }

  function pressEnter(el) {
    const opts = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  // ── 回复提取 ──
  function textOf(el) {
    return (el?.innerText || el?.textContent || "").trim();
  }

  function looksTruncated(text) {
    const t = String(text || "").trimEnd();
    if (!t) return false;
    if (/[{[,:]$/.test(t)) return true;
    if (/"$/.test(t) && t.includes("{")) return true;
    const lastLine = t.split("\n").pop().trim();
    if (lastLine.startsWith("{") && !lastLine.endsWith("}")) return true;
    if (lastLine.startsWith("[") && !lastLine.endsWith("]")) return true;
    return false;
  }

  function looksLikeThinkingOnly(text) {
    if (!text) return true;
    const trimmed = text.trim();
    return (
      /^(思考中|正在思考|深度思考|Thought for|Thinking|Reasoning)\b/i.test(trimmed) &&
      trimmed.length < 120
    );
  }

  function looksLikeTurnError(text) {
    const t = String(text || "").trim();
    if (!t || t.length > 400) return false;
    return /something went wrong|出错了|发送失败|发生错误|出现了问题|再生失败|regeneration failed/i.test(t);
  }

  // DOM → markdown 序列化：<pre>/<code 块> 重建为 ```lang 围栏（保住 host 动作块）
  function langOf(el) {
    const m = (el.getAttribute?.("class") || "").match(/language-([\w#+-]+)/);
    if (m) return m[1];
    const code = el.querySelector?.('[class*="language-"]');
    const m2 = code?.getAttribute?.("class")?.match(/language-([\w#+-]+)/);
    return m2 ? m2[1] : "";
  }

  function serialize(node, out) {
    if (node.nodeType === 3) {
      out.push(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === "PRE" || (tag === "CODE" && node.querySelector("br"))) {
      const body = (node.textContent || "").replace(/\n+$/, "");
      out.push(`\n\`\`\`${langOf(node)}\n${body}\n\`\`\`\n`);
      return;
    }
    if (tag === "BR") {
      out.push("\n");
      return;
    }
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "SVG" || tag === "NOSCRIPT") return;
    for (const child of node.childNodes) serialize(child, out);
    if (tag === "P" || tag === "LI" || /^H[1-6]$/.test(tag)) out.push("\n");
  }

  function bubbleToText(bubble, cfg) {
    if (!bubble) return "";
    const clone = bubble.cloneNode(true);
    for (const selector of cfg.thinking || []) {
      try {
        clone.querySelectorAll(selector).forEach((n) => n.remove());
      } catch {
        /* bad selector */
      }
    }
    // 开头是"思考中/Thought for"的 markdown 容器整块剥掉（DeepSeek 等）
    clone
      .querySelectorAll("details, .ds-markdown, .markdown, .markdown-body")
      .forEach((node) => {
        if (/^(思考中|已深度思考|思考过程|Thought for|Thinking…|Thinking\.\.\.)/i.test(
          textOf(node).slice(0, 24)
        )) {
          node.remove();
        }
      });
    if (cfg.stripButtons) {
      clone.querySelectorAll("button, [role='button']").forEach((b) => b.remove());
    }
    // 单次递归遍历整根 clone：天然不会像逐选择器读取那样把嵌套的
    // markdown 容器重复拼 N 遍，也无需 outermost 去重（clone 是 detached
    // 节点，可见性检查本就无效）。
    const out = [];
    serialize(clone, out);
    return out.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── 观看状态 ──
  function messageRoots(cfg) {
    return allVisible(cfg.messageRoots || []);
  }

  function currentBubble(cfg, beforeRoots) {
    const roots = messageRoots(cfg);
    return roots[roots.length - 1] || null;
  }

  function busy(cfg, bubble) {
    if (first(cfg.stopButtons)) return true;
    if (first(cfg.busyOnPage)) return true;
    if (!bubble) return false;
    const head = textOf(bubble).slice(0, 120);
    const busyRe = cfg.busyTextRe || "思考中|正在思考|深度思考中|Thinking|Streaming|生成中";
    if (new RegExp(busyRe).test(head)) return true;
    for (const selector of cfg.thinking || []) {
      let nodes;
      try {
        nodes = bubble.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        if (visible(node) && /思考中|正在思考|Thinking|Streaming/i.test(textOf(node).slice(0, 40))) {
          return true;
        }
      }
    }
    // 完成标记型站点（ChatGPT）：bubble 还没有操作按钮 = 还在生成
    if (cfg.doneInBubble && cfg.doneInBubble.length) {
      let done = false;
      for (const selector of cfg.doneInBubble) {
        try {
          if (bubble.querySelector(selector)) {
            done = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!done) return true;
    }
    return false;
  }

  function turnError(cfg) {
    if (!cfg.turnError || !cfg.turnError.length) return false;
    const bubble = currentBubble(cfg, []);
    if (!bubble) return false;
    for (const selector of cfg.turnError) {
      let node;
      try {
        node = bubble.querySelector(selector);
      } catch {
        continue;
      }
      if (node && visible(node) && looksLikeTurnError(textOf(node))) return true;
    }
    return false;
  }

  // ── 共用流程块：等输入框 / 填充并发送（sendAndWait 与 watch 模式共用）──
  async function waitComposer(cfg) {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const box = first(cfg.composers);
      if (box) return box;
      await sleep(150);
    }
    return null;
  }

  async function fillAndSend(cfg, composer, payload) {
    await fillComposer(composer, payload, cfg);
    await sleep(150);
    // 填充校验：内容没进去就别点发送（会把上一条重发出去）
    const filled = (composer.innerText || composer.value || composer.textContent || "").length;
    if (filled < Math.min(40, payload.length * 0.5)) {
      return { ok: false, error: "fill-failed" };
    }
    const btn = first(cfg.sendButtons);
    if (btn && !btn.disabled) btn.click();
    else pressEnter(composer);
    await sleep(300);
    return { ok: true };
  }

  // ── 模式：snapshot —— watcher 轮询用：最后一根 assistant 气泡的状态 ──
  // 签名公式必须与 page-driver.waitForChange 里的实现保持一致：
  // `${可见根数}:${innerText长度}:${djb2(innerText)}`
  function snapshotState() {
    const cfg = site;
    // 顺手重新打窗口标记：SPA（如 DeepSeek）会重设 document.title，
    // 只在 markTab 设一次会被冲掉
    try {
      document.title = document.title.replace("〔file-tool〕", "〔Chat2Local〕");
      if (!document.title.includes("〔Chat2Local〕")) {
        document.title = "〔Chat2Local〕" + document.title;
      }
    } catch {
      /* 某些页面禁止改 title */
    }
    const roots = messageRoots(cfg);
    const bubble = roots[roots.length - 1] || null;
    const raw = bubble ? bubble.innerText || "" : "";
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
    const sig = roots.length + ":" + raw.length + ":" + h;
    const now = Date.now();
    if (!window.__ftWatch || window.__ftWatch.sig !== sig) {
      window.__ftWatch = { sig, changedAt: now };
    }
    const changedAgoMs = window.__ftWatch.sig === sig ? now - window.__ftWatch.changedAt : 0;
    return {
      count: roots.length,
      busy: busy(cfg, bubble),
      text: bubbleToText(bubble, cfg),
      sig,
      changedAgoMs,
    };
  }

  // ── 模式：send —— watcher 回填用：把文本填进输入框并发送，不等回复 ──
  async function sendPayload() {
    const cfg = site;
    const composer = await waitComposer(cfg);
    if (!composer) return { ok: false, error: "no-composer" };
    return fillAndSend(cfg, composer, payload);
  }

  // ── 模式：sendAndWait —— ask/chat 模式用：发送并等到回复稳定 ──
  async function sendAndWait() {
    const cfg = site;
    // 进度状态：Node 端定时轮询并打印，让用户看见"工具在等网页生成"，
    // 而不是以为卡死了。状态放在 window 上（evaluate 是黑盒，反向传不走）。
    const setStatus = (phase, chars, elapsedMs) => {
      try {
        window.__fileToolWatch = { phase, chars, elapsedMs };
      } catch {
        /* 某些页面禁止写 window 属性时静默放弃 */
      }
    };
    setStatus("waiting-composer", 0, 0);
    const composer = await waitComposer(cfg);
    if (!composer) {
      setStatus("no-composer", 0, 0);
      return { ok: false, error: "no-composer" };
    }

    const beforeRoots = messageRoots(cfg);
    const beforeBubble = beforeRoots[beforeRoots.length - 1] || null;
    const beforeText = bubbleToText(beforeBubble, cfg);

    setStatus("filling", payload.length, 0);
    const sent = await fillAndSend(cfg, composer, payload);
    if (!sent.ok) {
      setStatus(sent.error, 0, 0);
      return sent;
    }

    const start = Date.now();
    let sawGenerating = false;
    let stableSince = 0;
    let last = "";
    let bubble = null;

    while (Date.now() - start < watchMs) {
      if (turnError(cfg)) return { ok: false, error: "turn-error" };
      bubble = currentBubble(cfg, beforeRoots);
      const isBusy = busy(cfg, bubble);
      const text = bubbleToText(bubble, cfg);
      setStatus("watching", text.length, Date.now() - start);
      const grew =
        messageRoots(cfg).length > beforeRoots.length ||
        (text && text !== beforeText);
      if (isBusy) sawGenerating = true;
      const hasAnswer = Boolean(text) && !looksLikeThinkingOnly(text) && !looksTruncated(text);
      if ((sawGenerating || grew) && !isBusy && hasAnswer) {
        if (text === last) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= STABLE_MS) {
            return { ok: true, text };
          }
        } else {
          last = text;
          stableSince = Date.now();
        }
      } else {
        stableSince = 0;
        last = text;
      }
      await sleep(POLL_MS);
    }

    // 超时兜底：最后一根 bubble 若已有完整答案且不在生成中，仍然收下
    const fbBubble = currentBubble(cfg, beforeRoots);
    const fbText = bubbleToText(fbBubble, cfg);
    if (
      fbText &&
      fbText !== beforeText &&
      !looksLikeThinkingOnly(fbText) &&
      !looksTruncated(fbText) &&
      !busy(cfg, fbBubble)
    ) {
      return { ok: true, text: fbText };
    }
    return { ok: false, error: "watch-timeout" };
  }

  // ── 模式：diagnose —— 站点故障定位的脱敏普查 ──
  // 只报告各阶段选择器的 命中数/可见数（无任何正文内容），
  // 由 src/diagnose.mjs 的解释层映射为细分原因与处理建议。
  function diagnoseState() {
    const check = (selectors) => {
      const detail = [];
      let anyMatched = false;
      let anyVisible = false;
      for (const selector of selectors || []) {
        // 计数器刻意避开外层 visible() 函数名，防止遮蔽（此处会调用它）
        let matchedCount = 0;
        let visibleCount = 0;
        let invalid = false;
        try {
          for (const node of document.querySelectorAll(selector)) {
            matchedCount += 1;
            if (visible(node)) visibleCount += 1;
          }
        } catch {
          invalid = true;
        }
        if (matchedCount > 0) anyMatched = true;
        if (visibleCount > 0) anyVisible = true;
        detail.push({ selector, matched: matchedCount, visible: visibleCount, invalid });
      }
      return { anyMatched, anyVisible, detail };
    };
    return {
      // 仅返回 origin：完整 URL 可能包含聊天线程标识（评审 P28 脱敏要求）
      url: location.origin,
      composer: check(site.composers),
      sendButtons: check(site.sendButtons),
      messageRoots: check(site.messageRoots),
      markdownBodies: check(site.markdownBodies),
      stopButtons: check(site.stopButtons),
    };
  }

  try {
    if (mode === "snapshot") return snapshotState();
    if (mode === "diagnose") return diagnoseState();
    if (mode === "send") return await sendPayload();
    return await sendAndWait();
  } catch (err) {
    return { ok: false, error: err?.message || "page-failed" };
  }
}
