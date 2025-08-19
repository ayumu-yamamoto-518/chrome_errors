let currentState = { tabId: null, attached: false, latest: null };

function fmtTs(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}
function pill(level) {
  const lv = (level || "info").toLowerCase();
  return `<span class="pill ${lv}">${lv}</span>`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(state) {
  currentState = state || { tabId: null, attached: false, latest: null };
  const latestEl = document.getElementById("latest");
  const status = document.getElementById("status");

  if (!state || state.tabId == null) {
    status.textContent = "No active tab";
    latestEl.innerHTML = "";
    return;
  }
  status.textContent = state.attached ? "Attached" : "Detached";

  const log = state.latest;
  if (!log) {
    latestEl.innerHTML = '<div class="empty">まだエラーはありません</div>';
    return;
  }

  const src = log.source || "";
  const meta = [log.url, log.line != null ? `L${log.line}` : "", fmtTs(log.ts)]
    .filter(Boolean).join(" | ");

  latestEl.innerHTML = `
    <div class="log">
      <div class="head">
        ${pill(log.level)}
        <div>${escapeHtml(src)}</div>
        <div class="src">${escapeHtml(meta)}</div>
      </div>
      <div class="msg">${escapeHtml(log.text || "(no message)")}</div>
      ${log.stack ? `<details><summary>stack</summary><pre>${escapeHtml(String(log.stack))}</pre></details>` : ""}
    </div>
  `;
}

function send(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type }, (res) => resolve(res));
  });
}

async function refresh() {
  const res = await send("GET_STATE_FOR_ACTIVE_TAB");
  render(res);
}

document.getElementById("attach").addEventListener("click", async () => {
  const res = await send("ATTACH_ACTIVE_TAB");
  if (!res?.ok) alert(res?.error || "Attach failed.\n※DevToolsが既に開いている場合、アタッチできません。");
  await refresh();
});

document.getElementById("detach").addEventListener("click", async () => {
  await send("DETACH_ACTIVE_TAB");
  await refresh();
});

document.getElementById("clear").addEventListener("click", async () => {
  await send("CLEAR_LATEST_ACTIVE_TAB");
  await refresh();
});

// ====== 最新エラーのコピー/挿入 ======
function formatLog(log) {
  const head = `[${(log.level || "info").toUpperCase()}][${log.source || "log"}] ${log.text || "(no message)"}`;
  const meta = [log.url, log.line != null ? `L${log.line}` : "", log.ts ? new Date(log.ts).toISOString() : ""]
    .filter(Boolean).join(" | ");
  const metaLine = meta ? `\nmeta: ${meta}` : "";
  const stack = log.stack ? `\nstack: ${String(log.stack)}` : "";
  return `${head}${metaLine}${stack}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert("コピーしました");
  } catch {
    // フォールバック
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    alert("コピーしました");
  }
}

document.getElementById("copyLatest").addEventListener("click", async () => {
  const log = currentState.latest;
  if (!log) return alert("エラーがありません");
  await copyText(formatLog(log));
});

const promptArea = document.getElementById("promptArea");
function appendToEditor(text) {
  const cur = promptArea.value || "";
  promptArea.value = cur + (cur.endsWith("\n") ? "" : "\n") + text + "\n";
}

document.getElementById("insertLatest").addEventListener("click", () => {
  const log = currentState.latest;
  if (!log) return alert("挿入できるエラーがありません");
  appendToEditor(formatLog(log));
});

document.getElementById("copyPrompt").addEventListener("click", async () => {
  await copyText(promptArea.value);
});

// 初期化
refresh();
