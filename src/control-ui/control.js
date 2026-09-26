const rootInput = document.querySelector("#root");
const siteInput = document.querySelector("#site");
const roleInput = document.querySelector("#role");
const threadUrlInput = document.querySelector("#thread-url");
const threadStatus = document.querySelector("#thread-status");
const errorBox = document.querySelector("#error");
const buttons = Object.fromEntries(["start", "pause", "resume", "confirm-recovery", "stop", "bind-thread"].map((id) => [id, document.getElementById(id)]));
let token = "";
let working = false;
let threadCheckTimer;
let threadCheckSeq = 0;
let lastPhase = "";

function queueThreadCheck() {
  clearTimeout(threadCheckTimer);
  const seq = ++threadCheckSeq;
  const siteId = siteInput.value;
  const role = roleInput.value;
  const root = rootInput.value.trim();
  threadStatus.className = "thread-status";
  if (!siteId || !root || !token) {
    threadStatus.textContent = "选择网站和项目目录后显示历史登记状态。";
    return;
  }
  threadStatus.textContent = "正在检查历史聊天登记…";
  threadCheckTimer = setTimeout(async () => {
    try {
      const response = await fetch("/api/thread-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-File-Tool-Token": token },
        body: JSON.stringify({ siteId, root, role }),
      });
      const result = await response.json();
      if (seq !== threadCheckSeq) return;
      if (!response.ok) throw new Error(result.error || "无法检查历史登记");
      if (!result.registered) threadStatus.textContent = "未登记历史聊天，启动将新建；如需找回请先绑定旧聊天。";
      else if (result.valid) threadStatus.textContent = "已有历史聊天登记，启动将续接。";
      else {
        threadStatus.textContent = "已有历史登记，但地址无效；请重新绑定旧聊天。";
        threadStatus.classList.add("warn");
      }
    } catch (err) {
      if (seq !== threadCheckSeq) return;
      threadStatus.textContent = err.message || "无法检查历史登记";
      threadStatus.classList.add("warn");
    }
  }, 250);
}

function showError(message) {
  errorBox.textContent = message || "";
  errorBox.hidden = !message;
}

function render(status) {
  const names = {
    idle: "尚未启动", starting: "正在启动", running: "正在旁观",
    pausing: "等待当前动作完成", paused: "已暂停", recovery: "等待人工核对",
    stopping: "正在停止", error: "启动失败",
  };
  const phase = status.phase || "idle";
  document.querySelector("#state-text").textContent = names[phase] || "状态未知";
  document.querySelector("#state").className = `state ${phase}`;
  document.querySelector("#active-root").textContent = status.root || "—";
  document.querySelector("#active-role").textContent = status.role === "text" ? "文本目录问答" : "代码导师";
  document.querySelector("#active-browser").textContent = status.channel || "—";
  const health = status.health || { state: "unknown", reason: "暂时无法确认" };
  const healthNames = { healthy: "健康", stopped: "已停止", unknown: "状态不明" };
  const healthText = document.querySelector("#health-text");
  healthText.dataset.health = health.state;
  healthText.textContent = `${healthNames[health.state] || "状态不明"} · ${health.reason || "暂无详情"}`;
  const option = [...siteInput.options].find((item) => item.value === status.siteId);
  document.querySelector("#active-site").textContent = option?.textContent || "—";
  rootInput.disabled = siteInput.disabled = roleInput.disabled = !["idle", "error"].includes(phase);
  threadUrlInput.disabled = !["idle", "error"].includes(phase);
  buttons.start.disabled = working || !["idle", "error"].includes(phase);
  buttons["bind-thread"].disabled = working || !["idle", "error"].includes(phase);
  buttons.pause.disabled = working || phase !== "running";
  buttons.resume.disabled = working || phase !== "paused";
  buttons["confirm-recovery"].hidden = phase !== "recovery";
  buttons["confirm-recovery"].disabled = working || phase !== "recovery";
  buttons.stop.disabled = working || ["idle", "stopping"].includes(phase);
  if (status.error) showError(status.error);
  if (phase !== lastPhase) {
    lastPhase = phase;
    if (["idle", "running", "error"].includes(phase)) queueThreadCheck();
  }

  const events = document.querySelector("#events");
  events.replaceChildren();
  if (!status.events?.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "启动后，这里会显示动作、回填和诊断信息。";
    events.append(empty);
    return;
  }
  for (const event of [...status.events].reverse()) {
    const row = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false });
    const body = document.createElement("span");
    body.textContent = event.text;
    row.append(time, body);
    events.append(row);
  }
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("控制台连接中断");
    render(await response.json());
  } catch (err) {
    showError(err.message || "无法读取状态");
  }
}

