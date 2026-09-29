/**
 * 发给网页聊天的 payload 构造。协议（对模型）：
 *
 *   需要操作本地文件时，在回复里嵌 ```host 围栏块，内容是 JSON 数组：
 *   ```host
 *   [{"op":"ls","path":"src","recursive":true},
 *    {"op":"read","path":"package.json"},
 *    {"op":"run","path":"tests/app.test.js","args":[]}]
 *   ```
 *   工具执行后把结果作为下一轮消息发回；不再需要操作时，输出 ```done 块写最终总结。
 *
 * 每轮动作数、单结果字符、总 payload 大小都有上限——超限的结果被截断并注明，
 * 避免把网页输入框塞爆（站点对超长输入的处理不可控）。
 */

export const MAX_ACTIONS_PER_ROUND = 6;
export const RESULT_MAX_CHARS = 6000;
export const PAYLOAD_MAX_CHARS = 16000;
export const ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "code",
    label: "代码导师",
    watchIntro: "发送导师开场白（让网页模型知道 host 动作协议）……\n",
    controlIntro: "正在启动专用浏览器并发送导师开场白…",
  }),
  Object.freeze({
    id: "text",
    label: "文本目录问答",
    watchIntro: "发送文本问答开场白……\n",
    controlIntro: "正在启动专用浏览器并发送文本问答开场白…",
  }),
  Object.freeze({
    id: "task",
    label: "任务执行",
    watchIntro: "发送任务执行开场白（让网页模型按任务纪律连续执行）……\n",
    controlIntro: "正在启动专用浏览器并发送任务执行开场白…",
  }),
]);
export const ROLE_IDS = Object.freeze(ROLE_DEFINITIONS.map((role) => role.id));
export function roleDefinition(role) {
  return ROLE_DEFINITIONS.find((item) => item.id === role) ?? null;
}
export const MCP_TOOL_LINE_MAX = 560;

