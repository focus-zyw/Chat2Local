/**
 * 真实站点脱敏诊断采样器：
 *
 *   node scripts/probe-site.mjs <site>
 *
 * 打开站点（专用 profile 已登录），输出各阶段选择器的 命中数/可见数
 * 与细分原因。只输出计数与选择器名，不读取/打印任何聊天正文——
 * 用于：①留存健康基线；②站点改版出现真实失败时采集故障样本。
 */

import { launchBrowser } from "../src/browser.mjs";
import { createDriver } from "../src/page-driver.mjs";

const siteId = process.argv[2];
if (!siteId) {
  console.error("用法: node scripts/probe-site.mjs <site>   例如: node scripts/probe-site.mjs deepseek");
  process.exit(1);
}

const { context, channel } = await launchBrowser({ headless: false });
try {
  const driver = await createDriver({
    context,
    siteId,
    log: (m) => process.stderr.write(`[probe] ${m}\n`),
  });
  const d = await driver.diagnose();
  process.stdout.write(JSON.stringify(d, null, 2) + "\n");
} finally {
  await context.close().catch(() => {});
}
