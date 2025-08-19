// ====== 設定 ======
const CDP_VERSION = "1.3"; // Chrome DevTools Protocol のバージョン（安定版）

// タブごとの状態管理
// stateByTabId[tabId] = {
//   attached: boolean,      // デバッガーがアタッチされているか
//   latest: LogItem|null,   // 最新のログアイテム
//   session: {tabId},       // CDPセッション情報
//   errorCount: number,     // エラーの累積カウント
//   lastErrorText: string   // 最後に処理したエラーテキスト（重複検出用）
// }
const stateByTabId = new Map();

// ====== ユーティリティ関数 ======

/**
 * タブの状態を確保する（存在しない場合は初期化）
 * @param {number} tabId - タブID
 * @returns {Object} タブの状態オブジェクト
 */
function ensureTabState(tabId) {
  if (!stateByTabId.has(tabId)) {
    // 新しいタブの場合は初期状態を作成
    stateByTabId.set(tabId, { 
      attached: false,    // デバッガー未アタッチ
      latest: null,       // 最新ログなし
      session: null,      // セッションなし
      errorCount: 0,      // エラーカウント0
      lastErrorText: ""   // 最後のエラーテキスト（空）
    });
  }
  return stateByTabId.get(tabId);
}

/**
 * 最新のログを設定し、エラーカウントとバッジを更新
 * @param {number} tabId - タブID
 * @param {Object} log - ログオブジェクト {level, source, text, url, line, column}
 */
function setLatest(tabId, log) {
  const st = ensureTabState(tabId);
  
  // 最新ログを更新（タイムスタンプ付き）
  st.latest = { ...log, ts: Date.now() };
  
  // エラーレベルの場合のみカウントを増やす（重複チェック付き）
  if (log.level === "error") {
    // エラーテキストを正規化（余分な情報を除去）
    let normalizedText = log.text;
    
    // "Global error: "プレフィックスを除去
    if (normalizedText.startsWith("Global error: ")) {
      normalizedText = normalizedText.substring("Global error: ".length);
    }
    
    // スタックトレース部分を除去（最初の行のみ使用）
    const firstLine = normalizedText.split('\n')[0];
    const errorText = firstLine.substring(0, 100); // 最初の100文字で比較
    
    console.log(`[DEBUG] Original: "${log.text.substring(0, 50)}..."`);
    console.log(`[DEBUG] Normalized: "${errorText}"`);
    
    // 同じエラーテキストが短時間で重複してきた場合はスキップ
    if (st.lastErrorText === errorText) {
      console.log(`[DEBUG] Duplicate error skipped: ${errorText.substring(0, 50)}...`);
      // 重複でもログは更新する（returnしない）
    } else {
      st.errorCount++;
      st.lastErrorText = errorText;
      console.log(`[DEBUG] Error count increased: ${st.errorCount}, Source: ${log.source}, Text: ${errorText.substring(0, 50)}...`);
    }
  }
  
  // 拡張機能アイコンのバッジを更新
  const badgeText = st.errorCount > 0 ? String(st.errorCount) : "";
  chrome.action.setBadgeText({ tabId, text: badgeText });
  
  // バッジの色を設定（エラーあり：赤、エラーなし：透明）
  const badgeColor = st.errorCount > 0 ? "#d00" : "#00000000";
  chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor });
}

/**
 * 最新ログとエラーカウントをクリア
 * @param {number} tabId - タブID
 */
function clearLatest(tabId) {
  const st = ensureTabState(tabId);
  
  // 最新ログとエラーカウントをリセット
  st.latest = null;
  st.errorCount = 0;
  st.lastErrorText = ""; // 重複検出用のテキストもリセット
  
  // バッジを非表示にする
  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
}

/**
 * 現在アクティブなタブのIDを取得
 * @returns {Promise<number|null>} アクティブタブのID、取得できない場合はnull
 */
async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

// ====== デバッガーのアタッチ/デタッチ ======

/**
 * 指定されたタブにChrome DevTools Protocolデバッガーをアタッチ
 * @param {number} tabId - アタッチ対象のタブID
 * @returns {Promise<Object>} アタッチ結果 {ok: boolean, error?: string}
 */
