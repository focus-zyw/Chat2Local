/**
 * 写入门控（P61）——Codex 式分级批准的核心决策。
 *
 * 审批模式（会话级，REPL 写入模式 命令切换）：
 *   deny  禁止        fail-closed：写动作原样交给 runAction 的 host 门控拒绝
 *   ask   逐笔询问    默认。每笔写动作先取 dryRun 预览（diff + 风险分级），
 *         经 confirm() 等人决定：同意（本次）/ 会话同意（记住该工具）/ 拒绝
 *   risk  风险询问    只对「覆盖已有内容」的写入询问（数据丢失风险）；
 *         新建、本会话已写过的文件、无变化自动放行
 *   auto  自动批准    全部放行（.bak 备份与 undo 栈仍然记录）
 *
 * 关键语义：确认期间调用被「持有」而不是拒绝——同意后同一个调用直接执行，
 * 模型侧只是感受到延迟，不消耗额外轮次；只有拒绝才回填一次告知模型。
 * 沙箱（授权根、敏感路径、越界、符号链接）不随审批模式放宽——由 server
 * 自身边界与 host 门控在所有模式下强制。
 */

import { isMcpWriteTool } from "./host-actions.mjs";

export const WRITE_MODE_LABELS = {
  deny: "禁止",
  ask: "逐笔询问",
  risk: "风险询问",
  auto: "自动批准",
};

function parseRiskClass(text) {
  const match = String(text ?? "").match(/^风险:\s*(\S+)/m);
  return match ? match[1] : "覆盖已有内容";
}

/**
 * @param {object} opts
 * @param {(action: object, root: string) => Promise<object>} runWithWrite
 *   以 allowWrite:true 执行一次 runAction（正常写入或 dryRun 预览共用）。
 * @param {() => string} getMode 返回当前审批模式（deny/ask/risk/auto）。
 * @param {({tool, riskClass, preview, action}) => Promise<"yes"|"session"|"no">} confirm
 *   逐笔确认实现（cli 用终端路由注入；测试注入假实现）。
 */
export function createWriteGate({ runWithWrite, getMode, confirm }) {
  const sessionApproved = new Set(); // 会话同意过的工具名（「帮我批准」语义）
  return {
    sessionApproved,
    /** 切换审批模式时收回会话同意：授权只缩不扩，收紧后同工具需重新确认。 */
    resetApprovals() {
      sessionApproved.clear();
    },
    /** 非写动作返回 null（调用方按普通路径执行）；写动作返回执行结果或拒绝结果。 */
    async intercept(action, root) {
      if (action?.op !== "mcp" || !isMcpWriteTool(action.tool)) return null;
      // dryRun 是纯预览零副作用：直接放行（模型自查预览不被确认打断）
      if (action.args?.dryRun === true) return runWithWrite(action, root);
      const mode = getMode();
      if (mode === "deny") return null; // 统一走 host 门控的拒绝文案
      if (mode === "auto" || sessionApproved.has(action.tool)) {
        return runWithWrite(action, root);
      }
      // ask / risk：先取 dryRun 预览。dryRun 本身不落盘，失败即真实调用
      // 也会同样失败（敏感/越界等确定性错误），直接回填错误、不打扰确认。
      const preview = await runWithWrite(
        { ...action, args: { ...(action.args ?? {}), dryRun: true } },
        root
      );
      if (!preview.ok) return preview;
      const previewText = preview.text;
      const riskClass = parseRiskClass(previewText);
      if (mode === "risk" && riskClass !== "覆盖已有内容") {
        return runWithWrite(action, root);
      }
      const decision = await confirm({ tool: action.tool, riskClass, preview: previewText, action });
      if (decision === "session") {
        sessionApproved.add(action.tool);
        return runWithWrite(action, root);
      }
      if (decision === "yes") return runWithWrite(action, root);
      return {
        ok: false,
        error: "write-rejected",
        text: `用户在终端查看了写入预览（${riskClass}）后拒绝了这次 ${action.tool} 调用，未执行。请调整方案、先用只读工具与用户核对，或等待用户切换审批模式。`,
      };
    },
  };
}
