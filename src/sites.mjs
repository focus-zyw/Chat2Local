/**
 * 站点适配器配置 —— 从 web-tool/extension/content/*.js 移植的纯数据版。
 *
 * 页面端骨架（src/page-script.mjs）按这份配置统一驱动：
 * - composers / sendButtons / stopButtons / messageRoots / thinking /
 *   markdownBodies：选择器列表，取第一个可见匹配；多个候选按序回退。
 * - beforeinput / clearQuillBlank / pasteFill：填充怪癖开关
 *   （Grok TipTap、Gemini Quill 要 beforeinput+去 ql-blank；ChatGPT Lexical
 *   对大文本要直接走合成 paste）。
 * - doneInBubble：bubble 内出现 = 本轮已完成（ChatGPT 的 turn-action 按钮），
 *   未出现 = 仍在生成。
 * - busyOnPage：页面级出现 = 仍在生成（Claude 的 data-is-streaming）。
 * - busyTextRe：bubble 开头文本命中 = 仍在生成（各站的"思考中/搜索中"状态行）。
 * - turnError：最新 bubble 里出现短文本错误 = 本轮失败，快速放弃。
 * - stripButtons：读正文前剥掉 bubble 里的按钮行（复制/点赞工具条）。
 *
 * 站点改版导致 no-composer / watch-timeout 时，改这里对应站点的列表。
 */

