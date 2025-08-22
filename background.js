// ====== 設定 ======
const CDP_VERSION = "1.3";

// ====== 状態管理 ======
const stateByTabId = new Map();

/**
 * タブの状態を取得または初期化
 * @param {number} tabId - タブID
 * @returns {Object} タブの状態オブジェクト
 */
function ensureTabState(tabId) {
  if (!stateByTabId.has(tabId)) {
    stateByTabId.set(tabId, { attached: false, latest: null, session: null, errorCount: 0 });
  }
  return stateByTabId.get(tabId);
}

/**
 * 最新のエラー情報を設定し、エラーカウントとバッジを更新
 * @param {number} tabId - タブID
 * @param {Object} log - ログ情報（level, source, text, url, line, column）
 */
function setLatest(tabId, log) {
  const st = ensureTabState(tabId);
  st.latest = { ...log, ts: Date.now() };
  
  // エラーレベルかつシステムメッセージ以外の場合のみカウントを増やす
  if (log.level === "error" && log.source !== "system") {
    st.errorCount++;
  }
  
  // バッジの表示を更新
  const badgeText = st.errorCount > 0 ? String(st.errorCount) : "";
  chrome.action.setBadgeText({ tabId, text: badgeText });
  chrome.action.setBadgeBackgroundColor({ tabId, color: st.errorCount > 0 ? "#d00" : "#00000000" });
}

/**
 * 現在アクティブなタブのIDを取得
 * @returns {Promise<number|null>} アクティブタブのID
 */
async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

// ====== デバッグ操作 ======

/**
 * 指定されたタブにデバッガーをアタッチ
 * @param {number} tabId - タブID
 * @returns {Promise<Object>} 結果オブジェクト
 */
async function attachToTab(tabId) {
  const st = ensureTabState(tabId);
  if (st.attached) return { ok: true };

  try {
    const target = { tabId };
    // CDPデバッガーをアタッチ
    await chrome.debugger.attach(target, CDP_VERSION);
    // 各種イベントの監視を有効化
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Console.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    await chrome.debugger.sendCommand(target, "Network.enable");
    
    st.attached = true;
    st.session = target;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: chrome.runtime.lastError?.message || e?.message || String(e) };
  }
}

/**
 * 指定されたタブからデバッガーをデタッチ
 * @param {number} tabId - タブID
 * @returns {Promise<Object>} 結果オブジェクト
 */
async function detachFromTab(tabId) {
  const st = ensureTabState(tabId);
  if (!st.attached || !st.session) return { ok: true };
  
  try {
    await chrome.debugger.detach(st.session);
    st.attached = false;
    st.session = null;
    // バッジをクリア
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: chrome.runtime.lastError?.message || e?.message || String(e) };
  }
}

// ====== イベント処理 ======

/**
 * Chrome DevTools Protocol のイベントを処理
 * JavaScript例外、コンソール出力、ログ、ネットワークエラーを監視
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  switch (method) {
    // JavaScript例外が発生した場合
    case "Runtime.exceptionThrown": {
      const d = params?.exceptionDetails || {};
      const text = d?.exception?.description || d?.text || 
                   (d?.exception && (d.exception.value || d.exception.className)) || "Exception thrown";
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
    
    // コンソールAPIが呼ばれた場合（console.error, console.warn等）
    case "Runtime.consoleAPICalled": {
      const type = params?.type || "log";
      const level = type === "error" ? "error" : (type === "warning" ? "warning" : "info");
      const args = (params?.args || []).map(a => a?.value ?? a?.description ?? a?.type);
      setLatest(tabId, {
        level,
        source: "console",
        text: args.join(" "),
        url: "",
        line: undefined,
        column: undefined
      });
      break;
    }
    
    // ログエントリが追加された場合
    case "Log.entryAdded": {
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
    
    // ネットワークリクエストが失敗した場合
    case "Network.loadingFailed": {
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
  }
});

/**
 * デバッガーがデタッチされた時の処理
 */
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId) return;
  const st = ensureTabState(tabId);
  st.attached = false;
  st.session = null;
});

/**
 * タブが削除された時の処理
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  const st = stateByTabId.get(tabId);
  if (st?.attached && st.session) {
    chrome.debugger.detach(st.session).catch(() => {});
  }
  stateByTabId.delete(tabId);
});

/**
 * タブが更新された時の処理（ページ読み込み時にエラーカウントをリセット）
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const st = ensureTabState(tabId);
    st.errorCount = 0;
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
  }
});

// ====== メッセージ通信 ======

/**
 * ポップアップからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    const tabId = await getActiveTabId();
    if (!tabId) return sendResponse({ ok: false, error: "No active tab." });

    switch (msg.type) {
      // 現在のタブの状態を取得
    //   case "GET_STATE_FOR_ACTIVE_TAB": {
    //     const st = ensureTabState(tabId);
    //     sendResponse({
    //       tabId,
    //       attached: !!st?.attached,
    //       latest: st?.latest || null
    //     });
    //     break;
    //   }
      // 状態を取得し、必要に応じてデバッグを自動開始
      case "GET_STATE_AND_AUTO_ATTACH": {
        const st = ensureTabState(tabId);
        if (!st.attached) {
          const attachRes = await attachToTab(tabId);
          if (attachRes.ok) {
            // 再取得
            const updatedSt = ensureTabState(tabId);
            sendResponse({
              tabId,
              attached: !!updatedSt?.attached,
              latest: updatedSt?.latest || null,
              autoAttached: true
            });
            break;
          }
        }
        sendResponse({
          tabId,
          attached: !!st?.attached,
          latest: st?.latest || null,
          autoAttached: false
        });
        break;
      }
    }
  })();
  return true;
});
