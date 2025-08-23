// ====== 設定 ======
const CDP_VERSION = "1.3";

// ====== 状態管理 ======

// 1. タブの状態を管理

/**
 * タブIDをキーとして使用する
 * タブの状態を値として保存する
 */
const tabStates = new Map();

/**
 * タブの状態を取得または初期化する
 * 
 * この関数を作った理由：
 * 1. 状態の一貫性を保つ - どのタブでも同じ形式の状態オブジェクトを使用
 * 2. エラーの防止 - undefinedやnullによるエラーを防ぐ
 * 3. 安全なプロパティアクセス - 存在しないタブでも安全に状態を取得
 * 4. 初期化の自動化 - 新しいタブの状態を自動的に初期化
 * 5. コードの簡潔性 - 毎回の存在チェックを省略できる
 * 
 * @param {number} tabId - 対象のタブID
 * @returns {Object} タブの状態オブジェクト
 *   - attached: boolean - デバッガーがアタッチ/デタッチされているか
 *   - newErrorInfo: Object|null - 最新のエラー情報
 *   - session: Object|null - CDPデバッガーセッション
 *   - errorCount: number - エラーの累計数
 */
function getTabState(tabId) {
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, { attached: false, newErrorInfo: null, session: null, errorCount: 0 });
  }
  return tabStates.get(tabId);
}

/**
 * タブ状態を削除
 * @param {number} tabId - タブID
 */
function removeTabState(tabId) {
  tabStates.delete(tabId);
}

/**
 * タブ状態をリセット（エラーカウントのみ）
 * @param {number} tabId - タブID
 */
function resetTabErrorCount(tabId) {
  const tabState = getTabState(tabId);
  tabState.errorCount = 0;
}

// 2. エラー情報管理（Error Log Management）
/**
 * 最新のエラー情報を設定し、エラーカウントとバッジを更新
 * @param {number} tabId - タブID
 * @param {Object} log - ログ情報（level, source, text, url, line, column）
 */
function setUpdateErrorBadge(tabId, log) {
  const tabState = getTabState(tabId);
  
  // エラー情報を更新
  tabState.newErrorInfo = { ...log, ts: Date.now() };
  
  // エラーレベルかつシステムメッセージ以外の場合のみカウントを増やす
  if (log.level === "error" && log.source !== "system") {
    tabState.errorCount++;
  }
  
  // バッジ状態を更新
  updateBadgeState(tabId, tabState.errorCount);
  
  // ストレージ状態を保存
  setChromeSaveState();
}

/**
 * エラー情報をクリア
 * @param {number} tabId - タブID
 */
function clearNewErrorInfo(tabId) {
  const tabState = getTabState(tabId);
  tabState.newErrorInfo = null;
  setChromeSaveState();
}

// 3. ポップアップ状態管理（Popup State Management）
/**
 * ポップアップ用の状態を取得
 * @param {number} tabId - タブID
 * @returns {Object} ポップアップ状態
 */
function getPopupState(tabId) {
  const tabState = getTabState(tabId);
  return {
    tabId,
    attached: !!tabState?.attached,
    newErrorInfo: tabState?.newErrorInfo || null
  };
}

// 4. ストレージ状態管理（Storage State Management）
/**
 * 状態をChromeストレージに保存
 */
