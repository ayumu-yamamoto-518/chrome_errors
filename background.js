// ====== 設定 ======
const CDP_VERSION = "1.3"; // 安定版
// タブごとの状態
// stateByTabId[tabId] = { attached: boolean, latest: LogItem|null, session: {tabId} }
const stateByTabId = new Map();

// ====== ユーティリティ ======
function ensureTabState(tabId) {
  if (!stateByTabId.has(tabId)) {
    stateByTabId.set(tabId, { attached: false, latest: null, session: null });
  }
  return stateByTabId.get(tabId);
}

function setLatest(tabId, log) {
  const st = ensureTabState(tabId);
  st.latest = { ...log, ts: Date.now() };
  // バッジは 0/1 のみ
  chrome.action.setBadgeText({ tabId, text: "1" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#d00" });
}

function clearLatest(tabId) {
  const st = ensureTabState(tabId);
  st.latest = null;
  chrome.action.setBadgeText({ tabId, text: "" });
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

// ====== attach/detach ======
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

    setLatest(tabId, { level: "info", source: "system", text: "Attached to tab via CDP." });
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
    setLatest(tabId, { level: "info", source: "system", text: "Detached from tab." });
    return { ok: true };
  } catch (e) {
    const msg = chrome.runtime.lastError?.message || e?.message || String(e);
    setLatest(tabId, { level: "error", source: "system", text: `Detach failed: ${msg}` });
    return { ok: false, error: msg };
  }
}

// ====== CDP イベント購読 ======
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId) return;

  switch (method) {
    case "Runtime.exceptionThrown": {
      const d = params?.exceptionDetails || {};
      const text =
        d?.exception?.description ||
        d?.text ||
        (d?.exception && (d.exception.value || d.exception.className)) ||
        "Exception thrown";
      setLatest(tabId, {
        level: "error",
        source: "exception",
        text: String(text),
        url: d.url || d?.scriptId || "",
        line: d.lineNumber,
        column: d.columnNumber,
        stack: d?.stackTrace ? JSON.stringify(d.stackTrace) : null
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
    default:
      break;
  }
});

// デバッガが外れたとき
chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!tabId) return;
  const st = ensureTabState(tabId);
  st.attached = false;
  st.session = null;
  setLatest(tabId, { level: "warning", source: "system", text: `Debugger detached: ${reason}` });
});

// タブが閉じられたらデタッチ＆状態掃除
chrome.tabs.onRemoved.addListener((tabId) => {
  const st = stateByTabId.get(tabId);
  if (st?.attached && st.session) {
    chrome.debugger.detach(st.session).catch(() => {});
  }
  stateByTabId.delete(tabId);
});

// ナビゲーション開始時に軽く通知（最新のみ上書き）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    setLatest(tabId, { level: "info", source: "system", text: "Tab loading..." });
  }
});

// ====== popup とのメッセージ通信 ======
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    if (msg.type === "GET_STATE_FOR_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      const st = tabId ? ensureTabState(tabId) : null;
      sendResponse({
        tabId,
        attached: !!st?.attached,
        latest: st?.latest || null
      });
    }

    if (msg.type === "ATTACH_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      const res = await attachToTab(tabId);
      sendResponse(res);
    }

    if (msg.type === "DETACH_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      const res = await detachFromTab(tabId);
      sendResponse(res);
    }

    if (msg.type === "CLEAR_LATEST_ACTIVE_TAB") {
      const tabId = await getActiveTabId();
      if (!tabId) return sendResponse({ ok: false, error: "No active tab." });
      clearLatest(tabId);
      sendResponse({ ok: true });
    }
  })();
  return true; // async
});