async function attachToTab(tabId) {
  const st = ensureTabState(tabId);
  
  // 既にアタッチ済みの場合は何もしない
  if (st.attached) return { ok: true };

  const target = { tabId };
  try {
    // CDPデバッガーをアタッチ
    await chrome.debugger.attach(target, CDP_VERSION);
    
    // 必要なCDPドメインを有効化
    await chrome.debugger.sendCommand(target, "Runtime.enable");    // JavaScript実行エラー
    await chrome.debugger.sendCommand(target, "Console.enable");    // console.log等
    await chrome.debugger.sendCommand(target, "Log.enable");        // ブラウザログ
    await chrome.debugger.sendCommand(target, "Network.enable");    // ネットワークエラー
    
    // 状態を更新
    st.attached = true;
    st.session = target;

    // 成功ログを記録（エラーカウントは増やさない）
    const state = ensureTabState(tabId);
    state.latest = { 
      level: "info", 
      source: "system", 
      text: "デバッグを開始しました。", 
      ts: Date.now() 
    };
    return { ok: true };
  } catch (e) {
    // エラーが発生した場合
    const msg = chrome.runtime.lastError?.message || e?.message || String(e);
    setLatest(tabId, { level: "error", source: "system", text: `Attach failed: ${msg}` });
    return { ok: false, error: msg };
  }
}

/**
 * 指定されたタブからChrome DevTools Protocolデバッガーをデタッチ
 * @param {number} tabId - デタッチ対象のタブID
 * @returns {Promise<Object>} デタッチ結果 {ok: boolean, error?: string}
 */
async function detachFromTab(tabId) {
  const st = ensureTabState(tabId);
  
  // アタッチされていない場合は何もしない
  if (!st.attached || !st.session) return { ok: true };
  
  try {
    // CDPデバッガーをデタッチ
    await chrome.debugger.detach(st.session);
    
    // 状態を更新
    st.attached = false;
    st.session = null;
    
    // 成功ログを記録（エラーカウントは増やさない）
    const state = ensureTabState(tabId);
    state.latest = { 
      level: "info", 
      source: "system", 
      text: "デバッグを停止しました。", 
      ts: Date.now() 
    };
    return { ok: true };
  } catch (e) {
    // エラーが発生した場合
    const msg = chrome.runtime.lastError?.message || e?.message || String(e);
    setLatest(tabId, { level: "error", source: "system", text: `デバッグ停止に失敗: ${msg}` });
    return { ok: false, error: msg };
  }
}

// ====== Chrome DevTools Protocol イベント購読 ======