async function setChromeSaveState() {
  const stateToSave = {};
  tabStates.forEach((state, tabId) => {
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
      tabStates.set(Number(tabId), {
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

// 5. バッジ状態管理（Badge State Management）
/**
 * バッジ状態を更新
 * @param {number} tabId - タブID
 * @param {number} errorCount - エラー数
 */
function updateBadgeState(tabId, errorCount) {
  const badgeText = errorCount > 0 ? String(errorCount) : "";
  chrome.action.setBadgeText({ tabId, text: badgeText });
  chrome.action.setBadgeBackgroundColor({ tabId, color: errorCount > 0 ? "#d00" : "#00000000" });
}

/**
 * バッジ状態をクリア
 * @param {number} tabId - タブID
 */
function clearBadgeState(tabId) {
  chrome.action.setBadgeText({ tabId, text: "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#00000000" });
}

// ====== ユーティリティ関数 ======
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
  const tabState = getTabState(tabId);
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
    
    // タブ状態を更新
    tabState.attached = true;
    tabState.session = target;
    
    // ストレージ状態を保存
    setChromeSaveState();
    
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
  const tabState = getTabState(tabId);
  if (!tabState.attached || !tabState.session) return { ok: true };
  
  try {
    await chrome.debugger.detach(tabState.session);
    
    // タブ状態を更新
    tabState.attached = false;
    tabState.session = null;
    
    // バッジ状態の自動クリアを無効化 - エラーカウントは保持
    // clearBadgeState(tabId);
    
    // ストレージ状態を保存
    setChromeSaveState();
    
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
      setUpdateErrorBadge(tabId, {
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
      setUpdateErrorBadge(tabId, {
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
      setUpdateErrorBadge(tabId, {
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
        setUpdateErrorBadge(tabId, {
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
  
  // タブ状態を更新
  const tabState = getTabState(tabId);
  tabState.attached = false;
  tabState.session = null;
});

/**
 * タブが削除された時の処理
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  const st = tabStates.get(tabId);
  if (st?.attached && st.session) {
    chrome.debugger.detach(st.session).catch(() => {});
  }
  // タブ状態を削除
  removeTabState(tabId);
});

/**
 * タブが更新された時の処理（ページ読み込み時にエラーカウントをリセット）
 * 
 * 注意：自動リセットは無効化されています
 * ユーザーが手動でリセットするまで、エラーカウントは保持されます
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // 自動リセットを無効化 - ユーザーが手動でリセットするまで保持
    // resetTabErrorCount(tabId);
    // clearBadgeState(tabId);
    
    console.log(`Tab ${tabId} updated - keeping error count`);
  }
});

// ====== メッセージ通信 ======

/**
 * ポップアップからのメッセージを処理
 * 
 * ポップアップ（popup.js）から送信されるメッセージを受信し、
 * デバッグモードの制御や状態取得を行います。
 * 
 * 対応するメッセージタイプ：
 * - GET_DEBUG_STATE: 現在のデバッグ状態を取得
 * - ATTACH_DEBUGGER: デバッガーをアタッチ
 * - DETACH_DEBUGGER: デバッガーをデタッチ
 * - TOGGLE_DEBUG_MODE: デバッグモードのON/OFF切り替え
 * 
 * @param {Object} msg - 受信したメッセージ
 * @param {string} msg.type - メッセージタイプ
 * @param {Object} _sender - 送信者情報（未使用）
 * @param {Function} sendResponse - レスポンス送信関数
 * @returns {boolean} true - 非同期レスポンスを示す
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return;

    const tabId = await getActiveTabId();
    if (!tabId) return sendResponse({ ok: false, error: "No active tab." });

    switch (msg.type) {

      /**
       * 現在のデバッグ状態を取得
       * 
       * 指定されたタブの現在のデバッグ状態とエラー情報を取得します。
       * デバッガーのアタッチ/デタッチは行わず、状態の確認のみを行います。
       * 
       * @param {number} tabId - 対象のタブID
       * @returns {Object} デバッグ状態
       *   - tabId: number - タブID
       *   - attached: boolean - デバッガーがアタッチされているか
       *   - newErrorInfo: Object|null - 最新のエラー情報
       * 
       * @example
       * // 現在の状態を確認
       * const state = await send("GET_DEBUG_STATE");
       * console.log(`デバッグ状態: ${state.attached ? 'ON' : 'OFF'}`);
       */
      case "GET_DEBUG_STATE": {
        const popupState = getPopupState(tabId);
        sendResponse(popupState);
        break;
      }

      /**
       * デバッガーをアタッチ
       * 
       * 指定されたタブにChrome DevTools Protocolデバッガーをアタッチします。
       * 既にアタッチされている場合は何も行わず、現在の状態を返します。
       * アタッチ後は、JavaScript例外、コンソール出力、ログ、ネットワークエラーを監視します。
       * 
       * @param {number} tabId - 対象のタブID
       * @returns {Object} アタッチ結果
       *   - tabId: number - タブID
       *   - attached: boolean - デバッガーがアタッチされているか
       *   - newErrorInfo: Object|null - 最新のエラー情報
       *   - message: string - 処理結果のメッセージ
       *   - error?: string - エラーが発生した場合のエラーメッセージ
       * 
       * @example
       * // デバッガーをアタッチ
       * const result = await send("ATTACH_DEBUGGER");
       * if (result.attached) {
       *   console.log("デバッグモードがONになりました");
       * }
       */
      case "ATTACH_DEBUGGER": {
        const tabState = getTabState(tabId);
        
        // 既にアタッチされている場合は何もしない
        if (tabState.attached) {
          sendResponse({
            ...getPopupState(tabId),
            message: "既にデバッガーがアタッチされています"
          });
          break;
        }

        // デバッガーをアタッチ
        const attachRes = await attachToTab(tabId);
        if (attachRes.ok) {
          sendResponse({
            ...getPopupState(tabId),
            message: "デバッガーをアタッチしました"
          });
        } else {
          sendResponse({
            ...getPopupState(tabId),
            error: attachRes.error,
            message: "デバッガーのアタッチに失敗しました"
          });
        }
        break;
      }

      /**
       * デバッガーをデタッチ
       * 
       * 指定されたタブからChrome DevTools Protocolデバッガーをデタッチします。
       * 既にデタッチされている場合は何も行わず、現在の状態を返します。
       * デタッチ後は、エラー監視が停止し、バッジもクリアされます。
       * 
       * @param {number} tabId - 対象のタブID
       * @returns {Object} デタッチ結果
       *   - tabId: number - タブID
       *   - attached: boolean - デバッガーがアタッチされているか
       *   - newErrorInfo: Object|null - 最新のエラー情報
       *   - message: string - 処理結果のメッセージ
       *   - error?: string - エラーが発生した場合のエラーメッセージ
       * 
       * @example
       * // デバッガーをデタッチ
       * const result = await send("DETACH_DEBUGGER");
       * if (!result.attached) {
       *   console.log("デバッグモードがOFFになりました");
       * }
       */
      case "DETACH_DEBUGGER": {
        const tabState = getTabState(tabId);
        
        // 既にデタッチされている場合は何もしない
        if (!tabState.attached) {
          sendResponse({
            ...getPopupState(tabId),
            message: "デバッガーは既にデタッチされています"
          });
          break;
        }

        // デバッガーをデタッチ
        const detachRes = await detachFromTab(tabId);
        if (detachRes.ok) {
          sendResponse({
            ...getPopupState(tabId),
            message: "デバッガーをデタッチしました"
          });
        } else {
          sendResponse({
            ...getPopupState(tabId),
            error: detachRes.error,
            message: "デバッガーのデタッチに失敗しました"
          });
        }
        break;
      }

      /**
       * デバッグモードのON/OFF切り替え
       * 
       * 現在のデバッグ状態に応じて、デバッガーのアタッチ/デタッチを切り替えます。
       * - デバッグモードがOFFの場合 → ONにする（デバッガーをアタッチ）
       * - デバッグモードがONの場合 → OFFにする（デバッガーをデタッチ）
       * 
       * このメッセージタイプは後方互換性のため残しています。
       * 新しい実装では、ATTACH_DEBUGGER/DETACH_DEBUGGERの使用を推奨します。
       * 
       * @param {number} tabId - 対象のタブID
       * @returns {Object} 切り替え結果
       *   - tabId: number - タブID
       *   - attached: boolean - デバッガーがアタッチされているか
       *   - newErrorInfo: Object|null - 最新のエラー情報
       *   - message: string - 処理結果のメッセージ
       * 
       * @example
       * // デバッグモードを切り替え
       * const result = await send("TOGGLE_DEBUG_MODE");
       * console.log(result.message); // "デバッグモードをONにしました" または "デバッグモードをOFFにしました"
       */
      case "TOGGLE_DEBUG_MODE": {
        const tabState = getTabState(tabId);
        
        if (!tabState.attached) {
          // デバッグモードがOFFの場合 → ONにする
          const attachRes = await attachToTab(tabId);
          if (attachRes.ok) {
            sendResponse({
              ...getPopupState(tabId),
              message: "デバッグモードをONにしました"
            });
            break;
          }
        } else {
          // デバッグモードがONの場合 → OFFにする
          const detachRes = await detachFromTab(tabId);
          if (detachRes.ok) {
            sendResponse({
              ...getPopupState(tabId),
              message: "デバッグモードをOFFにしました"
            });
            break;
          }
        }
        
        // エラー時は現在の状態を返す
        sendResponse({
          ...getPopupState(tabId),
          message: "デバッグモードの切り替えに失敗しました"
        });
        break;
      }

      /**
       * エラーカウントを表示
       * 
       * ポップアップが表示された時に呼び出され、エラーカウントを表示します。
       * 
       * @param {number} tabId - 対象のタブID
       * @returns {Object} 処理結果
       */
      case "SHOW_ERROR_COUNT": {
        const tabState = getTabState(tabId);
        updateBadgeState(tabId, tabState.errorCount);
        sendResponse({
          ...getPopupState(tabId),
          message: "エラーカウントを表示しました"
        });
        break;
      }

      /**
       * エラーカウントを非表示
       * 
       * ポップアップが非表示になった時に呼び出され、エラーカウントを非表示にします。
       * 
       * @param {number} tabId - 対象のタブID
       * @returns {Object} 処理結果
       */
      case "HIDE_ERROR_COUNT": {
        clearBadgeState(tabId);
        sendResponse({
          ...getPopupState(tabId),
          message: "エラーカウントを非表示にしました"
        });
        break;
      }
    }
  })();
  return true;
});

// ====== 初期化 ======
chromeLoadState();
  
