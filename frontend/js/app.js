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
        { name: 'TabManager', module: window.TabManager },
        { name: 'Lightbox', module: window.Lightbox },
        { name: 'ExporterStatus', module: window.ExporterStatus },
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

      // 4. Trigger initial folder and document requests
      if (initialState && window.AppBus) {
        // Open workspace directory
        const workspaceDir = initialState.workspace_dir;
        if (workspaceDir) {
          window.AppBus.emit('folder:open-request', { path: workspaceDir });
        }

        // Open target document or welcome document
        const targetDoc = initialState.target_file || initialState.welcome_path;
        if (targetDoc) {
          window.AppBus.emit('file:open-request', { path: targetDoc });
        }
      }

      console.info('[App] Markdown Studio bootstrap completed.');
    } catch (err) {
      console.error('[App] Fatal error during bootstrap:', err);
    }
  }

  // Ensure DOM is ready before bootstrapping
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
