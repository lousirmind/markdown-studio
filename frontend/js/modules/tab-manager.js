/**
 * TabManager Module
 * Responsible for multi-document tabs management, opening files, tab switching,
 * closing tabs, window drag-and-drop file opening, 1200ms debounced auto-save,
 * immediate manual save, and 5000ms external disk file change auto-refresh.
 *
 * Performance notes:
 * - The tab bar is fully rebuilt only on structural changes (add / close /
 *   switch / open). Keystroke-level updates patch the affected .tab-item in
 *   place (dirty class, title tooltip, label) and never touch the whole bar.
 * - scrollIntoView() is only used on add/switch and always with
 *   {block:'nearest'} (no smooth behaviour).
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore,
 * and window.BridgeClient.
 */
(function () {
  'use strict';

  let autoSaveTimer = null;
  const AUTO_SAVE_DELAY_MS = 1200;

  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL_MS = 5000;

  /**
   * Escape HTML helper
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Render the tab items into #tabs-bar.
   *
   * Structural changes only (add / close / switch / open). Keystroke-level
   * content/dirty updates go through updateTabItem() instead.
   *
   * @param {{ scrollActive?: boolean }} [options]
   */
  function renderTabsBar(options) {
    const opts = options || {};
    const tabsBar = document.getElementById('tabs-bar');
    if (!tabsBar) return;

    if (!window.AppStore || typeof window.AppStore.getState !== 'function') return;

    const { tabs, activeTabId } = window.AppStore.getState();

    tabsBar.innerHTML = '';
    const fragment = document.createDocumentFragment();

    tabs.forEach((tab) => {
      const isActive = tab.id === activeTabId;

      const tabEl = document.createElement('div');
      tabEl.className = `tab-item ${isActive ? 'active' : ''} ${tab.dirty ? 'dirty' : ''}`;
      tabEl.setAttribute('data-id', tab.id);
      tabEl.setAttribute('title', tab.path || tab.name || '未命名');

      // Dirty dot indicator
      const dirtyDot = document.createElement('span');
      dirtyDot.className = 'tab-dirty-dot';
      dirtyDot.textContent = '●';
      dirtyDot.title = '有未保存的修改';
      tabEl.appendChild(dirtyDot);

      // File icon
      const tabIcon = document.createElement('span');
      tabIcon.className = 'tab-icon';
      tabIcon.textContent = '📝';
      tabEl.appendChild(tabIcon);

      // Tab title
      const label = document.createElement('span');
      label.className = 'tab-title';
      label.textContent = tab.name || '未命名';
      tabEl.appendChild(label);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close-btn';
      closeBtn.innerHTML = '×';
      closeBtn.title = '关闭标签 (Cmd/Ctrl + W)';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      tabEl.appendChild(closeBtn);

      // Tab click to switch
      tabEl.addEventListener('click', () => {
        if (tab.id !== activeTabId) {
          switchTab(tab.id);
        }
      });

      fragment.appendChild(tabEl);
    });

    tabsBar.appendChild(fragment);

    if (opts.scrollActive) {
      scrollActiveTabIntoView();
    }
  }

  /**
   * Scroll the active tab into view. Deliberately NOT smooth: the previous
   * implementation fired a smooth scroll twice per keystroke and caused a
   * compositor storm.
   */
  function scrollActiveTabIntoView() {
    const tabsBar = document.getElementById('tabs-bar');
    if (!tabsBar) return;
    const activeEl = tabsBar.querySelector('.tab-item.active');
    if (!activeEl) return;
    activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Directed update of one existing .tab-item: active/dirty classes, title
   * tooltip and label text. Writes are skipped when nothing changed, so a
   * keystroke produces no tab-bar mutations at all.
   * @param {object|null} tab
   */
  function updateTabItem(tab) {
    if (!tab || !tab.id) return;

    const tabsBar = document.getElementById('tabs-bar');
    if (!tabsBar) return;

    const safeId = String(tab.id).replace(/["\\]/g, '\\$&');
    let tabEl = null;
    try {
      tabEl = tabsBar.querySelector(`.tab-item[data-id="${safeId}"]`);
    } catch (e) {
      tabEl = null;
    }

    if (!tabEl) {
      // Structural mismatch (tab not rendered yet): fall back to one rebuild.
      renderTabsBar();
      return;
    }

    const state = window.AppStore && typeof window.AppStore.getState === 'function'
      ? window.AppStore.getState()
      : { activeTabId: null };

    const isActive = tab.id === state.activeTabId;
    if (tabEl.classList.contains('active') !== isActive) {
      tabEl.classList.toggle('active', isActive);
    }

    const isDirty = !!tab.dirty;
    if (tabEl.classList.contains('dirty') !== isDirty) {
      tabEl.classList.toggle('dirty', isDirty);
    }

    const titleText = tab.path || tab.name || '未命名';
    if (tabEl.getAttribute('title') !== titleText) {
      tabEl.setAttribute('title', titleText);
    }

    const labelEl = tabEl.querySelector('.tab-title');
    const labelText = tab.name || '未命名';
    if (labelEl && labelEl.textContent !== labelText) {
      labelEl.textContent = labelText;
    }
  }

  /**
   * Switch to a tab by ID
   */
  function switchTab(tabId) {
    if (!window.AppStore) return;

    window.AppStore.setActiveTab(tabId);
    const tab = window.AppStore.getActiveTab();
    renderTabsBar({ scrollActive: true });

    if (window.AppBus && tab) {
      window.AppBus.emit('tab:switched', { tab: { ...tab } });
    }
  }

  /**
   * Close a tab by ID
   */
  function closeTab(tabId) {
    if (!window.AppStore) return;

    const { tabs } = window.AppStore.getState();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    if (tab.dirty) {
      const confirmed = window.confirm(`文件 "${tab.name}" 尚未保存，是否放弃更改并关闭？`);
      if (!confirmed) return;
    }

    const closedPath = tab.path;
    const closedId = tab.id;

    window.AppStore.closeTab(tabId);

    // If all tabs are closed, create an untitled blank tab
    const remainingTabs = window.AppStore.getState().tabs;
    if (remainingTabs.length === 0) {
      const blankTab = window.AppStore.addTab({
        name: '未命名.md',
        path: null,
        content: '# 未命名文档\n\n',
        savedContent: '# 未命名文档\n\n',
        dirty: false,
      });
      if (window.AppBus) {
        window.AppBus.emit('tab:switched', { tab: { ...blankTab } });
      }
    } else {
      const activeTab = window.AppStore.getActiveTab();
      if (window.AppBus && activeTab) {
        window.AppBus.emit('tab:switched', { tab: { ...activeTab } });
      }
    }

    renderTabsBar({ scrollActive: true });

    if (window.AppBus) {
      window.AppBus.emit('tab:closed', { id: closedId, path: closedPath });
    }
  }

  /**
   * Open a file by absolute path:
   * If already open in a tab, activate that tab;
   * otherwise fetch file content via BridgeClient and create new tab.
   */
  async function openFile(filePath) {
    if (!filePath || !window.BridgeClient) return;

    if (!window.AppStore) return;

    const { tabs } = window.AppStore.getState();
    const existing = tabs.find((t) => t.path === filePath);

    if (existing) {
      switchTab(existing.id);
      return;
    }

    try {
      const res = await window.BridgeClient.readFile(filePath);
      const isOk = res && (res.ok || res.success);

      if (isOk) {
        const fileData = res.data || res;
        const newTab = window.AppStore.addTab({
          path: fileData.path || filePath,
          name: fileData.name || filePath.split(/[/\\]/).pop(),
          content: fileData.content || '',
          savedContent: fileData.content || '',
          mtime: fileData.mtime || Date.now() / 1000,
          dirty: false,
        });

        renderTabsBar({ scrollActive: true });

        if (window.AppBus) {
          window.AppBus.emit('tab:switched', { tab: { ...newTab } });
        }
      } else {
        const errorMsg = (res && res.error) || '读取文件失败';
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: errorMsg, type: 'error' });
        }
      }
    } catch (err) {
      console.error('[TabManager] Error opening file:', err);
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', { message: `打开文件失败: ${err.message}`, type: 'error' });
      }
    }
  }

  /**
   * Handle Open File native dialog button
   */
  async function handleOpenFileAction() {
    if (!window.BridgeClient) return;

    try {
      const res = await window.BridgeClient.selectFileDialog();
      const filePath = res && (res.path || (res.data && res.data.path));
      if (filePath) {
        openFile(filePath);
      }
    } catch (err) {
      console.error('[TabManager] selectFileDialog error:', err);
    }
  }

  /**
   * Save the active tab to disk immediately
   */
  async function saveActiveTab() {
    if (!window.AppStore || !window.BridgeClient) return;

    const tab = window.AppStore.getActiveTab();
    if (!tab) return;

    // Nothing to write when the buffer already matches the last saved state.
    if (tab.path && tab.content === tab.savedContent) {
      return;
    }

    // If tab has no local path (untitled draft)
    if (!tab.path) {
      const store = window.AppStore.getState();
      const workspaceDir = store.workspaceDir || '';
      if (!workspaceDir) {
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', {
            message: '未命名草稿需先在工作区创建文件',
            type: 'warning',
          });
        }
        return;
      }

      const filename = window.prompt('请输入保存的文件名 (例如 note.md):', tab.name || 'untitled.md');
      if (!filename || !filename.trim()) return;

      const res = await window.BridgeClient.createItem(workspaceDir, filename.trim(), false);
      const isOk = res && (res.ok || res.success);
      if (isOk) {
        const newPath = res.path || (res.data && res.data.path);
        tab.path = newPath;
        tab.name = filename.trim();
      } else {
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: res.error || '保存失败', type: 'error' });
        }
        return;
      }
    }

    try {
      const res = await window.BridgeClient.writeFile(tab.path, tab.content);
      const isOk = res && (res.ok || res.success);

      if (isOk) {
        const fileData = res.data || res;
        const newMtime = fileData.mtime || Date.now() / 1000;

        window.AppStore.markTabSaved(tab.id, newMtime);
        // markTabSaved emits tab:saved / tab:content-updated, which patch the
        // existing .tab-item in place. No full bar rebuild on save.
        updateTabItem(tab);

        if (window.AppBus) {
          window.AppBus.emit('file:saved', { path: tab.path, mtime: newMtime });
          window.AppBus.emit('notify:toast', { message: '保存成功', type: 'success' });
        }
      } else {
        const errorMsg = (res && res.error) || '保存失败';
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: errorMsg, type: 'error' });
        }
      }
    } catch (err) {
      console.error('[TabManager] Error saving file:', err);
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', { message: `保存失败: ${err.message}`, type: 'error' });
      }
    }
  }

  /**
   * Debounced Auto-save handler.
   *
   * Content/dirty state is written to AppStore exactly once (the store is
   * idempotent for identical content); the tab bar only receives a directed
   * .tab-item update via tab:content-updated. No full bar rebuild happens on
   * the typing path.
   */
  function scheduleAutoSave(content) {
    if (!window.AppStore || !window.BridgeClient) return;

    // 1. Store content + dirty flag (single owner of content state).
    const tab = window.AppStore.updateActiveTabContent(content);
    if (!tab) return;

    // 2. Only schedule a disk write when there is something to write.
    const prefs = window.AppStore.getState().preferences || {};
    if (!prefs.autoSave || !tab.path) return;
    if (!tab.dirty || tab.content === tab.savedContent) return;

    // 3. Debounce: coalesce bursts of keystrokes into one write.
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = setTimeout(async () => {
      const currentActive = window.AppStore.getActiveTab();
      if (!currentActive || currentActive.id !== tab.id || !currentActive.path) return;
      if (!currentActive.dirty || currentActive.content === currentActive.savedContent) return;

      try {
        const res = await window.BridgeClient.writeFile(currentActive.path, currentActive.content);
        const isOk = res && (res.ok || res.success);

        if (isOk) {
          const fileData = res.data || res;
          const newMtime = fileData.mtime || Date.now() / 1000;

          window.AppStore.markTabSaved(currentActive.id, newMtime);
          updateTabItem(currentActive);

          if (window.AppBus) {
            window.AppBus.emit('file:saved', { path: currentActive.path, mtime: newMtime });
          }
        }
      } catch (err) {
        console.error('[TabManager] Auto-save error:', err);
      }
    }, AUTO_SAVE_DELAY_MS);
  }

  /**
   * Monitor external disk file modifications every 5000ms (skipped while the
   * window is hidden).
   */
  function startAutoRefreshTimer() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }

    autoRefreshTimer = setInterval(async () => {
      if (!window.AppStore || !window.BridgeClient) return;

      // No polling work while the window is hidden/minimized.
      if (typeof document !== 'undefined' && document.hidden) return;

      const state = window.AppStore.getState();
      const prefs = state.preferences || {};
      if (!prefs.autoRefresh) return;

      // Filter tabs that have disk paths and are NOT currently dirty
      const cleanTabsWithPaths = state.tabs.filter((t) => t.path && !t.dirty);
      if (cleanTabsWithPaths.length === 0) return;

      const pathList = cleanTabsWithPaths.map((t) => t.path);

      try {
        const res = await window.BridgeClient.checkFilesMtime(pathList);
        const isOk = res && (res.ok || res.success);
        if (!isOk) return;

        const mtimesMap = res.mtimes || res.data || {};

        for (let i = 0; i < cleanTabsWithPaths.length; i++) {
          const tab = cleanTabsWithPaths[i];
          const diskMtime = mtimesMap[tab.path];

          // If disk modification timestamp is newer than memory record
          if (typeof diskMtime === 'number' && diskMtime > (tab.mtime || 0) + 0.001) {
            // Re-read file
            const readRes = await window.BridgeClient.readFile(tab.path);
            const readOk = readRes && (readRes.ok || readRes.success);

            if (readOk) {
              const fileData = readRes.data || readRes;
              tab.content = fileData.content || '';
              tab.savedContent = fileData.content || '';
              tab.mtime = fileData.mtime || diskMtime;
              tab.dirty = false;

              // Content was reloaded from disk; the tab is clean again.
              updateTabItem(tab);

              // If this is currently the active tab, update editor value
              const activeTab = window.AppStore.getActiveTab();
              if (activeTab && activeTab.id === tab.id) {
                if (window.EditorEngine && typeof window.EditorEngine.setValue === 'function') {
                  window.EditorEngine.setValue(tab.content);
                }
                if (window.AppBus) {
                  window.AppBus.emit('notify:toast', {
                    message: `检测到外部修改，已自动同步刷新: ${tab.name}`,
                    type: 'info',
                  });
                  window.AppBus.emit('tab:switched', { tab: { ...tab } });
                }
              }
            }
          }
        }
      } catch (err) {
        // Silent error during background poll
      }
    }, AUTO_REFRESH_INTERVAL_MS);
  }

  /**
   * Drag & drop: full-window overlay + desktop / mock dispatch.
   *
   * Desktop (pywebview): WKWebView never exposes a real File.path, so opening
   * is handled entirely by the Python bridge (backend/bridge.py
   * handle_drop_event). That handler is registered on document.body through
   * pywebview, receives pywebviewFullPath for every dropped item and emits
   * AppBus file/folder requests. This listener therefore only prevents
   * WebView navigation and drives the overlay; opening files here as well
   * would duplicate tabs.
   *
   * Browser/mock mode: no Python channel exists, so text files are read with
   * FileReader and opened as pathless scratch tabs. Images and unsupported
   * types only show toasts (dropped images are never written to assets/).
   */
  const TEXT_FILE_RE = /\.(md|markdown|mdown|txt)$/i;
  const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?)$/i;
  let dragDepth = 0;

  function isFileDrag(e) {
    const dt = e && e.dataTransfer;
    if (!dt) return false;
    let types = [];
    try {
      types = Array.from(dt.types || []);
    } catch (err) {
      types = [];
    }
    // WKWebView may omit dataTransfer.types entirely; treat that as a file
    // drag so the overlay still appears.
    return types.length === 0 || types.indexOf('Files') !== -1;
  }

  function setDropOverlayVisible(visible) {
    const overlay = document.getElementById('drop-overlay');
    if (!overlay) return;
    overlay.classList.toggle('hidden', !visible);
    overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function showDropOverlay() {
    setDropOverlayVisible(true);
  }

  function hideDropOverlay() {
    dragDepth = 0;
    setDropOverlayVisible(false);
  }

  function toastDrop(message, type) {
    if (window.AppBus) {
      window.AppBus.emit('notify:toast', { message, type: type || 'info' });
    }
  }

  /**
   * Browser-only fallback: read a dropped text file into a pathless tab.
   * Never used in the desktop WebView (see initDragAndDrop).
   */
  function openBrowserDroppedFile(file) {
    if (!file) return;

    if (TEXT_FILE_RE.test(file.name || '')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (!window.AppStore) return;
        const newTab = window.AppStore.addTab({
          name: file.name,
          path: null,
          content: evt.target.result,
          savedContent: evt.target.result,
          dirty: false,
        });
        renderTabsBar({ scrollActive: true });
        if (window.AppBus) {
          window.AppBus.emit('tab:switched', { tab: { ...newTab } });
        }
      };
      reader.onerror = () => {
        toastDrop(`读取文件失败: ${file.name}`, 'error');
      };
      reader.readAsText(file);
      return;
    }

    if (IMAGE_FILE_RE.test(file.name || '')) {
      toastDrop('图片请使用 Cmd+V 粘贴插入', 'info');
      return;
    }

    toastDrop(`不支持的文件类型：${file.name}`, 'warning');
  }

  /**
   * Register drag & drop behaviour.
   *
   * The overlay is shown from dragenter and hidden on dragleave/drop (deeper
   * element transitions are counted so the overlay does not flicker). The
   * actual open logic is intentionally split by runtime: Python channel in
   * the desktop app, FileReader only in the standalone browser/mock mode.
   */
  function initDragAndDrop() {
    window.addEventListener('blur', hideDropOverlay);
    window.addEventListener('dragend', hideDropOverlay);

    window.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth += 1;
      showDropOverlay();
    });

    window.addEventListener('dragover', (e) => {
      // Always prevent the WebView from navigating to the dropped file.
      e.preventDefault();
      e.stopPropagation();
      if (!isFileDrag(e)) return;
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch (err) {
        // Some WebKit builds expose a read-only dataTransfer here.
      }
      showDropOverlay();
    });

    window.addEventListener('dragleave', (e) => {
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setDropOverlayVisible(false);
      }
    });

    window.addEventListener('drop', (e) => {
      // Always prevent the WebView from navigating to the dropped file.
      e.preventDefault();
      e.stopPropagation();
      hideDropOverlay();

      if (!isFileDrag(e)) return;

      // Desktop: the Python drop channel owns opening. Falling back to
      // FileReader here would create a second (pathless) copy of every tab.
      const isMock = !!(
        window.BridgeClient &&
        typeof window.BridgeClient.isMock === 'function' &&
        window.BridgeClient.isMock()
      );
      if (!isMock) {
        if (window.__mdStudioDropChannel !== true) {
          toastDrop('拖拽通道尚未就绪，请使用工具栏的「打开文件」按钮', 'warning');
        }
        return;
      }

      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      for (let i = 0; i < files.length; i++) {
        openBrowserDroppedFile(files[i]);
      }
    });
  }

  const TabManager = {
    init() {
      // 1. Bind open and save buttons
      const btnOpenFile = document.getElementById('btn-open-file');
      if (btnOpenFile) {
        btnOpenFile.addEventListener('click', handleOpenFileAction);
      }

      const btnSaveFile = document.getElementById('btn-save-file');
      if (btnSaveFile) {
        btnSaveFile.addEventListener('click', saveActiveTab);
      }

      // 2. Setup drag and drop
      initDragAndDrop();

      // 3. Register AppBus events
      if (window.AppBus) {
        // Open file request
        window.AppBus.on('file:open-request', (payload) => {
          if (payload && payload.path) {
            openFile(payload.path);
          }
        });

        // Save file request
        window.AppBus.on('file:save-request', () => {
          saveActiveTab();
        });

        // Editor content changed
        window.AppBus.on('editor:content-changed', (payload) => {
          if (payload && payload.content !== undefined) {
            scheduleAutoSave(payload.content);
          }
        });

        // Tab state updates: patch only the affected .tab-item. Keystrokes and
        // saves must never rebuild the whole bar.
        window.AppBus.on('tab:content-updated', (payload) => {
          const tab = (payload && payload.tab) || window.AppStore.getActiveTab();
          updateTabItem(tab);
        });

        window.AppBus.on('tab:saved', (payload) => {
          const tab = (payload && payload.tab) || window.AppStore.getActiveTab();
          updateTabItem(tab);
        });
      }

      // 4. Initial render (structural; scroll active tab into view once)
      renderTabsBar({ scrollActive: true });

      // 5. Start auto-refresh interval
      startAutoRefreshTimer();
    },

    saveCurrent() {
      return saveActiveTab();
    },

    open(path) {
      return openFile(path);
    },

    close(id) {
      return closeTab(id);
    },

    render() {
      renderTabsBar();
    },
  };

  window.TabManager = TabManager;
})();