async function action(route, body = {}) {
  if (working) return;
  working = true;
  for (const button of Object.values(buttons)) button.disabled = true;
  showError("");
  try {
    const response = await fetch(`/api/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-File-Tool-Token": token },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "操作失败");
    render(result);
    queueThreadCheck();
    return true;
  } catch (err) {
    showError(err.message || "操作失败");
    return false;
  } finally {
    working = false;
    await refresh();
  }
}

buttons.start.addEventListener("click", () => action("start", { root: rootInput.value, siteId: siteInput.value, role: roleInput.value }));
buttons.pause.addEventListener("click", () => action("pause"));
buttons.resume.addEventListener("click", () => action("resume"));
buttons["confirm-recovery"].addEventListener("click", () => action("confirm-recovery"));
buttons.stop.addEventListener("click", () => action("stop"));
buttons["bind-thread"].addEventListener("click", async () => {
  const bound = await action("bind-thread", {
    root: rootInput.value, siteId: siteInput.value, role: roleInput.value, url: threadUrlInput.value,
  });
  if (bound) threadUrlInput.value = "";
});
rootInput.addEventListener("input", queueThreadCheck);
siteInput.addEventListener("change", queueThreadCheck);
roleInput.addEventListener("change", queueThreadCheck);

try {
  const response = await fetch("/api/bootstrap", { cache: "no-store" });
  if (!response.ok) throw new Error("控制台初始化失败");
  const bootstrap = await response.json();
  token = bootstrap.token;
  rootInput.value = bootstrap.root;
  for (const site of bootstrap.sites) {
    const option = document.createElement("option");
    option.value = site.id;
    option.textContent = site.label;
    siteInput.append(option);
  }
  for (const role of bootstrap.roles) {
    const option = document.createElement("option");
    option.value = role.id;
    option.textContent = role.label;
    roleInput.append(option);
  }
  if (bootstrap.siteId) siteInput.value = bootstrap.siteId; // 记住上次选择的站点
  if (bootstrap.role) roleInput.value = bootstrap.role;
  queueThreadCheck();
  await refresh();
  setInterval(refresh, 1200);
} catch (err) {
  showError(err.message || "控制台初始化失败");
}

// ── 目录浏览：服务端列目录（浏览器拿不到绝对路径），对话框内导航选择 ──
const browseBtn = document.querySelector("#browse");
const dialog = document.querySelector("#browse-dialog");
const browsePathEl = document.querySelector("#browse-path");
const browseList = document.querySelector("#browse-list");
const browseError = document.querySelector("#browse-error");
const browseUp = document.querySelector("#browse-up");
const browsePick = document.querySelector("#browse-pick");
let browseCurrent = "";

async function loadBrowse(pathArg) {
  browseError.hidden = true;
  const qs = pathArg ? `?path=${encodeURIComponent(pathArg)}` : "";
  const data = await fetch(`/api/browse${qs}`, {
    headers: { "x-file-tool-token": token },
    cache: "no-store",
  }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  if (data.error) {
    browseError.textContent = data.error;
    browseError.hidden = false;
    return;
  }
  browseCurrent = data.current || "";
  browsePathEl.textContent = browseCurrent || "此电脑（请选择磁盘）";
  browseUp.disabled = data.parent == null;
  browseUp.dataset.parent = data.parent ?? "";
  browseList.replaceChildren();
  if (!data.entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "此目录下没有子文件夹";
    browseList.append(li);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const entry of data.entries) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = entry.name;
    btn.addEventListener("click", () => loadBrowse(entry.path));
    li.append(btn);
    frag.append(li);
  }
  browseList.append(frag);
}

browseBtn.addEventListener("click", () => {
  dialog.showModal();
  loadBrowse(rootInput.value.trim());
});
browseUp.addEventListener("click", () => {
  if (browseUp.dataset.parent) loadBrowse(browseUp.dataset.parent);
  else loadBrowse("");
});
document.querySelector("#browse-refresh").addEventListener("click", () => loadBrowse(browseCurrent));
document.querySelector("#browse-cancel").addEventListener("click", () => dialog.close());
browsePick.addEventListener("click", () => {
  if (browseCurrent) {
    rootInput.value = browseCurrent;
    queueThreadCheck();
  }
  dialog.close();
});
