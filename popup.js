// ====== 状態管理 ======
/**
 * 現在のポップアップで表示しているタブの状態
 * 
 * @type {Object}
 * @property {number|null} tabId - 現在のタブID（nullの場合はタブなし）
 * @property {boolean} attached - デバッガーがアタッチされているか
 * @property {Object|null} newErrorInfo - 最新のエラー情報（nullの場合はエラーなし）
 */
let currentState = { tabId: null, attached: false, newErrorInfo: null };

// プロンプトエリアの参照
const promptArea = document.getElementById("promptArea");

// DOM要素の存在確認
if (!promptArea) {
  console.error('promptArea element not found');
}

// ====== UI操作 ======

/**
 * タイムスタンプをローカル時間形式に変換
 */
function formatTimestamp(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

/**
 * ログレベルのピル（バッジ）を生成
 */
function createLevelBadge(level) {
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
 * 
 * @param {Object} state - デバッグ状態
 * @param {number|null} state.tabId - タブID
 * @param {boolean} state.attached - デバッガーがアタッチされているか
 * @param {Object|null} state.newErrorInfo - 最新のエラー情報
 */
function render(state) {
  try {
    currentState = state || { tabId: null, attached: false, newErrorInfo: null };
    const newErrorInfoEl = document.getElementById("newErrorInfo");

    if (!newErrorInfoEl) {
      console.error('newErrorInfo element not found');
      return;
    }

    if (!state || state.tabId == null) {
      newErrorInfoEl.innerHTML = "";
      return;
    }

    const log = state.newErrorInfo;
    if (!log) {
      newErrorInfoEl.innerHTML = '<div class="empty">まだエラーはありません</div>';
      // promptAreaもクリア
      if (promptArea) {
        promptArea.value = "以下の、エラーを解析してほしい";
      }
      return;
    }

    const src = log.source || "";
    const meta = [log.url, log.line != null ? `L${log.line}` : "", formatTimestamp(log.ts)]
      .filter(Boolean).join(" | ");

    newErrorInfoEl.innerHTML = `
      <div class="log">
        <div class="head">
          ${createLevelBadge(log.level)}
          <div>${escapeHtml(src)}</div>
          <div class="src">${escapeHtml(meta)}</div>
        </div>
        <div class="msg">${escapeHtml(log.text || "(no message)")}</div>
        ${log.stack ? `<details><summary>stack</summary><pre>${escapeHtml(String(log.stack))}</pre></details>` : ""}
      </div>
    `;

    // promptAreaに最新エラーを自動反映
    if (promptArea) {
      promptArea.value = `以下の、エラーを解析してほしい\n\n${formatLog(log)}`;
    }
  } catch (error) {
    console.error('UIの更新に失敗しました:', error);
    // エラー時は空の状態を表示
    const newErrorInfoEl = document.getElementById("newErrorInfo");
    if (newErrorInfoEl) {
      newErrorInfoEl.innerHTML = '<div class="empty">エラーが発生しました</div>';
    }
  }
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
  if (!promptArea) {
    console.error('promptArea not found');
    return;
  }
  const cur = promptArea.value || "";
  promptArea.value = cur + (cur.endsWith("\n") ? "" : "\n") + text + "\n";
}

// ====== 通信 ======

/**
 * background scriptにメッセージを送信
 * 
 * @param {string} type - メッセージタイプ
 * @returns {Promise<Object>} レスポンス
 */
function send(type) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type }, (res) => resolve(res));
  });
}

/**
 * 現在のデバッグ状態を取得
 * 
 * @returns {Promise<Object>} デバッグ状態
 */
async function getDebugState() {
  return await send("GET_DEBUG_STATE");
}

/**
 * デバッガーをアタッチ
 * 
 * @returns {Promise<Object>} アタッチ結果
 */
async function attachDebugger() {
  return await send("ATTACH_DEBUGGER");
}

/**
 * デバッガーをデタッチ
 * 
 * @returns {Promise<Object>} デタッチ結果
 */
async function detachDebugger() {
  return await send("DETACH_DEBUGGER");
}

/**
 * デバッグモードを切り替え
 * 
 * @returns {Promise<Object>} 切り替え結果
 */
async function toggleDebugMode() {
  return await send("TOGGLE_DEBUG_MODE");
}

/**
 * ポップアップの状態を更新
 * 
 * 現在のデバッグ状態を取得し、UIを更新します。
 * 
 * @returns {Promise<void>}
 */
async function updatePopupState() {
  try {
    const state = await getDebugState();
    render(state);
  } catch (error) {
    console.error('状態の取得に失敗しました:', error);
    render({ tabId: null, attached: false, newErrorInfo: null });
  }
}

/**
 * デバッグモードを切り替え、ポップアップの状態を更新する
 * 
 * この関数は以下の処理を順次実行します：
 * 1. デバッグモードを切り替え
 * 2. 最新の状態を取得
 * 3. UIを更新
 * 
 * @returns {Promise<void>}
 * 
 * @example
 * // ポップアップが開かれた時に自動実行される
 * handleDebugModeToggle();
 * 
 * @example
 * // 手動でデバッグモードを切り替えたい場合
 * await handleDebugModeToggle();
 */
async function handleDebugModeToggle() {
  try {
    const result = await toggleDebugMode();
    console.log(result.message); // 切り替え結果をログ出力
    
    // 最新の状態を取得してUIを更新
    await updatePopupState();
  } catch (error) {
    console.error('デバッグモードの切り替えに失敗しました:', error);
    // エラー時は現在の状態を表示
    await updatePopupState();
  }
}

// ====== イベント処理 ======

// コピーアイコンのクリックイベント
const copyIcon = document.getElementById("copyIcon");
if (copyIcon) {
  copyIcon.addEventListener("click", async () => {
    if (promptArea) {
      await copyText(promptArea.value);
    }
  });
}

// ポップアップの表示/非表示に合わせてエラーカウントを制御
window.addEventListener('focus', async () => {
  console.log('=== ポップアップ表示 ===');
  // エラーカウントを表示
  await send("SHOW_ERROR_COUNT");
});

window.addEventListener('blur', async () => {
  console.log('=== ポップアップ非表示 ===');
  // エラーカウントを非表示
  await send("HIDE_ERROR_COUNT");
});

// ポップアップが閉じられる時
window.addEventListener('beforeunload', async () => {
  console.log('=== ポップアップ閉じる ===');
  // エラーカウントを非表示
  await send("HIDE_ERROR_COUNT");
});

// ====== 初期化 ======
handleDebugModeToggle();