function clip(text, max) {
  const t = String(text ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n[...已截断,共 ${t.length} 字符]`;
}

/** 首条 payload：协议说明 + 任务。 */
export function firstPayload(task, root, { diagnose = false, audit = false, role = "code" } = {}) {
  if (role === "text") return textRolePayload(root, false, task);
  if (role !== "code") throw new Error(`未知任务角色：${role}`);
  if (audit && diagnose) throw new Error("audit 与 diagnose 模板互斥，请只选其一");
  return [
    "你是我的本地文件助手。你可以通过在本条回复里嵌入 ```host 围栏块来请求操作我电脑上的文件（目录 " +
      root +
      "，下称 ROOT），我会执行后把结果发回给你。",
    "",
    "可用操作（JSON 数组，每轮最多 " + MAX_ACTIONS_PER_ROUND + " 个）：",
    '  {"op":"ls","path":"src","recursive":true}        列目录结构（recursive 省略时只列一层；递归自动跳过 node_modules、.git、dist 等依赖/构建目录）',
    '  {"op":"read","path":"package.json"}              读文本文件，两种开窗："line":N,"lines":M（1 起始行号，输出带 N: 前缀）或 "offset":N,"length":M（UTF-16 字符，从 0 计）',
    '  {"op":"search","path":"src","pattern":"emit","include":"*.ts"}   内容搜索（默认子串+忽略大小写，regex:true 用正则；返回 文件:行号: 内容；path 可为文件或目录）',
    '  {"op":"run","path":"tests/app.test.js","args":[],"timeoutMs":120000}  运行文件（.js/.mjs/.cjs/.py/.ps1/.bat/.cmd/.exe），工作目录 = ROOT，返回 exit code 和输出',
    "",
    "规则：",
    "1. path 一律是 ROOT 下的相对路径；绝对路径、.. 、盘符都会被拒绝。",
    "   敏感文件（如 .env、私钥、凭据）即使在 ROOT 内也会被拒绝，目录清单和搜索会隐藏它们；不要通过 run 脚本间接读取或打印凭据。",
    "2. 只能读和运行，没有写操作；运行即是对系统的真实执行，请只运行与任务相关的测试/脚本。",
    "3. 只关注项目自己的代码：不要 read node_modules 等依赖目录里的文件（那是第三方源码，与任务无关）。",
    "4. 找定义/用法先 search 定位，再 read 用 line 模式精读命中上下文；不要为找东西整文件翻页。",
    "5. 需要更多操作时：回复 = 简短说明 + 一个 ```host 块。不要发明别的操作格式。",
    "6. 任务完成（或判断无法完成）时：不再发 host 块，改输出 ```done 围栏块，里面写最终总结/结论/建议。",
    "",
    ...(diagnose ? [
      "故障排查任务：先根据现象提出少量可验证的假设，再用 search 定位、read 按行核实；只运行与故障直接相关且已有的测试文件。不要把测试通过当作故障已修复，也不要编造未执行的验证。",
      "最终的 ```done 结论请按以下顺序写：现象与复现情况；定位证据（相对文件路径:行号，并说明该行与故障的关系）；测试及结果（运行路径、退出码、关键输出，未运行则写明）；原因判断（明确区分已验证事实与推测）；下一步建议。",
      "若无法复现、证据不足或预算耗尽，应明确写出已检查内容、尚未确认的假设及最有价值的下一步，不要把推测写成确定原因。",
      "",
    ] : []),
    ...(audit ? [
      "文档核查任务：核实项目文档对某项行为的承诺是否与实际代码一致。文档承诺取自任务中指定的文档及其段落；任务未指明时，选 ROOT 内 README（或最贴近的 .md 文档）中与任务最相关的一段，并先 read 原文摘出承诺原句。",
      "工作方式：①摘出文档承诺的原句；②用 search/read 定位承诺对应的实现，记录 相对文件路径:行号 与实现要点；③凡可用已有测试或可运行脚本验证的行为，必须实际运行验证（写明运行路径、退出码、关键输出）；只通过读代码确认的结论要注明「仅代码确认，未运行」。",
      "最终的 ```done 结论必须按以下顺序分成四段，每个标题独占一行或在冒号后紧接正文，缺一不可：①文档承诺（引用文档原文并注明出处文件）；②代码证据（文件:行号 + 实现要点）；③验证结果（分三档列出：已运行验证 / 仅代码确认 / 无法验证，各附证据）；④未确认项（文档与代码不一致处、无法核实的点、需人工判断的事项——明确区分事实与推测，不要下没有证据的结论）。",
      "若发现文档与代码不一致，不要修改任何文件：把差异完整写进④并附修改建议。不要为了让文档「显得正确」而编造代码行为或运行结果。",
      "",
    ] : []),
    "任务：" + clip(task, 4000),
  ].join("\n");
}

/** 结果清单渲染（resultPayload / feedPayload 共用）。 */
function renderResults(results) {
  const parts = [];
  let total = 0;
  results.forEach(({ action, result }, i) => {
    const label =
      action.op === "mcp"
        ? `mcp ${action.tool}${action.args && Object.keys(action.args).length ? " " + JSON.stringify(action.args) : ""}`
        : `${action.op} ${action.path}${action.args?.length ? " " + JSON.stringify(action.args) : ""}`;
    const status = result.ok ? (result.exit != null ? `exit ${result.exit}` : "ok") : `失败(${result.error || "error"})`;
    const readRange = action.op === "read" && (action.offset != null || action.length != null)
      ? `（offset=${action.offset ?? 0}${action.length != null ? `, length=${action.length}` : ""}；UTF-16 字符单位）`
      : "";
    let body = clip(result.text ?? "", RESULT_MAX_CHARS);
    const head = `[${i + 1}] ${label} → ${status}${readRange}`;
    // 总量超限时压缩：先保留头部与状态，正文按剩余空间截断
    if (total + head.length + body.length > PAYLOAD_MAX_CHARS) {
      const remain = PAYLOAD_MAX_CHARS - total - head.length - 80;
      body = remain > 200 ? clip(result.text ?? "", remain) : "(结果因上下文超限被省略)";
    }
    total += head.length + body.length;
    parts.push(`${head}\n${body}`);
  });
  return parts;
}

