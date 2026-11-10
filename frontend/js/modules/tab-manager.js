/**
 * TabManager Module
 * Responsible for multi-document tabs management, opening files, tab switching,
 * closing tabs, window drag-and-drop file opening, 600ms debounced auto-save,
 * immediate manual save, and 2000ms external disk file change auto-refresh.
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore,
 * and window.BridgeClient.
 */
(function () {
  'use strict';

  let autoSaveTimer = null;
  const AUTO_SAVE_DELAY_MS = 600;

  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL_MS = 2000;

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
   * Render the tab items into #tabs-bar
   */
  function renderTabsBar() {
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

    // Scroll active tab into view if needed
    const activeEl = tabsBar.querySelector('.tab-item.active');
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }

  /**
   * Switch to a tab by ID
   */
  function switchTab(tabId) {
    if (!window.AppStore) return;

    window.AppStore.setActiveTab(tabId);
    const tab = window.AppStore.getActiveTab();
    renderTabsBar();

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

    renderTabsBar();

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

        renderTabsBar();

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
        renderTabsBar();

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
   * Debounced Auto-save handler
   */
  function scheduleAutoSave(content) {
    if (!window.AppStore || !window.BridgeClient) return;

    // 1. Update content in store immediately
    const tab = window.AppStore.updateActiveTabContent(content);
    if (!tab) return;

    renderTabsBar();

    // 2. Check if autoSave preference is enabled and tab has path
    const prefs = window.AppStore.getState().preferences || {};
    if (!prefs.autoSave || !tab.path) return;

    // 3. Clear existing timer and reschedule
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = setTimeout(async () => {
      const currentActive = window.AppStore.getActiveTab();
      if (!currentActive || currentActive.id !== tab.id || !currentActive.dirty || !currentActive.path) {
        return;
      }

      try {
        const res = await window.BridgeClient.writeFile(currentActive.path, currentActive.content);
        const isOk = res && (res.ok || res.success);

        if (isOk) {
          const fileData = res.data || res;
          const newMtime = fileData.mtime || Date.now() / 1000;

          window.AppStore.markTabSaved(currentActive.id, newMtime);
          renderTabsBar();

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
   * Monitor external disk file modifications every 2000ms
   */
  function startAutoRefreshTimer() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
    }

    autoRefreshTimer = setInterval(async () => {
      if (!window.AppStore || !window.BridgeClient) return;

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
   * Handle drag and drop of Markdown files onto window
   */
  function initDragAndDrop() {
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // Desktop webview provides full file.path
        if (file.path) {
          openFile(file.path);
        } else {
          // In-browser fallback
          const reader = new FileReader();
          reader.onload = (evt) => {
            const content = evt.target.result;
            if (window.AppStore) {
              const newTab = window.AppStore.addTab({
                name: file.name,
                path: null,
                content: content,
                savedContent: content,
                dirty: false,
              });
              renderTabsBar();
              if (window.AppBus) {
                window.AppBus.emit('tab:switched', { tab: { ...newTab } });
              }
            }
          };
          reader.readAsText(file);
        }
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

        // Tab state updates
        window.AppBus.on('tab:content-updated', () => {
          renderTabsBar();
        });

        window.AppBus.on('tab:saved', () => {
          renderTabsBar();
        });
      }

      // 4. Initial render
      renderTabsBar();

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
