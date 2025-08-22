// ====== 設定 ======
const CDP_VERSION = "1.3";

// ====== 状態管理 ======
const stateByTabId = new Map();

/**
 * 状態をChromeストレージに保存
 */
async function chromeSaveState() {
  const stateToSave = {};
  stateByTabId.forEach((state, tabId) => {
    // セッション情報は保存しない（再起動時に無効になるため）
    const { session, ...saveableState } = state;
    stateToSave[tabId] = saveableState;
  });
  
  await chrome.storage.local.set({ 
    debuggerState: stateToSave,
    lastSaved: Date.now()
  });
}

/**
 * 状態をChromeストレージから復元
 */
async function chromeLoadState() {
  try {
    const result = await chrome.storage.local.get(['debuggerState']);
    const savedState = result.debuggerState || {};
    
    // 保存された状態を復元（attachedはfalseにリセット）
    Object.entries(savedState).forEach(([tabId, state]) => {
      stateByTabId.set(Number(tabId), {
        ...state,
        attached: false, // 再起動時はデタッチ状態
        session: null
      });
    });
    
    console.log(`状態を復元しました: ${Object.keys(savedState).length}個のタブ`);
  } catch (error) {
    console.error('状態の復元に失敗しました:', error);
  }
}

/**
 * タブの状態を取得する。存在しない場合は初期状態を作成する
 * 
 * @param {number} tabId - 対象のタブID
 * タブの状態を取得する。存在しない場合は初期状態を作成する
 * 
 * @param {number} tabId - 対象のタブID
 * @returns {Object} タブの状態オブジェクト
 *   - attached: boolean - デバッガーがアタッチされているか
 *   - latest: Object|null - 最新のエラー情報
 *   - session: Object|null - CDPデバッガーセッション
 *   - errorCount: number - エラーの累計数
 * 
 * @example
 * // 初回アクセス時：初期状態を作成して返す
 * const state = ensureTabState(123);
 * // → { attached: false, latest: null, session: null, errorCount: 0 }
 * 
 * // 2回目以降：既存の状態を返す
 * const state = ensureTabState(123);
 * // → 既存の状態オブジェクト
 *   - attached: boolean - デバッガーがアタッチされているか
 *   - latest: Object|null - 最新のエラー情報
 *   - session: Object|null - CDPデバッガーセッション
 *   - errorCount: number - エラーの累計数
 * 
 * @example
 * // 初回アクセス時：初期状態を作成して返す
 * const state = ensureTabState(123);
 * // → { attached: false, latest: null, session: null, errorCount: 0 }
 * 
 * // 2回目以降：既存の状態を返す
 * const state = ensureTabState(123);
 * // → 既存の状態オブジェクト
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
  const tabState = ensureTabState(tabId);
  tabState.latest = { ...log, ts: Date.now() };
  
  // エラーレベルかつシステムメッセージ以外の場合のみカウントを増やす
  if (log.level === "error" && log.source !== "system") {
    tabState.errorCount++;
  }
  
  // バッジの表示を更新
  const badgeText = tabState.errorCount > 0 ? String(tabState.errorCount) : "";
  chrome.action.setBadgeText({ tabId, text: badgeText });
  chrome.action.setBadgeBackgroundColor({ tabId, color: tabState.errorCount > 0 ? "#d00" : "#00000000" });
  
  // Chromeストレージに状態を保存
  chromeSaveState();
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
  const tabState = ensureTabState(tabId);
  if (tabState.attached) return { ok: true };

  try {
    const target = { tabId };
    // CDPデバッガーをアタッチ
    await chrome.debugger.attach(target, CDP_VERSION);
    // 各種イベントの監視を有効化
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Console.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    await chrome.debugger.sendCommand(target, "Network.enable");
    
    tabState.attached = true;
    tabState.session = target;
    
    // Chromeストレージに状態を保存
    chromeSaveState();
    
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
  const tabState = ensureTabState(tabId);
  if (!tabState.attached || !tabState.session) return { ok: true };
  
  try {
    await chrome.debugger.detach(tabState.session);
    tabState.attached = false;
    tabState.session = null;
    // バッジをクリア
    chrome.action.setBadgeText({ tabId, text: "" });
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
    
    // 状態を保存
    chromeSaveState();
    
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
  const tabState = ensureTabState(tabId);
  tabState.attached = false;
  tabState.session = null;
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
    const tabState = ensureTabState(tabId);
    tabState.errorCount = 0;
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

      // 状態を取得し、必要に応じてデバッグを自動開始
      case "GET_STATE_AND_AUTO_ATTACH": {
        // 1. 現在のタブの状態を取得（存在しない場合は初期状態を作成）
        const tabState = ensureTabState(tabId);
        
        // 2. デバッガーがアタッチされていない場合のみ自動アタッチを試行
        if (!tabState.attached) {
          console.log(`[AUTO_ATTACH] タブ${tabId}にデバッガーを自動アタッチします`);
          
          // 3. デバッガーをアタッチ
          const attachRes = await attachToTab(tabId);
          
          // 4. アタッチが成功した場合
          if (attachRes.ok) {
            // 5. アタッチ後の最新状態を再取得
            const updatedTabState = ensureTabState(tabId);
            
            // 6. 成功レスポンスを返す（autoAttached: trueで自動アタッチ成功を示す）
            sendResponse({
              tabId,
              attached: !!updatedTabState?.attached,
              latest: updatedTabState?.latest || null,
              autoAttached: true
            });
            break;
          } else {
            // 7. アタッチが失敗した場合のエラーログ
            console.log(`[AUTO_ATTACH] タブ${tabId}の自動アタッチ失敗:`, attachRes.error);
          }
        } else {
          // 8. 既にアタッチ済みの場合
          console.log(`[AUTO_ATTACH] タブ${tabId}は既にアタッチ済みです`);
        }
        
        // 9. 通常の状態レスポンスを返す（autoAttached: falseで自動アタッチなしを示す）
        sendResponse({
          tabId,
          attached: !!tabState?.attached,
          latest: tabState?.latest || null,
          autoAttached: false
        });
        break;
      }
    }
  })();
  return true;
});
  