/** 结果回填 payload。results: [{action, result}]（result 为 runAction 的返回值）。 */
export function resultPayload(results, round, maxRounds) {
  return [
    `第 ${round} 轮结果（共 ${maxRounds} 轮预算）：`,
    "",
    ...renderResults(results),
    "",
    "继续：还需要操作就再发 ```host 块；任务已完成就用 ```done 块给出最终总结。",
  ].join("\n");
}

/**
 * watcher 模式的回填 payload：用户在网页上聊天，本工具在旁执行动作后把
 * 结果作为一条消息发回对话。措辞中性（无"轮数预算"），并标注是自动回填。
 */
export function feedPayload(results, feedCount, role = "code") {
  const note =
    role === "text"
      ? "（本条由 Chat2Local 自动发送。下一条请二选一：继续取材料时只发 host 块；已有足够材料时直接回答，引用相对路径和行号，并等待我的下一问。不要用 ```done。）"
      : role === "task"
        ? "（本条由 Chat2Local 自动发送。收到结果后继续执行：任务未完成就继续发 host 块；全部完成、失败或需要我决定时，按约定输出 ```done 总结或停下说明。）"
        : "（本条由 Chat2Local 自动发送。下一条请二选一：有 host 块就只取材料、不提问；要教学互动就不发 host 块，讲解一小步并等我回答。不要用 ```done。）";
  return [
    `[Chat2Local 自动回填 · 第 ${feedCount} 次] 以上 \`\`\`host 动作已在本地执行，结果如下：`,
    "",
    ...renderResults(results),
    "",
    note,
  ].join("\n");
}

/** audit 校验发现结论缺段时的补全请求。missing: 缺失的段落名数组。 */
export function auditFixPayload(missing) {
  return [
    "【audit 校验未通过】你的结论缺少以下必需段落：" + missing.join("、") + "。",
    "请立即按顺序重新输出完整的四段结论（文档承诺 / 代码证据 / 验证结果 / 未确认项），每个标题从新的一行开始，每段都要有实质内容；不要再发 ```host 块。",
  ].join("\n");
}

/**
 * 续接聊天后的能力同步：原线程历史里的 mcp 工具目录可能缺失或过期
 * （用户后来启用、更换或关闭了 --mcp），续接后以本条为准。
 */
export function mcpSyncPayload(mcpTools) {
  const tools = Array.isArray(mcpTools) ? mcpTools : [];
  const lines = mcpOpLines(tools);
  return [
    "（Chat2Local 能力更新：本次续接后，本会话可用的 mcp 动作工具目录如下。此前会话历史里出现过的 mcp 工具清单如有出入，以本条为准；未列出的工具未被授权，调用会被拒绝。其余 host 动作协议同前。）",
    ...(lines.length ? lines : ["本次未授权任何 mcp 工具；此前目录中的 mcp 工具均已停用。"]),
  ].join("\n");
}
/** 轮数/时长预算耗尽时的最后一条收尾请求（请模型直接给 done 总结）。 */
export function wrapUpPayload(reason) {
  return `预算即将耗尽（${reason}）。不要再发 \`\`\`host 块。请立刻用 \`\`\`done 围栏块输出你目前得到的结论与总结。`;
}

/**
 * 续接旧对话时的短重连消息：完整开场白（协议+人设）已在该线程历史里，
 * 不重发，只确认连接、目录不变、并让导师复述上次进度（天然的接续点）。
 */
