// ====== 設定 ======
const CDP_VERSION = "1.3";

// タブごとの状態管理
// stateByTabId[tabId] = {
//   attached: boolean,      // デバッガーがアタッチされているか
//   latest: LogItem|null,   // 最新のログアイテム
//   session: {tabId},       // CDPセッション情報
//   errorCount: number      // エラーの累積カウント
// }
const stateByTabId = new Map();

// ====== ユーティリティ関数 ======
function ensureTabState(tabId) {
  if (!stateByTabId.has(tabId)) {
    stateByTabId.set(tabId, { 
      attached: false, latest: null, session: null, 
      errorCount: 0 
    });
  }
  return stateByTabId.get(tabId);
}

function setLatest(tabId, log) {
  const st = ensureTabState(tabId);
  st.latest = { ...log, ts: Date.now() };
  
  // エラーレベルかつシステムメッセージ以外の場合のみカウントを増やす
  if (log.level === "error" && log.source !== "system") {
    st.errorCount++;
  }
  
  // バッジ更新
  const badgeText = st.errorCount > 0 ? String(st.errorCount) : "";
  chrome.action.setBadgeText({ tabId, text: badgeText });
  chrome.action.setBadgeBackgroundColor({ 
    tabId, 
    color: st.errorCount > 0 ? "#d00" : "#00000000" 
  });
}

function clearLatest(tabId) {
  const st = ensureTabState(tabId);
  st.latest = null;
  st.errorCount = 0;
  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

// ====== デバッガー操作 ======
async function attachToTab(tabId) {
  const st = ensureTabState(tabId);
  if (st.attached) return { ok: true };

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, CDP_VERSION);
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Console.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    await chrome.debugger.sendCommand(target, "Network.enable");
    
    st.attached = true;
    st.session = target;
    st.latest = { level: "info", source: "system", text: "デバッグを開始しました。", ts: Date.now() };
    return { ok: true };
  } catch (e) {
    const msg = chrome.runtime.lastError?.message || e?.message || String(e);
    setLatest(tabId, { level: "error", source: "system", text: `Attach failed: ${msg}` });
    return { ok: false, error: msg };
  }
}

async function detachFromTab(tabId) {
  const st = ensureTabState(tabId);
  if (!st.attached || !st.session) return { ok: true };
  
  try {
    await chrome.debugger.detach(st.session);
    st.attached = false;
    st.session = null;
    
    // バッジを即座にクリア
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
    
    st.latest = { level: "info", source: "system", text: "デバッグを停止しました。", ts: Date.now() };
    return { ok: true };
  } catch (e) {
    const msg = chrome.runtime.lastError?.message || e?.message || String(e);
    setLatest(tabId, { level: "error", source: "system", text: `デバッグ停止に失敗: ${msg}` });
    return { ok: false, error: msg };
  }
}

// ====== CDP イベント処理 ======
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  switch (method) {
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

// ====== イベントリスナー ======
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId) return;
  const st = ensureTabState(tabId);
  st.attached = false;
  st.session = null;
  setLatest(tabId, { level: "warning", source: "system", text: `Debugger detached: ${reason}` });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const st = stateByTabId.get(tabId);
  if (st?.attached && st.session) {
    chrome.debugger.detach(st.session).catch(() => {});
  }
  stateByTabId.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const st = ensureTabState(tabId);
    st.errorCount = 0;
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
    st.latest = { level: "info", source: "system", text: "ページ読み込み中...", ts: Date.now() };
  }
});

// ====== メッセージ通信 ======
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    const tabId = await getActiveTabId();
    if (!tabId) return sendResponse({ ok: false, error: "No active tab." });

    switch (msg.type) {
      case "GET_STATE_FOR_ACTIVE_TAB": {
        const st = ensureTabState(tabId);
        sendResponse({
          tabId,
          attached: !!st?.attached,
          latest: st?.latest || null
        });
        break;
      }
      case "ATTACH_ACTIVE_TAB": {
        const res = await attachToTab(tabId);
        sendResponse(res);
        break;
      }
      case "DETACH_ACTIVE_TAB": {
        const res = await detachFromTab(tabId);
        sendResponse(res);
        break;
      }
      case "CLEAR_LATEST_ACTIVE_TAB": {
        clearLatest(tabId);
        sendResponse({ ok: true });
        break;
      }
      case "RESET_ERROR_COUNT_ACTIVE_TAB": {
        const st = ensureTabState(tabId);
        st.errorCount = 0;
        chrome.action.setBadgeText({ tabId, text: "" });
        chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
        sendResponse({ ok: true });
        break;
      }
    }
  })();
  return true;
});
