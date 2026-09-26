/**
 * 页面诊断的解释层 —— 把 page-script "diagnose" 模式的脱敏普查结果
 * （各阶段选择器 命中数/可见数，无任何正文内容）映射为：
 *   { state: healthy|unknown, cause, summary, advice }
 *
 * 设计约束（PLAN 待验证候选的纪律）：
 * - 只做"定位与建议"，不判定选择器对错——是否改版由人对照建议核实；
 * - 健康基线来自真实站点采样（scripts/probe-site.mjs），真实"改版失败"
 *   样本须在站点实际改版时用同一脚本采集后再补充回归。
 */

export function interpretDiagnosis(d, label = "站点") {
  const composer = d?.composer ?? {};
  const messageRoots = d?.messageRoots ?? {};

  if (composer.anyVisible) {
    return {
      state: "healthy",
      cause: "composer-ok",
      summary: "输入框可用",
      advice: "",
    };
  }
  if (composer.anyMatched) {
    return {
      state: "unknown",
      cause: "composer-invisible",
      summary: "输入框控件在页面中存在但不可见",
      advice:
        "常见原因：站点弹窗/引导层遮挡、页面尚未加载完成。关闭站点弹窗或稍候重试；持续如此则检查 src/sites.mjs 的 composers 选择器",
    };
  }
  if (messageRoots.anyVisible) {
    return {
      state: "unknown",
      cause: "composer-selector-miss",
      summary: "输入框选择器未命中，但回复区选择器正常",
      advice: `大概率 ${label} 改版只调整了输入框结构：更新 src/sites.mjs 的 composers 选择器；期间可在网页手动发送消息`,
    };
  }
  return {
    state: "unknown",
    cause: "no-chat-dom",
    summary: "输入框与回复区选择器都未命中",
    advice: `常见原因：未登录（运行 npm run setup 登录）、页面未加载完成，或 ${label} 大改版。已登录仍如此则更新 src/sites.mjs 的 composers 与 messageRoots`,
  };
}