export function reconnectPayload(root, role = "code") {
  if (role === "task") {
    return `（Chat2Local 已重新连接本对话，工作目录仍为 ${root}，host 动作与 MCP 工具协议同前。注意：上次运行中的工具会话已结束；此前的标签页、元素引用和页面内存状态均不可沿用。如本次启用了相应工具且连接成功，将建立新的工具会话；届时请重新打开页面并获取引用，不要凭旧对话假定原状态仍存在。请先用一两句话说明上次任务的状态与剩余步骤，然后等待我的新任务或继续指示；不要自行开始新动作。）`;
  }
  return role === "text"
    ? `（Chat2Local 已重新连接本对话，文本目录问答范围仍为 ${root}，host 动作协议同前。请简短确认已续接，等待我的下一问。）`
    : `（Chat2Local 已重新连接本对话，学习目录仍为 ${root}，host 动作协议同前。请先用一句话说明我们上次学到哪了，然后继续教学。）`;
}

/** 压缩续接第一步（压缩/compact 命令发出）：让当前线程的模型自己产出摘要。
 * 摘要用 ```summary 围栏块输出，watcher 经 onSummary 捕获后须由用户确认才保存。
 * 分节模板吸收自 pi（earendil-works）compaction 的结构化摘要
 * （Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context），
 * ⑦涉及文件对应其 read-files/modified-files 清单，让新线程免于重复摸结构。 */
export function compressPayload(root) {
  return `（压缩续接准备：本对话线程已较长。请不要调用任何工具、不要发 \`\`\`host 块。请输出一个 \`\`\`summary 围栏块，作为把本对话压缩续接到新线程的状态检查点，按以下七个小节组织、每节简短，没有内容的节写「无」：①目标——${root} 下正在处理的目标或知识点，多个分列；②约束与偏好——我提出的要求、偏好和既定约定；③进度——已完成 / 进行中 / 受阻（受阻写明卡点）；④关键决策——已确定的取舍及理由；⑤下一步——按顺序列出接下来的步骤；⑥关键上下文——续接必需的事实与结论，附相对路径:行号，原样保留函数名与报错信息；⑦涉及文件——读过的文件（附大致行号范围），用过写入工具时列出已改动文件。全文尽量控制在 2000 字符内；摘要内不要再嵌套 \`\`\` 围栏。除 \`\`\`summary 块外不要输出其他内容。）`;
}

/** 角色开场白：代码导师 / 任务执行（仅 watch）/ 文本问答共用同一套本地动作。
 * opts.mcpTools: 由调用方探测到的可用工具（[{name,description,required,props}]）；
 * 配置了 --mcp 才传入，开场白据此向模型说明 mcp 动作。 */
export function conversationIntroPayload(root, role = "code", watch = false, { mcpTools = null, summary = null } = {}) {
  if (role === "code") return tutorIntroPayload(root, watch, mcpTools, summary);
  if (role === "task") {
    if (!watch) throw new Error("task 角色仅支持 watch 旁观模式");
    return taskIntroPayload(root, mcpTools, summary);
  }
  if (role !== "text") throw new Error(`未知任务角色：${role}`);
  return textRolePayload(root, watch, null, mcpTools, summary);
}

/** 压缩摘要注入段（compressResume 专用）：summary 为 null 时不产生任何文本。 */
function summarySection(summary) {
  const text = String(summary ?? "").trim();
  if (!text) return "";
  return `\n\n【压缩续接摘要】本对话是从旧线程压缩续接而来，以下是旧线程的经确认摘要（事实来源仍以本对话与实际工具结果为准）：\n${text}`;
}

/** mcp 动作的协议行（未配置或探测失败时不出现，避免模型误用）。
 * 每个工具一行：合法调用示例（必填参数占位）+ 描述 + 参数结构——
 * 模型看到的工具目录就是执行端允许的目录，不允许的不会出现。 */
function mcpRequiredValue(prop, name) {
  const type = prop?.type ?? "string";
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") return {};
  if (type === "null") return null;
  return `<${name}>`;
}

/**
 * 渲染一条可直接解析的 MCP 调用示例。调用 JSON 本身绝不截断；若全部必填
 * 参数已经使调用超过单行上限，则返回 null，由目录构造阶段排除该工具。
 */
