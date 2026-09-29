/**
 * 站点驱动器 —— 对 loop.mjs 暴露的唯一接口：
 *   driver.send(payload) → {ok:true, text} | {ok:false, error}
 *
 * 内部：为目标站点开一个标签页（持久 profile 已有登录态），把 page-script
 * 注入页面完成 填充→发送→观看→提取。每次 send 复用同一页面（聊天上下文
 * 连续；同一会话接着聊，模型记得前几轮）。
 */

import { pageMain } from "./page-script.mjs";
import { interpretDiagnosis } from "./diagnose.mjs";
import { resolveSite } from "./sites.mjs";

export async function createDriver({
  context,
  siteId,
  siteUrl,
  startUrl,
  watchMs = 240000,
  log = () => {},
}) {
  const resolvedSite = resolveSite(siteId);
  if (!resolvedSite) throw new Error(`未知站点 "${siteId}"；运行 node src/cli.mjs list 查看可用站点`);
  // 自测服务器可能因端口冲突回退到动态端口；真实站点调用不传此项。
  const site = siteUrl ? { ...resolvedSite, url: siteUrl } : resolvedSite;
  // startUrl：续接模式打开历史对话线程；缺省打开站点首页（新聊天）。
  const landingUrl = startUrl || site.url;
  const page = await context.newPage();
  let navigated = false;

  async function ensurePage() {
    // 用标志位而非 URL 前缀判断：站点登录跳转/重定向会改 URL，
    // 按 URL 判断会让每次 send 重新 goto，把聊天上下文冲掉。
    if (navigated) return;
    log(`打开 ${site.label}${startUrl ? " 的历史聊天" : " 首页"}`);
    await page.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
    navigated = true;
  }

  return {
    siteId,
    label: site.label,
    /** 当前页面 URL（发送首条消息后即是对话线程地址，供登记续接）。 */
    currentUrl() {
      return page.url();
    },
    /** 健康三态探测——范围收敛为「仅可见输入框」（评审 P28：完整普查留给
     *  显式 diagnose()，探测不读取回复区等其他结构）。 */
    async probe() {
      if (page.isClosed()) return { state: "stopped", reason: "page-closed" };
      if (!navigated) return { state: "unknown", reason: "page-not-open" };
      try {
        const c = await page.evaluate((selectors) => {
          let matched = 0;
          let visible = 0;
          for (const selector of selectors || []) {
            try {
              for (const node of document.querySelectorAll(selector)) {
                matched += 1;
                // 可见性判定与完整诊断一致：visibility:hidden / opacity:0
                // 的元素仍可有布局矩形，getClientRects 会漏判（评审 Spec-3）
                const style = window.getComputedStyle(node);
                const box = node.getBoundingClientRect();
                const isVisible =
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  Number(style.opacity || "1") !== 0 &&
                  box.width > 0 &&
                  box.height > 0;
                if (isVisible) visible += 1;
              }
            } catch {
              /* 坏选择器跳过 */
            }
          }
          return { anyMatched: matched > 0, anyVisible: visible > 0 };
        }, site.composers || []);
        if (c.anyVisible) {
          return { state: "healthy", reason: "composer-ok", cause: "composer-ok", summary: "输入框可用" };
        }
        if (c.anyMatched) {
          return {
            state: "unknown",
            reason: "composer-invisible",
            cause: "composer-invisible",
            summary: "输入框控件在页面中存在但不可见",
            advice:
              "常见原因：站点弹窗/引导层遮挡、页面尚未加载完成。关闭站点弹窗或稍候重试；持续如此则检查 src/sites.mjs 的 composers 选择器",
          };
        }
        return {
          state: "unknown",
          reason: "composer-miss",
          cause: "composer-miss",
          summary: "未找到可见输入框",
          advice:
            "可能未登录（运行 npm run setup 登录）或站点改版（检查 src/sites.mjs 的 composers）；需要含回复区在内的完整诊断可运行 scripts/probe-site.mjs",
        };
      } catch {
        return { state: "unknown", reason: "probe-failed" };
      }
    },
    /** 完整脱敏普查：各阶段选择器的 命中数/可见数（无正文），故障定位取证用。 */
    async diagnose() {
      await ensurePage();
      const d = await page.evaluate(pageMain, { site, mode: "diagnose", payload: "", watchMs: 0 });
      return { ...d, ...interpretDiagnosis(d, site.label) };
    },
    /** 续接失败时改开新聊天：显式导航并保持会话上下文标志。 */
    async openUrl(url) {
      log(`打开 ${site.label} 的新聊天页面`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
      navigated = true;
    },
    async send(payload) {
      await ensurePage();
      // 实时进度：页面端观看循环把状态写 window.__fileToolWatch，这里定时
      // 轮询打印。DeepSeek 等思考型站点一轮生成要 1–3 分钟，期间终端如果
      // 完全静默，用户会以为工具卡死了。
      const progress = setInterval(() => {
        page
          .evaluate(() => {
            const s = window.__fileToolWatch;
            return s ? { phase: s.phase, chars: s.chars, elapsedMs: s.elapsedMs } : null;
          })
          .then((s) => {
            if (!s) return;
            const phaseText = s.phase === "watching" ? `已捕获 ${s.chars} 字符` : s.phase;
            log(
              `等待站点生成…（${phaseText}，已等 ${Math.round(s.elapsedMs / 1000)}s；生成结束并稳定 3s 后才会回收回复）`
            );
          })
          .catch(() => {}); // 页面跳转间隙轮询失败，下个周期再说
      }, 5000);
      try {
        const res = await page.evaluate(pageMain, { site, payload, watchMs });
        if (!res.ok && res.error === "no-composer") {
          // 借助脱敏普查细分原因并给出处理建议，替代笼统的"找不到输入框"
          try {
            const v = await this.diagnose();
            return {
              ok: false,
              error: `${site.label} 无法发送：${v.summary}。建议：${v.advice}`,
              cause: v.cause,
            };
          } catch {
            return {
              ok: false,
              error: `在 ${site.label} 页面找不到输入框——可能没登录或站点改版。先运行 npm run setup 登录；已登录则检查 src/sites.mjs 的 composers 选择器`,
            };
          }
        }
        return res;
      } finally {
        clearInterval(progress);
      }
    },
    /** watcher 用：最后一根 assistant 气泡的快照（不等待、不发送）。 */
    async snapshot() {
      await ensurePage();
      return page.evaluate(pageMain, { site, mode: "snapshot", payload: "", watchMs: 0 });
    },
    /**
     * watcher 用：把"等变化/等稳定"下放到浏览器内执行——页内 250ms 轮询
     * 气泡签名（公式须与 page-script.snapshotState 一致），签名变化或文本
     * 稳定满 stableMs 时立刻经 CDP 唤醒 Node，省掉空闲期的定时快照。
     * 最多等 sliceMs（分片 bounded，stop/心跳仍按时服务）。
     */
    async waitForChange(expectedSig, { stableMs = 3000, sliceMs = 10000 } = {}) {
      await ensurePage();
      try {
        const handle = await page.waitForFunction(
          (arg) => {
            const now = Date.now();
            let roots = [];
            for (const sel of arg.site.messageRoots || []) {
              try {
                document.querySelectorAll(sel).forEach((n) => {
                  if (n.offsetWidth || n.offsetHeight) roots.push(n);
                });
              } catch {
                /* 坏选择器跳过 */
              }
            }
            const tops = roots.filter((n) => !roots.some((o) => o !== n && o.contains(n)));
            const bubble = tops[tops.length - 1] || null;
            const text = bubble ? bubble.innerText || "" : "";
            let h = 5381;
            for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
            const sig = tops.length + ":" + text.length + ":" + h;
            if (!window.__ftWatch || window.__ftWatch.sig !== sig) {
              window.__ftWatch = { sig, changedAt: now };
            }
            if (sig !== arg.expected) {
              return { sig, changedAgoMs: now - window.__ftWatch.changedAt };
            }
            if (text && now - window.__ftWatch.changedAt >= arg.stableMs) {
              return { sig, changedAgoMs: now - window.__ftWatch.changedAt };
            }
            return false;
          },
          { site, expected: String(expectedSig ?? ""), stableMs },
          { polling: 250, timeout: sliceMs }
        );
        const value = await handle.jsonValue();
        await handle.dispose().catch(() => {});
        return { woke: true, ...value };
      } catch {
        return { woke: false, timeout: true }; // 分片内无变化，心跳照常
      }
    },
    /** watcher 用：把文本填入输入框并发送，不等回复。 */
    async deliver(text) {
      await ensurePage();
      const res = await page.evaluate(pageMain, { site, mode: "send", payload: text, watchMs: 0 });
      if (!res.ok && res.error === "no-composer") {
        return { ok: false, error: "no-composer", retryable: true };
      }
      if (!res.ok) return { ...res, retryable: res.error === "fill-failed" };
      return res;
    },
    /** 给标签页标题打标记，让用户认出哪个窗口是被旁观执行的。 */
    async markTab() {
      await ensurePage();
      await page
        .evaluate(() => {
          document.title = document.title.replace("〔file-tool〕", "〔Chat2Local〕");
          if (!document.title.includes("〔Chat2Local〕")) {
            document.title = "〔Chat2Local〕" + document.title;
          }
        })
        .catch(() => {});
    },
    async close() {
      await page.close().catch(() => {});
    },
  };
}
