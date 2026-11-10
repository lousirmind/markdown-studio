/**
 * SessionManager Module
 * Persists and restores the last working session (open tabs, dirty buffers,
 * workspace directory and editor mode) across app launches.
 *
 * Design notes:
 * - Saving is debounced (500ms) and driven purely by AppBus events, so typing
 *   never blocks on disk I/O.
 * - window.__mdStudioSessionStateJSON() is a synchronous snapshot used by the
 *   Python closing hook: it must never be async, otherwise the WebView could
 *   be torn down before the Promise resolves.
 * - While a session is being restored (restoring === true) saves are paused so
 *   the intermediate empty state can never overwrite the previous session.
 * - Closing a tab emits tab:closed and the debounced save persists the new tab
 *   list, so individually closed tabs do not reappear on the next launch.
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore
 * and window.BridgeClient.
 */
(function () {
  'use strict';

  const SAVE_DEBOUNCE_MS = 500;
  const VALID_MODES = ['reader', 'ir', 'sv', 'wysiwyg'];

  let saveTimer = null;
  let restoring = false;
  let lastSerialized = null;
  let restoringSessionJson = null;
  let saveInFlight = false;
  // Serializes writes so an older snapshot can never land after a newer one.
  let saveChain = Promise.resolve();

  function getState() {
    if (window.AppStore && typeof window.AppStore.getState === 'function') {
      return window.AppStore.getState();
    }
    return { tabs: [], activeTabId: null, workspaceDir: null, editorMode: 'ir' };
  }

  /**
   * Build the serializable session snapshot.
   * Tab content is only persisted for dirty buffers (or path-less scratch
   * tabs, whose content exists nowhere else); clean file tabs reload from disk.
   */
  function buildState() {
    const state = getState();
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];

    let active = null;
    if (window.AppStore && typeof window.AppStore.getActiveTab === 'function') {
      active = window.AppStore.getActiveTab();
    }

    const mode = VALID_MODES.indexOf(state.editorMode) !== -1 ? state.editorMode : 'ir';

    return {
      version: 1,
      saved_at: Math.floor(Date.now() / 1000),
      workspace_dir: state.workspaceDir || null,
      active_path: active && active.path ? active.path : null,
      active_name: active && !active.path ? active.name || null : null,
      editor_mode: mode,
      tabs: tabs.map((tab) => {
        const entry = {
          path: tab.path || null,
          name: tab.name || '未命名.md',
          dirty: !!tab.dirty,
          scrollTop: typeof tab.scrollTop === 'number' ? tab.scrollTop : 0,
        };
        if (tab.dirty || !tab.path) {
          entry.content = typeof tab.content === 'string' ? tab.content : '';
        }
        return entry;
      }),
    };
  }

  /**
   * Synchronous snapshot for the Python window-closing hook.
   * While restoring with an empty store, echo the loaded session instead of an
   * empty one so a close mid-restore cannot wipe the previous session.
   */
  function stateJSON() {
    try {
      const tabs = getState().tabs;
      if (restoring && tabs.length === 0 && restoringSessionJson) {
        return restoringSessionJson;
      }
      return JSON.stringify(buildState());
    } catch (err) {
      console.warn('[SessionManager] Failed to serialize session:', err);
      return '';
    }
  }

  async function doSave() {
    if (restoring) {
      return { ok: false, success: false, skipped: true, reason: 'restoring' };
    }
    if (!window.BridgeClient || typeof window.BridgeClient.saveSession !== 'function') {
      return { ok: false, success: false, skipped: true, reason: 'no-bridge' };
    }

    let state;
    let serialized;
    try {
      state = buildState();
      serialized = JSON.stringify(state);
    } catch (err) {
      console.warn('[SessionManager] Failed to build session state:', err);
      return { ok: false, success: false, error: String(err) };
    }

    // Ignore saved_at when deduplicating: otherwise every event more than one
    // second apart would rewrite an unchanged session.
    const dedupeKey = serialized.replace(/"saved_at":\d+/, '"saved_at":0');

    // Nothing changed since the last successful write.
    if (dedupeKey === lastSerialized) {
      return { ok: true, success: true, skipped: true, reason: 'unchanged' };
    }

    saveInFlight = true;
    try {
      const res = await window.BridgeClient.saveSession(state);
      const isOk = res && (res.ok || res.success);
      if (isOk) {
        lastSerialized = dedupeKey;
      } else {
        // Retry on the next event instead of pretending the state was saved.
        lastSerialized = null;
        console.warn('[SessionManager] Session save failed:', res && res.error);
      }
      return res;
    } catch (err) {
      lastSerialized = null;
      console.warn('[SessionManager] Session save exception:', err);
      return { ok: false, success: false, error: String(err) };
    } finally {
      saveInFlight = false;
    }
  }

  /**
   * Persist immediately (used by flush / explicit calls).
   * Saves are chained so the newest snapshot is always written last.
   */
  function saveNow() {
    const next = saveChain.then(doSave, doSave);
    saveChain = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  /**
   * Debounced save: coalesces bursts of typing / tab events into one write.
   */
  function scheduleSave() {
    if (restoring) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function flushNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return saveNow();
  }

  function beginRestore(session) {
    restoring = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      restoringSessionJson = session ? JSON.stringify(session) : null;
    } catch (err) {
      restoringSessionJson = null;
    }
  }

  function endRestore() {
    if (!restoring) return;
    restoring = false;
    restoringSessionJson = null;
    // Persist the restored state once so the session file matches what is now
    // on screen (e.g. recovered scratch tabs, skipped missing files).
    scheduleSave();
  }

  const SessionManager = {
    init() {
      if (window.AppBus) {
        const saveEvents = [
          'tab:added',
          'tab:closed',
          'tab:activated',
          'tab:switched',
          'tab:content-updated',
          'file:saved',
          'editor:mode-changed',
          'folder:open-request',
        ];
        saveEvents.forEach((eventName) => {
          window.AppBus.on(eventName, () => scheduleSave());
        });

        // Restore lifecycle: TabManager finishes restoring and reports back.
        window.AppBus.on('session:restore-complete', () => endRestore());
      }

      // Safety net: persist before the page is hidden/closed. The Python
      // closing hook performs the authoritative synchronous save.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          flushNow();
        }
      });
      window.addEventListener('beforeunload', () => {
        // Cannot await here; Python reads window.__mdStudioSessionStateJSON
        // synchronously on close. This keeps the debounce from being lost in
        // browser/mock mode.
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
          saveNow();
        }
      });

      // Synchronous hooks consumed by backend/bridge.py.
      window.__mdStudioSessionStateJSON = stateJSON;
      window.__mdStudioFlushSession = flushNow;

      console.info('[SessionManager] Initialized session persistence hooks.');
    },

    buildState() {
      return buildState();
    },

    saveNow() {
      return saveNow();
    },

    scheduleSave() {
      scheduleSave();
    },

    flush() {
      return flushNow();
    },

    beginRestore(session) {
      beginRestore(session);
    },

    endRestore() {
      endRestore();
    },

    isRestoring() {
      return restoring;
    },

    isSaving() {
      return saveInFlight;
    },
  };

  window.SessionManager = SessionManager;
})();