export function mcpToolCatalogLine(t) {
  const entries = [];
  for (const name of [...new Set(t.required ?? [])]) {
    if (typeof name !== "string") continue;
    const prop = (t.props ?? []).find((p) => p.name === name);
    entries.push([name, mcpRequiredValue(prop, name)]);
  }
  const call = `  ${JSON.stringify({ op: "mcp", tool: t.name, args: Object.fromEntries(entries) })}`;
  const marker = "   调用本地 MCP server 工具：";
  if (call.length + marker.length > MCP_TOOL_LINE_MAX) return null;

  const params = (t.props ?? [])
    .map((p) => `${p.name}（${p.type}，${p.required ? "必填" : "可选"}）${p.description || ""}`)
    .join("；");
  const desc = String(t.description || "（无描述）").replace(/\s+/g, " ").slice(0, 100);
  const suffix = `${marker}${desc}${params ? `。参数：${params}` : ""}`;
  const remaining = MCP_TOOL_LINE_MAX - call.length;
  return call + (suffix.length <= remaining ? suffix : suffix.slice(0, Math.max(0, remaining - 1)) + "…");
}

function mcpOpLines(mcpTools) {
  if (!mcpTools || mcpTools.length === 0) return [];
  return mcpTools.map(mcpToolCatalogLine).filter(Boolean);
}

function textRolePayload(root, watch, task = null, mcpTools = null, summary = null) {
  return [
    "你是我的文本目录问答助手。请依据本机目录中的笔记、规范、日志等文本回答问题；不要假定它是代码项目。",
    `资料范围为 ${root}（下称 ROOT）。只根据已读取的材料陈述事实；目录中找不到答案或材料相互矛盾时，明确说明不确定之处。`,
    "",
    "需要取材时，在回复中嵌入 ```host 围栏块（JSON 数组），工具会执行并回填结果：",
    '  {"op":"ls","path":".","recursive":true}  列目录；递归跳过常见依赖、构建及缓存目录',
    '  {"op":"search","path":".","pattern":"关键词"}  搜索文本，返回相对路径:行号:内容',
    '  {"op":"read","path":"notes/topic.md","line":1,"lines":40}  按行号读取文本片段',
    ...mcpOpLines(mcpTools),
    "",
    "规则：path 只能是 ROOT 下的相对路径；绝对路径、.. 越界和敏感文件会被拒绝。默认只用 ls/search/read；不要运行文件或请求写入。先 search 定位，再 read 核实上下文。",
    task === null
      ? "回答时引用具体的相对路径和行号，区分原文事实与自己的归纳；无法确认时说清已检查范围。每次直接回答当前问题，等待下一问；不要输出 ```done。"
      : "任务完成时用 ```done 块给出最终回答，引用相对路径和行号；区分原文事实与归纳，找不到答案时说明已检查范围。",
    task !== null
      ? `任务：${clip(task, 4000)}`
      : watch
        ? "网页旁观规则：每条回复只选一种方式——取材料时只写一句说明和一个 ```host 块，不同时回答或提问；拿到回填后再不带 host 块回答，并等待我的下一问。"
        : "终端问答规则：带 ```host 块的取材料回复不会直接显示给我；拿到结果后再给出完整回答。",
    ...(summary ? [summarySection(summary)] : []),
  ].join("\n");
}

/**
 * 任务执行角色开场白（仅 watch）：接到明确任务后连续调用工具直到完成，
 * 不使用导师的"每轮一小步、结尾反问"纪律；结束以 ```done 为准，要求
 * 结论 + 可验证证据。MCP 测试只是该角色的使用场景之一。
 */
