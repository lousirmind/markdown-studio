/**
 * App Launcher (Bootstrap entry point)
 * Responsible for orchestrating application boot lifecycle on DOMContentLoaded:
 * 1. Fetching initial state from backend via BridgeClient (preferences, initial workspace, welcome file).
 * 2. Populating AppStore with preferences and workspace.
 * 3. Initializing all decoupled modules in strict sequence.
 * 4. Triggering initial folder and file load requests via AppBus.
 */
(function () {
  'use strict';

  async function bootstrap() {
    console.info('[App] Bootstrapping Markdown Studio...');

    try {
      // 1. Fetch initial state from desktop bridge
      let initialState = null;
      if (window.BridgeClient && typeof window.BridgeClient.getInitialState === 'function') {
        try {
          const res = await window.BridgeClient.getInitialState();
          if (res && (res.ok || res.success)) {
            initialState = res.data || res;
          }
        } catch (e) {
          console.warn('[App] Bridge getInitialState error:', e);
        }
      }

      // 2. Hydrate AppStore preferences if available
      if (initialState && initialState.preferences && window.AppStore) {
        window.AppStore.setPreferences(initialState.preferences);
      }

      // 3. Initialize all decoupled modules in sequence
      const modules = [
        { name: 'Appearance', module: window.Appearance },
        { name: 'EditorEngine', module: window.EditorEngine },
        { name: 'MdEnhancer', module: window.MdEnhancer },
        { name: 'TocOutline', module: window.TocOutline },
        { name: 'FileTree', module: window.FileTree },
        { name: 'SessionManager', module: window.SessionManager },
        { name: 'TabManager', module: window.TabManager },
        { name: 'Lightbox', module: window.Lightbox },
        { name: 'ExporterStatus', module: window.ExporterStatus },
        { name: 'SearchReplace', module: window.SearchReplace },
        { name: 'CommandPalette', module: window.CommandPalette },
      ];

      for (let i = 0; i < modules.length; i++) {
        const { name, module } = modules[i];
        if (module && typeof module.init === 'function') {
          try {
            module.init();
            console.info(`[App] Initialized module: ${name}`);
          } catch (err) {
            console.error(`[App] Error initializing module ${name}:`, err);
          }
        } else {
          console.info(`[App] Module ${name} not registered or has no init()`);
        }
      }

      // 4. Decide between restoring the last session and the default flow.
      //    An explicit CLI file argument always wins: only that file is opened.
      const launchedWithFile = !!(initialState && initialState.launched_with_file);
      let restoredSession = null;

      if (
        !launchedWithFile &&
        window.BridgeClient &&
        typeof window.BridgeClient.loadSession === 'function'
      ) {
        try {
          const sessionRes = await window.BridgeClient.loadSession();
          const isOk = sessionRes && (sessionRes.ok || sessionRes.success);
          const sessionData = sessionRes
            ? sessionRes.data !== undefined
              ? sessionRes.data
              : sessionRes
            : null;
          if (
            isOk &&
            sessionData &&
            Array.isArray(sessionData.tabs) &&
            sessionData.tabs.length > 0
          ) {
            restoredSession = sessionData;
          }
        } catch (err) {
          console.warn('[App] Session load failed:', err);
        }
      }

      if (restoredSession && window.AppBus) {
        console.info(
          `[App] Restoring last session (${restoredSession.tabs.length} tabs, mode=${restoredSession.editor_mode || 'ir'})...`
        );

        // Pause session writes until TabManager finished restoring.
        if (window.SessionManager && typeof window.SessionManager.beginRestore === 'function') {
          window.SessionManager.beginRestore(restoredSession);
        }

        // Fallback: if every remembered tab was skipped, show the welcome
        // document instead of leaving an empty editor behind.
        const onRestoreComplete = (payload) => {
          if (window.AppBus && typeof window.AppBus.off === 'function') {
            window.AppBus.off('session:restore-complete', onRestoreComplete);
          }
          const restoredCount =
            payload && typeof payload.restored === 'number' ? payload.restored : 0;
          if (restoredCount === 0) {
            const welcome = initialState && initialState.welcome_path;
            if (welcome) {
              window.AppBus.emit('file:open-request', { path: welcome });
            }
          }
        };
        window.AppBus.on('session:restore-complete', onRestoreComplete);
        window.AppBus.emit('session:restore', { session: restoredSession });
      } else if (initialState && window.AppBus) {
        // 5. Default startup: open workspace directory + target/welcome doc.
        const workspaceDir = initialState.workspace_dir;
        if (workspaceDir) {
          window.AppBus.emit('folder:open-request', { path: workspaceDir });
        }

        const targetDoc = initialState.target_file || initialState.welcome_path;
        if (targetDoc) {
          window.AppBus.emit('file:open-request', { path: targetDoc });
        }
      }

      console.info('[App] Markdown Studio bootstrap completed.');
      startOpenFilePoller();
    } catch (err) {
      console.error('[App] Fatal error during bootstrap:', err);
    }
  }

  // Finder documents opened while the app is already running arrive as Apple
  // events; the Python side queues them and this poller turns them into tabs.
  let openFilePollTimer = null;
  function startOpenFilePoller() {
    if (openFilePollTimer || !window.BridgeClient) return;
    if (typeof window.BridgeClient.consumeOpenFiles !== 'function') return;
    let busy = false;
    openFilePollTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await window.BridgeClient.consumeOpenFiles();
        const data = res && (res.data !== undefined ? res.data : res);
        const paths = (data && Array.isArray(data.paths)) ? data.paths : [];
        for (let i = 0; i < paths.length; i++) {
          if (window.AppBus) {
            window.AppBus.emit('file:open-request', { path: paths[i] });
          }
        }
      } catch (err) {
        // Bridge may not be ready yet; retry on the next tick.
      } finally {
        busy = false;
      }
    }, 600);
  }

  // Ensure DOM is ready before bootstrapping
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();