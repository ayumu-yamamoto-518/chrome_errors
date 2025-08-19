// 現在の状態を保持
let currentState = { tabId: null, attached: false, latest: null };

// ====== ユーティリティ関数 ======

/**
 * タイムスタンプをローカル時間形式に変換
 * @param {number} ts - タイムスタンプ
 * @returns {string} フォーマットされた日時文字列
 */
function fmtTs(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

/**
 * ログレベルのピル（バッジ）を生成
 * @param {string} level - ログレベル
 * @returns {string} HTML文字列
 */
function pill(level) {
  const lv = (level || "info").toLowerCase();
  return `<span class="pill ${lv}">${lv}</span>`;
}

/**
 * HTMLエスケープ処理
 * @param {string} s - エスケープ対象の文字列
 * @returns {string} エスケープ済み文字列
 */
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * UIを状態に応じて更新
 * @param {Object} state - 現在の状態 {tabId, attached, latest}
 */
function render(state) {
  currentState = state || { tabId: null, attached: false, latest: null };
  const latestEl = document.getElementById("latest");
  const status = document.getElementById("status");

  // タブが存在しない場合
  if (!state || state.tabId == null) {
    status.textContent = "タブなし";
    latestEl.innerHTML = "";
    return;
  }
  
  // デバッグ状態を表示
  status.textContent = state.attached ? "デバッグ中" : "停止中";

  const log = state.latest;
  // ログが存在しない場合
  if (!log) {
    latestEl.innerHTML = '<div class="empty">まだエラーはありません</div>';
    return;
  }

  // メタ情報を構築（URL、行番号、タイムスタンプ）
  const src = log.source || "";
  const meta = [log.url, log.line != null ? `L${log.line}` : "", fmtTs(log.ts)]
    .filter(Boolean).join(" | ");

  // ログ表示用HTMLを生成
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

// ====== 通信・更新関数 ======

/**
 * background scriptにメッセージを送信
 * @param {string} type - メッセージタイプ
 * @returns {Promise<Object>} レスポンス
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
  const res = await send("GET_STATE_FOR_ACTIVE_TAB");
  render(res);
}

// ====== イベントリスナー ======

// デバッグスタートボタン
document.getElementById("attach").addEventListener("click", async () => {
  // 即座にUIを更新（レスポンスを待たない）
  render({ tabId: currentState.tabId, attached: true, latest: { level: "info", source: "system", text: "デバッグを開始しました。", ts: Date.now() } });
  
  // バックグラウンドでアタッチ処理を実行
  const res = await send("ATTACH_ACTIVE_TAB");
  if (!res?.ok) {
    alert(res?.error || "デバッグ開始に失敗しました。\n※DevToolsが既に開いている場合、デバッグを開始できません。");
    // 失敗時は元の状態に戻す
    await refresh();
  } else {
    // 成功時は最終的な状態を取得
    await refresh();
  }
});

// デバッグ停止ボタン
document.getElementById("detach").addEventListener("click", async () => {
  // 即座にUIを更新（レスポンスを待たない）
  render({ tabId: currentState.tabId, attached: false, latest: { level: "info", source: "system", text: "デバッグを停止しました。", ts: Date.now() } });
  
  // バックグラウンドでデタッチ処理を実行
  await send("DETACH_ACTIVE_TAB");
  
  // 最終的な状態を取得
  await refresh();
});

// ====== エラーコピー・挿入機能 ======

/**
 * ログをテキスト形式にフォーマット
 * @param {Object} log - ログオブジェクト
 * @returns {string} フォーマットされたテキスト
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
 * @param {string} text - コピーするテキスト
 */
async function copyText(text) {
  try {
    // モダンなAPIを使用
    await navigator.clipboard.writeText(text);
    alert("コピーしました");
  } catch {
    // フォールバック（古いブラウザ対応）
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    alert("コピーしました");
  }
}

// ====== ボタンイベント ======

// 最新エラーをコピー
document.getElementById("copyLatest").addEventListener("click", async () => {
  const log = currentState.latest;
  if (!log) return alert("エラーがありません");
  await copyText(formatLog(log));
});

// プロンプトエリアの参照
const promptArea = document.getElementById("promptArea");

/**
 * テキストエリアにテキストを追加
 * @param {string} text - 追加するテキスト
 */
function appendToEditor(text) {
  const cur = promptArea.value || "";
  promptArea.value = cur + (cur.endsWith("\n") ? "" : "\n") + text + "\n";
}

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

// ====== 初期化 ======
refresh();