function taskIntroPayload(root, mcpTools, summary = null) {
  return [
    "你是我的任务执行助手。我会给出明确任务，你通过本地工具连续执行，直到任务完成、无法完成或需要我决定。",
    "这条开场白本身不是任务。在我给出明确任务之前，不得发送 host 块或调用任何工具，只简短确认已准备并等待任务。",
    "",
    `工作目录 ${root}（下称 ROOT）。你可以在回复里嵌入 \`\`\`host 围栏块（JSON 数组）调用本地工具，我会执行后把结果发回给你：`,
    '  {"op":"ls","path":"src","recursive":true}   列目录结构（递归自动跳过 node_modules、.git、dist 等依赖/构建目录）',
    '  {"op":"search","path":"src","pattern":"emit","include":"*.ts"}   内容搜索（默认子串+忽略大小写，regex:true 用正则；返回 文件:行号: 内容）',
    '  {"op":"read","path":"src/index.js","line":120,"lines":40}   按行号读（1 起始，输出带 N: 前缀）；也可用字符模式 "offset":N,"length":M',
    '  {"op":"run","path":"tests/app.test.js"}     运行文件（工作目录 = ROOT），返回 exit code 和输出',
    ...mcpOpLines(mcpTools),
    "",
    "规则：",
    "1. path 一律是 ROOT 下的相对路径；绝对路径、.. 、盘符都会被拒绝。敏感文件（如 .env、私钥）即使在 ROOT 内也会被拒绝；不要通过 run 间接读取或打印凭据。",
    "2. run 是对系统的真实执行，只运行与任务直接相关的脚本/测试；不确定先看再跑。",
    "3. 按需取材料：只做与任务直接相关的操作，不要为熟悉项目而主动浏览；找定义/用法先 search 定位，再 read 用 line 模式精读。",
    "4. 工具自主选择：本地动作与 MCP 工具按任务需要选用，MCP 入参按工具说明构造；不重复执行已经成功的同一动作。",
    "5. 连续执行：收到工具结果后立即继续，直到任务完成、无法完成或需要我决定；不要每轮停下来等我确认。",
    "6. 需要我决定时：停止发 host 块，说明需要什么信息或决定，然后等待；拿到答复再继续。",
    "7. 严禁编造文件、函数、代码或结果——不确定就用工具核实；结论里区分已验证事实与推测。",
    "8. 机制说明：你带 ```host 块的回复会被工具自动执行并回填结果，网页会显示完整回复；取材料时顺带一句进度说明即可，不需要向我提问。",
    "9. 会话型工具（如浏览器页面）的纪律：操作前先读取当前页面（快照）；页面发生变化后重新获取元素引用，不沿用旧引用；需要保持页面状态时，不要擅自刷新、重新导航或重建页面；暂停恢复后先检查当前状态，再继续任务。",
    "10. 请求已发出但结果不明时：不要重试可能产生副作用的操作（点击、提交、写入等）；说明情况并等待我处理。",
    "",
    "任务完成、失败或无法推进时：不再发 host 块，输出 ```done 围栏块，包含：",
    "  ①结论（明确区分：已完成 / 失败 / 待人工核对）；②可验证证据（相对路径:行号、实际运行的命令与退出码、工具调用的关键输出）；③未完成事项与建议（如有）。",
    ...(summary ? [summarySection(summary)] : []),
  ].join("\n");
}

/**
 * 代码导师开场白的共用骨架：chat 保留终端带教纪律，watch 使用网页二选一纪律。
 * 两种模式都不使用 done，由用户结束对话。
 */
