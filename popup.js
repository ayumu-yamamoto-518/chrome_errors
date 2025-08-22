// ====== 状態管理 ======
let currentState = { tabId: null, attached: false, latest: null };

// ====== UI操作 ======

/**
 * タイムスタンプをローカル時間形式に変換
 */
function fmtTs(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

/**
 * ログレベルのピル（バッジ）を生成
 */
function pill(level) {
  const lv = (level || "info").toLowerCase();
  return `<span class="pill ${lv}">${lv}</span>`;
}

/**
 * HTMLエスケープ処理
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * UIを状態に応じて更新
 */
function render(state) {
  currentState = state || { tabId: null, attached: false, latest: null };
  const latestEl = document.getElementById("latest");
  const status = document.getElementById("status");

  if (!state || state.tabId == null) {
    status.textContent = "タブなし";
    latestEl.innerHTML = "";
    return;
  }
  
  status.textContent = state.attached ? "デバッグ中" : "停止中";

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

/**
 * ログをテキスト形式にフォーマット
 */
function formatLog(log) {
  const head = `[${(log.level || "info").toUpperCase()}][${log.source || "log"}] ${log.text || "(no message)"}`;
  const meta = [log.url, log.line != null ? `L${log.line}` : "", log.ts ? new Date(log.ts).toISOString() : ""]
    .filter(Boolean).join(" | ");
  const metaLine = meta ? `\nmeta: ${meta}` : "";
  const stack = log.stack ? `\nstack: ${String(log.stack)}` : "";
  return `${head}${metaLine}${stack}`;
}

/**
 * テキストをクリップボードにコピー
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    alert("コピーしました");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    alert("コピーしました");
  }
}

/**
 * テキストエリアにテキストを追加
 */
function appendToEditor(text) {
  const cur = promptArea.value || "";
  promptArea.value = cur + (cur.endsWith("\n") ? "" : "\n") + text + "\n";
}

// ====== 通信 ======

/**
 * background scriptにメッセージを送信
 */
function send(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type }, (res) => resolve(res));
  });
}

/**
 * 現在の状態を取得してUIを更新
 */
async function refresh() {
  const res = await send("GET_STATE_AND_AUTO_ATTACH");
  render(res);
}

// ====== イベント処理 ======

// 最新エラーをプロンプトエリアに挿入
document.getElementById("insertLatest").addEventListener("click", () => {
  const log = currentState.latest;
  if (!log) return alert("挿入できるエラーがありません");
  appendToEditor(formatLog(log));
});

// プロンプトエリアの内容をコピー
document.getElementById("copyPrompt").addEventListener("click", async () => {
  await copyText(promptArea.value);
});

// プロンプトエリアの参照
const promptArea = document.getElementById("promptArea");

// ====== 初期化 ======
refresh();
