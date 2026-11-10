/**
 * TabManager Module
 * Responsible for multi-document tabs management, opening files, tab switching,
 * closing tabs, tab drag-sorting, the recent-files list/popover, window
 * drag-and-drop file opening, 1200ms debounced auto-save, immediate manual save,
 * and 5000ms external disk file change auto-refresh.
 *
 * Performance notes:
 * - The tab bar is fully rebuilt only on structural changes (add / close /
 *   switch / open / reorder). Keystroke-level updates patch the affected
 *   .tab-item in place (dirty class, title tooltip, label) and never touch the
 *   whole bar. Reordering never rebuilds or re-setValue()s the editor.
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

  // Recent files are stored in preferences (max 20, newest first).
  const RECENT_FILES_MAX = 20;
  const RECENT_PREF_KEY = 'recentFiles';
  const RECENT_SAVE_DEBOUNCE_MS = 500;

  let recentSaveTimer = null;
  let recentPopoverOpen = false;
  // path -> true when the last existence probe reported the file as missing.
  let recentMissingMap = Object.create(null);
  let recentCheckToken = 0;

  // Tab drag-sorting state (HTML5 drag & drop inside #tabs-bar only).
  let draggingTabId = null;
  let dropIndicatorEl = null;
  let dropIndicatorSide = null;
  let suppressTabClickUntil = 0;

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

  // ---------------------------------------------------------------------------
  // Recent files (preference-backed, max 20, newest first)
  // ---------------------------------------------------------------------------

  /**
   * Normalize / de-duplicate a stored recent-files list.
   * Entries without a real path are ignored (untitled scratch tabs are never
   * recorded). Newest first, capped at RECENT_FILES_MAX.
   * @param {any} rawList
   * @returns {{path: string, name: string, openedAt: number}[]}
   */
  function normalizeRecentFiles(rawList) {
    if (!Array.isArray(rawList)) return [];

    const seen = Object.create(null);
    const items = [];

    rawList.forEach((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const path = typeof raw.path === 'string' ? raw.path.trim() : '';
      if (!path || seen[path]) return;
      seen[path] = true;

      const name = typeof raw.name === 'string' && raw.name ? raw.name : basenameOf(path);
      const openedAt = typeof raw.openedAt === 'number' && isFinite(raw.openedAt) ? raw.openedAt : 0;
      items.push({ path, name, openedAt });
    });

    items.sort((a, b) => b.openedAt - a.openedAt);
    return items.slice(0, RECENT_FILES_MAX);
  }

  /**
   * Read the current recent-files list from AppStore preferences.
   * @returns {{path: string, name: string, openedAt: number}[]}
   */
  function getRecentFiles() {
    const state = window.AppStore && typeof window.AppStore.getState === 'function'
      ? window.AppStore.getState()
      : null;
    const prefs = state && state.preferences ? state.preferences : {};
    return normalizeRecentFiles(prefs[RECENT_PREF_KEY]);
  }

  /**
   * Persist preferences (debounced) through the bridge. Passing the full
   * preference object keeps unrelated keys intact.
   */
  function scheduleRecentPreferencesSave() {
    if (!window.BridgeClient || typeof window.BridgeClient.savePreferences !== 'function') {
      return;
    }
    if (recentSaveTimer) {
      clearTimeout(recentSaveTimer);
    }
    recentSaveTimer = setTimeout(async () => {
      recentSaveTimer = null;
      try {
        const state = window.AppStore && typeof window.AppStore.getState === 'function'
          ? window.AppStore.getState()
          : null;
        if (state && state.preferences) {
          await window.BridgeClient.savePreferences(state.preferences);
        }
      } catch (err) {
        console.warn('[TabManager] Failed to persist recent files:', err);
      }
    }, RECENT_SAVE_DEBOUNCE_MS);
  }

  /**
   * Remember a successfully opened file.
   *
   * Re-opening an existing path moves it to the front and refreshes openedAt
   * (no duplicates). preserveExisting is used by session restore / saves so
   * merely restoring a session or saving cannot reshuffle the "recent" order.
   *
   * @param {string} filePath
   * @param {string} [name]
   * @param {{ preserveExisting?: boolean }} [options]
   * @returns {object|null} The recorded entry
   */
  function recordRecentFile(filePath, name, options) {
    if (!filePath || typeof filePath !== 'string') return null;
    if (!window.AppStore || typeof window.AppStore.updatePreference !== 'function') return null;

    const opts = options || {};
    const path = filePath.trim();
    if (!path) return null;

    const current = getRecentFiles();
    const existing = current.find((item) => item.path === path);
    if (existing && opts.preserveExisting) return existing;

    const entry = {
      path,
      name: typeof name === 'string' && name ? name : basenameOf(path),
      openedAt: Date.now(),
    };

    const next = [entry]
      .concat(current.filter((item) => item.path !== path))
      .slice(0, RECENT_FILES_MAX);

    delete recentMissingMap[path];
    window.AppStore.updatePreference(RECENT_PREF_KEY, next);
    scheduleRecentPreferencesSave();

    if (recentPopoverOpen) {
      renderRecentFilesPopover();
    }

    return entry;
  }

  /**
   * Parent directory of a path, for the secondary line in the popover.
   * @param {string} filePath
   * @returns {string}
   */
  function dirnameOf(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (slash <= 0) return '';
    return filePath.slice(0, slash);
  }

  /**
   * Probe existence of every recent path via the bridge. Missing files stay in
   * the list (only visually marked); they are never auto-removed.
   */
  function refreshRecentMissingStatus() {
    const items = getRecentFiles();
    if (items.length === 0) {
      recentMissingMap = Object.create(null);
      return Promise.resolve();
    }
    if (!window.BridgeClient || typeof window.BridgeClient.checkFilesMtime !== 'function') {
      return Promise.resolve();
    }

    const token = ++recentCheckToken;
    const paths = items.map((item) => item.path);

    return Promise.resolve(window.BridgeClient.checkFilesMtime(paths))
      .then((res) => {
        if (token !== recentCheckToken) return;
        const isOk = res && (res.ok || res.success);
        if (!isOk) return;

        // BridgeClient spreads the backend payload at the top level and also
        // nests it under .data; check_files_mtime returns a {path: mtime|null}
        // map (not a {mtimes: map} wrapper).
        const data = (res && res.data) || res || {};
        const mtimes = data.mtimes || (res && res.mtimes) || data || {};
        const missing = Object.create(null);
        paths.forEach((path) => {
          const value = mtimes[path];
          // The backend returns null for a non-existent path; an absent key is
          // treated the same way so a stale path can never look healthy.
          if (value === null || typeof value !== 'number') {
            missing[path] = true;
          }
        });

        recentMissingMap = missing;
        if (recentPopoverOpen) {
          renderRecentFilesPopover();
        }
      })
      .catch(() => {
        // Existence probing is best-effort; never break the popover.
      });
  }

  /**
   * Render the recent-files popover list (newest first).
   */
  function renderRecentFilesPopover() {
    const listEl = document.getElementById('recent-files-list');
    if (!listEl) return;

    const items = getRecentFiles();
    listEl.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'recent-files-empty';
      empty.textContent = '暂无最近文件';
      listEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      const isMissing = !!recentMissingMap[item.path];

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'recent-file-item' + (isMissing ? ' missing' : '');
      row.setAttribute('data-path', item.path);
      row.title = isMissing ? item.path + '\n文件已丢失' : item.path;

      const icon = document.createElement('span');
      icon.className = 'recent-file-icon';
      icon.textContent = isMissing ? '⚠︎' : '📄';
      row.appendChild(icon);

      const textWrap = document.createElement('span');
      textWrap.className = 'recent-file-text';

      const nameEl = document.createElement('span');
      nameEl.className = 'recent-file-name';
      nameEl.textContent = item.name || basenameOf(item.path);
      textWrap.appendChild(nameEl);

      const dirEl = document.createElement('span');
      dirEl.className = 'recent-file-dir';
      dirEl.textContent = dirnameOf(item.path) || '—';
      textWrap.appendChild(dirEl);

      row.appendChild(textWrap);

      if (isMissing) {
        const badge = document.createElement('span');
        badge.className = 'recent-file-missing-badge';
        badge.textContent = '已丢失';
        row.appendChild(badge);
      }

      row.addEventListener('click', () => handleRecentFileClick(item, isMissing));
      fragment.appendChild(row);
    });

    listEl.appendChild(fragment);
  }

  /**
   * Click on one recent entry: valid files open through the usual AppBus
   * request; missing files only toast (and stay listed).
   */
  function handleRecentFileClick(item, isMissing) {
    if (!item || !item.path) return;

    if (isMissing) {
      toastSession('文件已丢失，无法打开：' + (item.name || item.path), 'warning');
      return;
    }

    setRecentPopoverOpen(false);
    if (window.AppBus) {
      window.AppBus.emit('file:open-request', { path: item.path });
    }
  }

  function isRecentPopoverOpen() {
    const popover = document.getElementById('recent-files-popover');
    return !!popover && !popover.classList.contains('hidden');
  }

  function setRecentPopoverOpen(open) {
    const popover = document.getElementById('recent-files-popover');
    const btn = document.getElementById('btn-recent-files');
    if (!popover) return;

    recentPopoverOpen = !!open;
    popover.classList.toggle('hidden', !open);
    if (btn) {
      btn.classList.toggle('active', !!open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    if (open) {
      renderRecentFilesPopover();
      refreshRecentMissingStatus();
    } else {
      // Invalidate any in-flight existence probe.
      recentCheckToken += 1;
    }
  }

  function clearRecentFiles() {
    if (!window.AppStore || typeof window.AppStore.updatePreference !== 'function') return;
    recentMissingMap = Object.create(null);
    window.AppStore.updatePreference(RECENT_PREF_KEY, []);
    scheduleRecentPreferencesSave();
    renderRecentFilesPopover();
    toastSession('已清除最近文件记录', 'info');
  }

  /**
   * Wire the recent-files button and its lightweight non-blocking popover.
   */
  function bindRecentFilesUI() {
    const btn = document.getElementById('btn-recent-files');
    if (btn) {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        setRecentPopoverOpen(!isRecentPopoverOpen());
      });
    }

    const closeBtn = document.getElementById('btn-close-recent-files');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => setRecentPopoverOpen(false));
    }

    const clearBtn = document.getElementById('btn-clear-recent-files');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => clearRecentFiles());
    }

    // mousedown (not click) so other header buttons close the popover first.
    document.addEventListener('mousedown', (event) => {
      if (!isRecentPopoverOpen()) return;
      const popover = document.getElementById('recent-files-popover');
      const anchor = document.getElementById('recent-files-anchor');
      if (popover && popover.contains(event.target)) return;
      if (anchor && anchor.contains(event.target)) return;
      setRecentPopoverOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if ((event.key === 'Escape' || event.key === 'Esc') && isRecentPopoverOpen()) {
        event.preventDefault();
        event.stopPropagation();
        setRecentPopoverOpen(false);
      }
    });
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

    tabs.forEach((tab, index) => {
      const isActive = tab.id === activeTabId;

      const tabEl = document.createElement('div');
      tabEl.className = `tab-item ${isActive ? 'active' : ''} ${tab.dirty ? 'dirty' : ''}`;
      tabEl.setAttribute('data-id', tab.id);
      tabEl.setAttribute('data-index', String(index));
      tabEl.setAttribute('title', tab.path || tab.name || '未命名');

      // HTML5 drag-sorting: the whole tab is the drag handle (window drag &
      // drop for files is a separate, unrelated path).
      tabEl.draggable = true;
      tabEl.addEventListener('dragstart', (e) => handleTabDragStart(e, tab));
      tabEl.addEventListener('dragend', endTabDrag);

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

      // Tab click to switch (ignored right after a drag gesture).
      tabEl.addEventListener('click', () => {
        if (draggingTabId || Date.now() < suppressTabClickUntil) return;
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

  // ---------------------------------------------------------------------------
  // Tab drag-sorting (HTML5 drag & drop inside #tabs-bar)
  // ---------------------------------------------------------------------------

  /**
   * Show the 2px insertion indicator on a tab, left or right half.
   * @param {HTMLElement|null} el
   * @param {'before'|'after'|null} side
   */
  function setDropIndicator(el, side) {
    if (dropIndicatorEl === el && dropIndicatorSide === side) return;

    if (dropIndicatorEl && dropIndicatorEl.classList) {
      dropIndicatorEl.classList.remove('drop-before', 'drop-after');
    }

    dropIndicatorEl = el || null;
    dropIndicatorSide = side || null;

    if (dropIndicatorEl && dropIndicatorSide) {
      dropIndicatorEl.classList.add(dropIndicatorSide === 'before' ? 'drop-before' : 'drop-after');
    }
  }

  /**
   * Finish / cancel a tab drag: clear indicator classes and the dragged state.
   */
  function endTabDrag() {
    draggingTabId = null;
    setDropIndicator(null, null);

    const tabsBar = document.getElementById('tabs-bar');
    if (tabsBar) {
      Array.prototype.forEach.call(tabsBar.querySelectorAll('.tab-item.dragging'), (el) => {
        el.classList.remove('dragging');
      });
    }

    // Swallow the synthetic click that some WebKit builds emit after a drop.
    suppressTabClickUntil = Date.now() + 120;
  }

  function handleTabDragStart(event, tab) {
    if (!event || !tab || !tab.id) return;

    // Never start a tab drag from the close button.
    if (event.target && event.target.closest && event.target.closest('.tab-close-btn')) {
      event.preventDefault();
      return;
    }

    draggingTabId = tab.id;
    dropIndicatorEl = null;
    dropIndicatorSide = null;
    suppressTabClickUntil = Date.now() + 600;

    if (event.dataTransfer) {
      try {
        event.dataTransfer.effectAllowed = 'move';
      } catch (err) {
        // Some WebKit builds expose a read-only dataTransfer here.
      }
      try {
        event.dataTransfer.setData('text/plain', tab.id);
      } catch (err) {
        // ignore
      }
    }

    const tabEl = event.currentTarget;
    if (tabEl && tabEl.classList) {
      // Let the browser capture the drag image before dimming the source.
      setTimeout(() => {
        if (draggingTabId === tab.id) {
          tabEl.classList.add('dragging');
        }
      }, 0);
    }

    // An internal tab drag must never show the file-drop overlay.
    setDropOverlayVisible(false);
  }

  function handleTabsBarDragOver(event) {
    if (!draggingTabId) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.dataTransfer) {
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch (err) {
        // ignore
      }
    }

    const targetEl = event.target && event.target.closest
      ? event.target.closest('.tab-item')
      : null;
    const targetId = targetEl ? targetEl.getAttribute('data-id') : null;

    if (targetEl && targetId === draggingTabId) {
      setDropIndicator(null, null);
      return;
    }

    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const side = event.clientX >= rect.left + rect.width / 2 ? 'after' : 'before';
      setDropIndicator(targetEl, side);
      return;
    }

    // Pointer over the empty part of the bar: indicate a drop at the end.
    const tabsBar = event.currentTarget;
    const candidates = tabsBar
      ? Array.prototype.slice.call(tabsBar.querySelectorAll('.tab-item:not(.dragging)'))
      : [];
    const last = candidates.length > 0 ? candidates[candidates.length - 1] : null;
    setDropIndicator(last, last ? 'after' : null);
  }

  function handleTabsBarDragLeave(event) {
    if (!draggingTabId) return;
    const tabsBar = event.currentTarget;
    const related = event.relatedTarget;
    if (related && tabsBar && tabsBar.contains(related)) return;
    setDropIndicator(null, null);
  }

  function handleTabsBarDrop(event) {
    if (!draggingTabId) return;

    event.preventDefault();
    event.stopPropagation();

    const draggedId = draggingTabId;
    const targetEl = event.target && event.target.closest
      ? event.target.closest('.tab-item')
      : null;
    const targetId = targetEl ? targetEl.getAttribute('data-id') : null;
    const state = window.AppStore && typeof window.AppStore.getState === 'function'
      ? window.AppStore.getState()
      : null;
    const tabs = state && Array.isArray(state.tabs) ? state.tabs : [];

    if (!draggedId || tabs.length === 0) {
      endTabDrag();
      return;
    }

    // Compute the insertion index against the list with the dragged tab
    // removed, so the final index is independent of drag direction.
    const remaining = tabs.filter((tab) => tab.id !== draggedId);
    let insertionIndex = null;

    if (targetEl && targetId && targetId !== draggedId) {
      const targetIndex = remaining.findIndex((tab) => tab.id === targetId);
      if (targetIndex !== -1) {
        const rect = targetEl.getBoundingClientRect();
        const dropAfter = event.clientX >= rect.left + rect.width / 2;
        insertionIndex = targetIndex + (dropAfter ? 1 : 0);
      }
    } else if (!targetEl) {
      insertionIndex = remaining.length;
    }

    // moveTab emits tab:reordered; the AppBus listener re-renders only the
    // tab bar. No editor / document state is touched here.
    if (insertionIndex !== null) {
      window.AppStore.moveTab(draggedId, insertionIndex);
    }

    endTabDrag();
  }

  /**
   * Delegated drag listeners live on #tabs-bar itself, so rebuilding the tab
   * items never leaves stale handler state behind.
   */
  function initTabDragSorting() {
    const tabsBar = document.getElementById('tabs-bar');
    if (!tabsBar) return;

    tabsBar.addEventListener('dragover', handleTabsBarDragOver);
    tabsBar.addEventListener('dragleave', handleTabsBarDragLeave);
    tabsBar.addEventListener('drop', handleTabsBarDrop);
    tabsBar.addEventListener('dragend', endTabDrag);
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
      // Explicitly re-opening an already-open file bumps it to the front of
      // the recent list (no duplicate entry).
      recordRecentFile(existing.path, existing.name);
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

        // Only files with a real path are tracked; untitled drafts never are.
        recordRecentFile(newTab.path, newTab.name);

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

  const VALID_EDITOR_MODES = ['reader', 'ir', 'sv', 'wysiwyg'];
  let restoreInProgress = false;

  function basenameOf(filePath) {
    if (!filePath) return '未命名.md';
    const parts = String(filePath).split(/[/\\]/);
    return parts[parts.length - 1] || '未命名.md';
  }

  function toastSession(message, type) {
    if (window.AppBus) {
      window.AppBus.emit('notify:toast', { message, type: type || 'info' });
    }
  }

  /**
   * Restore the previous session: re-open every remembered tab in order,
   * re-apply dirty buffers without touching disk, skip files that no longer
   * exist (recovering their unsaved content as a scratch tab), then restore
   * the active tab, workspace and editor mode.
   *
   * Missing / recovered tabs are reported in a single aggregated toast.
   * @param {object} session Session snapshot from SessionManager/BridgeClient
   */
  async function restoreSession(session) {
    if (restoreInProgress) return;
    restoreInProgress = true;

    const state = session && typeof session === 'object' ? session : {};
    const entries = Array.isArray(state.tabs) ? state.tabs : [];
    const missing = [];
    const recovered = [];
    const restored = [];

    try {
      if (!window.AppStore || entries.length === 0) {
        // Nothing to restore; the finally block still reports completion.
        return;
      }

      // Which entry should end up active after the restore?
      let activeIndex = -1;
      if (state.active_path) {
        activeIndex = entries.findIndex((e) => e && e.path === state.active_path);
      }
      if (activeIndex === -1 && state.active_name) {
        activeIndex = entries.findIndex((e) => e && !e.path && e.name === state.active_name);
      }
      if (activeIndex === -1) {
        activeIndex = entries.findIndex((e) => e && e.path);
      }

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || typeof entry !== 'object') continue;

        const entryPath = typeof entry.path === 'string' && entry.path ? entry.path : null;
        const entryName = typeof entry.name === 'string' && entry.name
          ? entry.name
          : basenameOf(entryPath);
        const hasDirtyContent = !!(entry.dirty && typeof entry.content === 'string');
        const scrollTop = typeof entry.scrollTop === 'number' ? entry.scrollTop : 0;

        let tab = null;

        if (!entryPath) {
          // Scratch tab (or a previously recovered draft): the only copy of
          // the content lives in the session snapshot.
          const content = typeof entry.content === 'string' ? entry.content : '';
          tab = window.AppStore.addTab({
            path: null,
            name: entryName,
            content,
            savedContent: typeof entry.savedContent === 'string' ? entry.savedContent : content,
            scrollTop,
            dirty: !!entry.dirty,
          });
        } else {
          let readRes = null;
          try {
            readRes = await window.BridgeClient.readFile(entryPath);
          } catch (err) {
            readRes = null;
          }
          const isOk = readRes && (readRes.ok || readRes.success);

          if (isOk) {
            const fileData = readRes.data || readRes;
            const diskContent = typeof fileData.content === 'string' ? fileData.content : '';
            const useDirtyBuffer = hasDirtyContent && entry.content !== diskContent;

            tab = window.AppStore.addTab({
              path: fileData.path || entryPath,
              name: fileData.name || entryName,
              content: useDirtyBuffer ? entry.content : diskContent,
              savedContent: diskContent,
              mtime: fileData.mtime || Date.now() / 1000,
              scrollTop,
              dirty: useDirtyBuffer,
            });

            // Duplicate path in the snapshot: addTab returns the existing tab,
            // so re-apply the dirty buffer explicitly.
            if (tab && useDirtyBuffer) {
              tab.content = entry.content;
              tab.savedContent = diskContent;
              tab.dirty = true;
            }

            // Restored files count as opened, but preserveExisting keeps the
            // previous recency order across launches.
            if (tab && tab.path) {
              recordRecentFile(tab.path, tab.name, { preserveExisting: true });
            }
          } else if (hasDirtyContent) {
            // The file is gone but the buffer had unsaved edits: keep the data
            // as a path-less "recovered" dirty tab instead of dropping it.
            const recoveredName = /已恢复/.test(entryName)
              ? entryName
              : `${entryName}（已恢复）`;
            tab = window.AppStore.addTab({
              path: null,
              name: recoveredName,
              content: entry.content,
              savedContent: '',
              scrollTop,
              dirty: true,
            });
            recovered.push(entryName);
          } else {
            missing.push(entryName);
            continue;
          }
        }

        if (tab) {
          restored.push({ index: i, tab });
        }
      }

      // Activate the tab that was active when the session was saved.
      let targetTab = null;
      if (activeIndex >= 0) {
        const match = restored.find((item) => item.index === activeIndex);
        if (match) targetTab = match.tab;
      }
      if (!targetTab && restored.length > 0) {
        targetTab = restored[restored.length - 1].tab;
      }

      if (targetTab) {
        window.AppStore.setActiveTab(targetTab.id);
      }
      renderTabsBar({ scrollActive: true });
      if (targetTab && window.AppBus) {
        window.AppBus.emit('tab:switched', { tab: { ...targetTab } });
      }

      // Restore workspace directory (FileTree owns AppStore.workspaceDir).
      if (typeof state.workspace_dir === 'string' && state.workspace_dir && window.AppBus) {
        window.AppBus.emit('folder:open-request', { path: state.workspace_dir });
      }

      // Restore editor mode (reader / ir / sv / wysiwyg).
      if (VALID_EDITOR_MODES.indexOf(state.editor_mode) !== -1 && window.AppBus) {
        window.AppBus.emit('editor:mode-change-request', { mode: state.editor_mode });
      }

      if (targetTab && targetTab.scrollTop > 0 && window.AppBus) {
        const scrollTop = targetTab.scrollTop;
        setTimeout(() => {
          window.AppBus.emit('editor:scroll-to', { scrollTop });
        }, 250);
      }

      if (missing.length > 0 || recovered.length > 0) {
        const parts = [];
        if (missing.length > 0) {
          parts.push(`已跳过 ${missing.length} 个已不存在或无法读取的文件`);
        }
        if (recovered.length > 0) {
          parts.push(`${recovered.length} 个未保存标签已恢复为「已恢复」草稿`);
        }
        toastSession(parts.join('；'), missing.length > 0 ? 'warning' : 'info');
      }
    } catch (err) {
      console.error('[TabManager] Session restore failed:', err);
      toastSession('恢复上次会话失败，已打开可用标签', 'warning');
    } finally {
      restoreInProgress = false;
      if (window.AppBus) {
        window.AppBus.emit('session:restore-complete', {
          restored: restored.length,
          missing,
          recovered,
        });
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

        // A newly saved draft gains a real path; record it once without
        // reshuffling files that are already in the recent list.
        recordRecentFile(tab.path, tab.name, { preserveExisting: true });

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
          recordRecentFile(currentActive.path, currentActive.name, { preserveExisting: true });

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
      // Internal tab reordering must never raise the file-drop overlay.
      if (draggingTabId) return;
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth += 1;
      showDropOverlay();
    });

    window.addEventListener('dragover', (e) => {
      if (draggingTabId) return;
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
      if (draggingTabId) return;
      if (!isFileDrag(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setDropOverlayVisible(false);
      }
    });

    window.addEventListener('drop', (e) => {
      if (draggingTabId) return;
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

      // 2. Setup file drag & drop, tab drag-sorting and the recent-files UI
      initDragAndDrop();
      initTabDragSorting();
      bindRecentFilesUI();

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

        // Restore the previous session (dispatched by app.js at bootstrap).
        window.AppBus.on('session:restore', (payload) => {
          const session = payload && payload.session ? payload.session : payload;
          restoreSession(session);
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

        // Structural change only: reorder the existing .tab-item nodes. The
        // editor, active tab and dirty state are deliberately untouched.
        window.AppBus.on('tab:reordered', () => {
          renderTabsBar();
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

    getRecentFiles() {
      return getRecentFiles();
    },

    openRecentPopover() {
      setRecentPopoverOpen(true);
    },
  };

  window.TabManager = TabManager;
})();