/**
 * CDPイベントリスナー：ブラウザから発生する各種イベントを監視
 * @param {Object} source - イベント発生源 {tabId: number}
 * @param {string} method - イベントメソッド名
 * @param {Object} params - イベントパラメータ
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return; // タブIDがない場合は無視

  console.log(`[DEBUG] CDP Event: ${method}, TabId: ${tabId}`);

  switch (method) {
    case "Runtime.exceptionThrown": {
      // JavaScript実行時の例外をキャッチ
      console.log(`[DEBUG] Processing Runtime.exceptionThrown`);
      const d = params?.exceptionDetails || {};
      const text =
        d?.exception?.description ||
        d?.text ||
        (d?.exception && (d.exception.value || d.exception.className)) ||
        "Exception thrown";
      console.log(`[DEBUG] Exception text: ${String(text)}`);
      setLatest(tabId, {
        level: "error",
        source: "exception",
        text: String(text),
        url: d.url || d?.scriptId || "",
        line: d.lineNumber,
        column: d.columnNumber
      });
      break;
    }
    
    case "Runtime.consoleAPICalled": {
      // console.log, console.error, console.warn等の呼び出しをキャッチ
      const type = params?.type || "log";
      const level = type === "error" ? "error" : (type === "warning" ? "warning" : "info");
      console.log(`[DEBUG] Processing Runtime.consoleAPICalled, type: ${type}, level: ${level}`);
      const args = (params?.args || []).map(a => a?.value ?? a?.description ?? a?.type);
      const text = args.join(" ");
      console.log(`[DEBUG] Console text: ${text}`);
      setLatest(tabId, {
        level,
        source: "console",
        text: text,
        url: "",
        line: undefined,
        column: undefined
      });
      break;
    }
    
    case "Log.entryAdded": {
      // ブラウザの内部ログをキャッチ
      const e = params?.entry || {};
      setLatest(tabId, {
        level: e.level || "info",
        source: e.source || "log",
        text: e.text || "",
        url: e.url || "",
        line: e.lineNumber,
        column: undefined
      });
      break;
    }
    
    case "Network.loadingFailed": {
      // ネットワークリクエストの失敗をキャッチ
      const e = params || {};
      if (e?.type === "XHR" || e?.type === "Fetch" || e?.blockedReason || e?.errorText) {
        setLatest(tabId, {
          level: "error",
          source: "network",
          text: `Network ${e.type || ""} failed: ${e.errorText || e.blockedReason || "unknown"}`,
          url: "",
          line: undefined,
          column: undefined
        });
      }
      break;
    }
    
    default:
      // その他のイベントは無視
      break;
  }
});

// ====== デバッガーの状態変化イベント ======

/**
 * デバッガーが外れたときのイベントリスナー
 * @param {Object} source - イベント発生源 {tabId: number}
 * @param {string} reason - デタッチ理由
 */
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId) return;
  
  // 状態を更新
  const st = ensureTabState(tabId);
  st.attached = false;
  st.session = null;
  
  // デタッチ通知を記録
  setLatest(tabId, { level: "warning", source: "system", text: `Debugger detached: ${reason}` });
});

// ====== タブのライフサイクルイベント ======

/**
 * タブが閉じられたときのイベントリスナー
 * @param {number} tabId - 閉じられたタブのID
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  const st = stateByTabId.get(tabId);
  
  // デバッガーがアタッチされている場合はデタッチ
  if (st?.attached && st.session) {
    chrome.debugger.detach(st.session).catch(() => {});
  }
  
  // タブの状態を削除
  stateByTabId.delete(tabId);
});

/**
 * タブの更新イベントリスナー
 * @param {number} tabId - 更新されたタブのID
 * @param {Object} changeInfo - 変更情報
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // ページ読み込み開始時にエラーカウントをリセット
    const st = ensureTabState(tabId);
    st.errorCount = 0;
    
    // バッジをクリア
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
    
    // 読み込み開始通知を記録（エラーカウントは増やさない）
    const state = ensureTabState(tabId);
    state.latest = { 
      level: "info", 
      source: "system", 
      text: "ページ読み込み中...", 
      ts: Date.now() 
    };
  }
});

// ====== ポップアップとのメッセージ通信 ======

/**
 * ポップアップからのメッセージを処理するリスナー
 * @param {Object} msg - メッセージオブジェクト
 * @param {Object} _sender - 送信者情報
 * @param {Function} sendResponse - レスポンス送信関数
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    // アクティブタブの状態を取得
    if (msg.type === "GET_STATE_FOR_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      const st = tabId ? ensureTabState(tabId) : null;
      sendResponse({
        tabId,
        attached: !!st?.attached,
        latest: st?.latest || null
      });
    }

    // アクティブタブにデバッガーをアタッチ
    if (msg.type === "ATTACH_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      const res = await attachToTab(tabId);
      sendResponse(res);
    }

    // アクティブタブからデバッガーをデタッチ
    if (msg.type === "DETACH_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      const res = await detachFromTab(tabId);
      sendResponse(res);
    }

    // アクティブタブの最新ログをクリア
    if (msg.type === "CLEAR_LATEST_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      clearLatest(tabId);
      sendResponse({ ok: true });
    }

    // アクティブタブのエラーカウントをリセット
    if (msg.type === "RESET_ERROR_COUNT_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      const st = ensureTabState(tabId);
      st.errorCount = 0;
      chrome.action.setBadgeText({ tabId, text: "" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
      sendResponse({ ok: true });
    }
  })();
  return true; // 非同期処理のためtrueを返す
});