export const SITES = {
  chatgpt: {
    label: "ChatGPT",
    url: "https://chatgpt.com/",
    composers: [
      "#prompt-textarea",
      '[data-testid="prompt-textarea"]',
      'div[placeholder*="Message"][contenteditable]',
      '[contenteditable="true"][data-lexical-editor="true"]',
    ],
    sendButtons: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="发送"]',
    ],
    stopButtons: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
    ],
    messageRoots: ['[data-message-author-role="assistant"]', ".agent-turn"],
    thinking: [
      '[data-testid="reasoning"]',
      '[data-testid="reasoning-summary"]',
      '[data-testid*="reason"]',
      ".result-thinking",
      '[class*="thinking"]',
      '[class*="Thought"]',
    ],
    markdownBodies: [".markdown"],
    pasteFill: true,
    doneInBubble: ['[data-testid*="turn-action-button"]'],
    turnError: ['[data-testid*="error"]', '[role="alert"]'],
  },

  claude: {
    label: "Claude",
    url: "https://claude.ai/new",
    composers: [
      "div.ProseMirror",
      '[data-testid="composer-input"]',
      '[aria-label="Message Claude"][contenteditable]',
      'div[role="textbox"][contenteditable]',
    ],
    sendButtons: [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="发送"]',
    ],
    stopButtons: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
    messageRoots: [
      '[data-testid="assistant-message"]',
      ".font-claude-response",
      "[data-is-streaming]",
    ],
    thinking: ['[data-testid*="thought"]', '[class*="thinking"]'],
    markdownBodies: [".font-claude-response"],
    busyOnPage: ['[data-is-streaming="true"]'],
  },

  deepseek: {
    label: "DeepSeek",
    url: "https://chat.deepseek.com/",
    composers: [
      "#chat-input",
      'textarea[placeholder*="Send a message"]',
      'textarea[placeholder*="Message DeepSeek"]',
      'textarea[placeholder*="给 DeepSeek"]',
      'textarea[data-testid="chat-input"]',
      'div[contenteditable][role="textbox"]',
    ],
    sendButtons: [
      'button[aria-label="Send message"]',
      'button[aria-label*="发送"]',
      '[data-testid="send-button"]',
    ],
    stopButtons: ['button[aria-label*="Stop"]', 'button[aria-label*="停止"]'],
    messageRoots: [
      '[data-message-author-role="assistant"]',
      ".ds-message",
      '[class*="ds-assistant"]',
      ".ds-markdown",
    ],
    thinking: [
      '[class*="ds-think"]',
      '[class*="think-content"]',
      '[class*="thinking"]',
      '[class*="Thought"]',
      "[data-think]",
    ],
    markdownBodies: [".ds-markdown", ".markdown-body"],
    stripButtons: true,
  },

  qianwen: {
    label: "通义千问",
    url: "https://www.qianwen.com/",
    composers: [
      'div[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][aria-multiline="true"]',
      'textarea[placeholder*="输入"]',
      'textarea[placeholder*="问"]',
      'textarea[placeholder*="Ask"]',
    ],
    sendButtons: [
      'button[aria-label="发送消息"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      '[data-testid="send-button"]',
    ],
    stopButtons: [
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop"]',
      '[data-is-streaming="true"]',
    ],
    messageRoots: ['[class*="answer-common-card"]'],
    thinking: ['[class*="thinking"]', '[class*="Thought"]', '[class*="reasoning"]'],
    markdownBodies: [".qk-markdown", ".markdown-body"],
  },

  doubao: {
    label: "豆包",
    url: "https://www.doubao.com/chat/",
    composers: [
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="豆包"]',
      'textarea[placeholder*="问题"]',
      'textarea[placeholder*="Ask"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
    ],
    sendButtons: [
      'button[aria-label*="发送"]',
      'button[aria-label="Send"]',
      '[data-testid="send-button"]',
    ],
    stopButtons: ['button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    messageRoots: ['[class*="v_list_row"]:has([class*="text-s-color-text-secondary"])'],
    thinking: ['[class*="thinking"]', '[class*="think"]', '[class*="Thought"]'],
    markdownBodies: ['[class*="md-box-root"]', ".markdown-body", '[class*="markdown"]'],
    busyTextRe: "正在搜索|搜索中|找到\\s*\\d+\\s*篇资料|思考中|正在思考|生成中|Thinking",
  },

  kimi: {
    label: "Kimi",
    url: "https://www.kimi.com/",
    composers: [
      ".chat-input-editor",
      'div[contenteditable="true"][class*="chat-input"]',
      'textarea[placeholder*="发消息"]',
      'textarea[placeholder*="给 Kimi"]',
      'textarea[placeholder*="Message Kimi"]',
      'textarea[placeholder*="Ask"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
    ],
    sendButtons: [
      ".send-button",
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      '[data-testid="send-button"]',
    ],
    stopButtons: ['.stop', 'button[aria-label*="停止"]', 'button[aria-label*="Stop"]'],
    messageRoots: ['[class*="segment-answer"]', ".markdown"],
    thinking: ['[class*="think"]', '[class*="reasoning"]', '[class*="Thought"]', '[class*="thinking"]'],
    markdownBodies: [".markdown", ".markdown-body"],
  },

  grok: {
    label: "Grok",
    url: "https://grok.com/",
    composers: [
      ".tiptap.ProseMirror[contenteditable='true']",
      ".ProseMirror[contenteditable='true']",
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="问"]',
    ],
    sendButtons: [
      'button[data-testid="chat-submit"]',
      'button[aria-label="Submit"]',
      'button[aria-label="提交"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="发送"]',
    ],
    stopButtons: [
      'button[aria-label="Stop response"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[data-testid="stop-button"]',
    ],
    messageRoots: ['[data-testid="assistant-message"]'],
    thinking: ['[class*="think"]', '[class*="reasoning"]', '[class*="Thought"]', '[class*="thinking"]'],
    markdownBodies: [".markdown", ".markdown-body", ".prose", '[class*="markdown"]'],
    beforeinput: true,
  },

  gemini: {
    label: "Gemini",
    url: "https://gemini.google.com/app",
    composers: [
      "rich-textarea .ql-editor[contenteditable='true']",
      ".ql-editor[contenteditable='true']",
      'div[contenteditable="true"][role="textbox"]',
      "rich-textarea [contenteditable='true']",
    ],
    sendButtons: [
      "button.send-button[aria-label='Send message']",
      "button.send-button",
      'button[aria-label="Send message"]',
      'button[aria-label="发送"]',
      'button[aria-label="发送消息"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
    ],
    stopButtons: [
      'button[aria-label="Stop"]',
      'button[aria-label="Stop responding"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      "button.stop-icon",
      ".stop-icon",
    ],
    messageRoots: ["model-response", ".model-response-text", ".response-container"],
    thinking: [
      "model-thoughts",
      ".thoughts-container",
      ".thoughts-content",
      '[class*="thought"]',
      '[class*="thinking"]',
      '[class*="Thought"]',
    ],
    markdownBodies: [
      ".model-response-text",
      "message-content",
      ".markdown-main-panel",
      ".markdown",
      ".markdown-body",
    ],
    beforeinput: true,
    clearQuillBlank: true,
  },

  zai: {
    label: "Z.ai (智谱清言)",
    url: "https://chat.z.ai/",
    composers: [
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Ask"]',
      'textarea[placeholder*="发送"]',
      'textarea[placeholder*="提问"]',
      "form textarea",
      "div[contenteditable][role='textbox']",
      "#chat-input",
    ],
    sendButtons: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]',
      'button[aria-label*="发送"]',
      'button[type="submit"]',
      "form button",
    ],
    stopButtons: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="Halt"]',
    ],
    messageRoots: [
      '[data-message-id]',
      '[class*="message"]',
      '[class*="msg-content"]',
      '[class*="chat-turn"]',
      '[class*="assistant"]',
      "[id*='answer']",
    ],
    thinking: [
      '[class*="thinking"]',
      '[class*="think-content"]',
      '[class*="reasoning"]',
      "[data-think]",
    ],
    markdownBodies: ['[class*="markdown"]', ".markdown-body", '[class*="prose"]'],
    stripButtons: true,
  },
};

// 本地 mock 聊天页（scripts/mock-chat.mjs）——端到端自测用，不碰任何真实站点
export const MOCK_SITE = {
  label: "Mock(自测)",
  url: "http://127.0.0.1:8642/",
  composers: ["#composer"],
  sendButtons: ["#send"],
  stopButtons: ["#stop"],
  messageRoots: [".bubble.assistant"],
  thinking: [".thinking"],
  markdownBodies: [".md-body"],
  isMock: true,
};

export const SITE_IDS = [...Object.keys(SITES), "mock"];

export function resolveSite(id) {
  if (id === "mock") return MOCK_SITE;
  const site = SITES[id];
  if (!site) return null;
  return site;
}