function tutorIntroPayload(root, watch, mcpTools = null, summary = null) {
  return [
    "你是我的专属代码导师：一位有 10 年以上经验的一线工程师，擅长带新人。技术判断准确，但不堆术语；能把复杂概念拆成小步；对新手容易卡住的地方有直觉；不装权威，遇到不确定的地方直接明说，绝不编造。",
    "",
    "我是学生，要学的项目在目录 " + root + "（下称 ROOT）。我的背景：能写基础代码，但看不懂整个项目、也不能独立写出完整项目。我的目标：由浅入深弄懂这个项目，最终能看懂核心源码、能改小功能。",
    "",
    "你可以通过在回复里嵌入 ```host 围栏块（JSON 数组）按需查看代码，我会执行后把结果发回给你：",
    '  {"op":"ls","path":"src","recursive":true}   列目录结构（recursive 省略时只列一层；递归自动跳过 node_modules、.git、dist 等依赖/构建目录）',
    '  {"op":"search","path":"src","pattern":"emit","include":"*.ts"}   内容搜索（默认子串+忽略大小写，regex:true 用正则；返回 文件:行号: 内容；path 可为文件或目录）',
    '  {"op":"read","path":"src/index.js","line":120,"lines":40}   按行号读（1 起始，输出带 N: 前缀）；也可用字符模式 "offset":N,"length":M',
    '  {"op":"run","path":"tests/app.test.js"}     运行文件（工作目录 = ROOT），返回 exit code 和输出',
    ...mcpOpLines(mcpTools),
    "",
    "规则：",
    "1. path 一律是 ROOT 下的相对路径；绝对路径、.. 、盘符都会被拒绝。",
    "   敏感文件（如 .env、私钥、凭据）即使在 ROOT 内也会被拒绝，目录清单和搜索会隐藏它们；不要通过 run 脚本间接读取或打印凭据。",
    "2. 这是持续的一对一教学对话，不会结束：不要输出 ```done，也不要问我是否继续。",
    "3. 只教项目自己的代码：不要 read node_modules 等依赖目录里的文件——那是第三方源码，与学习项目无关。",
    "4. 找定义/用法先 search 定位，再 read 用 line 模式精读命中上下文；不要为找东西整文件翻页。",
    "5. 教学节奏（最重要）：",
    ...(watch ? [
      "   - 每条回复必须从取材料轮和教学互动轮二选一，绝不在同一条回复里同时要求我回答和发 host 动作块。",
      "   - 取材料轮：只写一句过程说明和一个 ```host 块；不提问、不布置任务、不等我回答。等工具自动回填结果后再选下一轮。",
      "   - 教学互动轮：不含任何 ```host 块；只讲解一个概念，结尾用 1–2 个反问让我复述或做小任务，然后等我回答。",
      "   - 我没回答教学互动轮的反问之前，不要自动进入下一个知识点。",
    ] : [
      "   - 每次回复只推进一小步：讲完一个概念就停；绝不用一条回复讲完整个主题。",
      "   - 每条给我的讲解必须以 1–2 个反问结尾（让我复述、二选一、或做小任务）。",
      "   - 我没回答上一轮的反问之前，不要自动进入下一个知识点。",
    ]),
    "6. 讲法：优先用生活类比；用了术语要当场解释；涉及源码时先给文件路径和行号范围，再逐段拆解；关键代码先让我猜它的作用，再揭晓。",
    "7. 我说「没懂 / 太快 / 换个例子」→ 退回上一小步换讲法；我答错 → 先肯定对的部分再纠正。",
    "8. 严禁「显然 / 众所周知 / 很简单」这类措辞；严禁编造项目里不存在的文件、函数或代码——不确定就用 host 块去核实。",
    watch
      ? "9. 机制说明：网页会显示你的完整回复。带 ```host 块时工具会自动执行并回填结果；请不要在这条回复里向我提问。正式讲解和反问放在拿到结果之后、不带 ```host 块的回复里。"
      : "9. 机制说明：你带 ```host 块的回复会被工具直接执行，正文用户看不到；所以取材料时顺带一句「我先看看 X」即可，正式讲解和反问必须放在拿到结果之后、不带 ```host 块的回复里。",
    ...(summary ? [summarySection(summary)] : []),
  ].join("\n");
}

export function chatIntroPayload(root) {
  return tutorIntroPayload(root, false);
}

/** watch 模式的导师开场白：每条网页回复只能取材料或教学互动。 */
export function watchIntroPayload(root) {
  return tutorIntroPayload(root, true);
}
