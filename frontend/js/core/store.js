/**
 * Store - Centralized state manager for Markdown Studio.
 * Exposes window.AppStore and notifies state changes via AppBus.
 */
(function () {
  'use strict';

  const DEFAULT_PREFERENCES = {
    theme: 'auto',
    codeTheme: 'github',
    fontFamily: 'sans',
    fontSize: 16,
    maxWidth: '1000px',
    centered: true,
    autoSave: true,
    autoRefresh: true,
    showHiddenFiles: false,
    sortBy: 'name',
    sortAsc: true,
    customCss: '',
  };

  const state = {
    tabs: [], // Array of { id, path, name, content, savedContent, mtime, scrollTop, dirty }
    activeTabId: null,
    workspaceDir: null,
    editorMode: 'ir', // 'reader' | 'ir' | 'sv' | 'wysiwyg'
    sidebarVisible: true,
    sidebarTab: 'toc', // 'toc' | 'files'
    settingsVisible: false,
    preferences: { ...DEFAULT_PREFERENCES },
  };

  const AppStore = {
    /**
     * Get a shallow copy of the state tree.
     * @returns {object} Current state
     */
    getState() {
      return {
        ...state,
        tabs: [...state.tabs],
        preferences: { ...state.preferences },
      };
    },

    /**
     * Update partial top-level state and emit 'store:changed'.
     * @param {object} partial
     */
    setState(partial) {
      if (!partial || typeof partial !== 'object') return;

      const changedKeys = [];
      for (const [key, val] of Object.entries(partial)) {
        if (state[key] !== val) {
          state[key] = val;
          changedKeys.push(key);
        }
      }

      if (changedKeys.length > 0 && window.AppBus) {
        window.AppBus.emit('store:changed', {
          changedKeys,
          partial,
          state: this.getState(),
        });
      }
    },

    /**
     * Retrieve the currently active tab object.
     * @returns {object|null}
     */
    getActiveTab() {
      if (!state.activeTabId) return null;
      return state.tabs.find((t) => t.id === state.activeTabId) || null;
    },

    /**
     * Update active tab content and recalculate dirty state.
     *
     * Content/dirty state has a single owner: this method. Callers may reach it
     * from several places (editor input, auto-save scheduling, checkbox
     * toggles), so identical content is a no-op and emits no event. That keeps
     * the keystroke path to one store write + one targeted tab-bar update.
     *
     * @param {string} content
     * @returns {object|null} Updated active tab
     */
    updateActiveTabContent(content) {
      const activeTab = this.getActiveTab();
      if (!activeTab) return null;

      const nextContent = typeof content === 'string' ? content : '';
      if (activeTab.content === nextContent) {
        return activeTab;
      }

      const prevDirty = activeTab.dirty;
      activeTab.content = nextContent;
      activeTab.dirty = activeTab.content !== activeTab.savedContent;

      if (window.AppBus) {
        window.AppBus.emit('tab:content-updated', {
          tab: { ...activeTab },
          dirty: activeTab.dirty,
          dirtyChanged: prevDirty !== activeTab.dirty,
        });
      }

      return activeTab;
    },

    /**
     * Batch update user preferences and emit 'prefs:changed'.
     * @param {object} prefs Partial or complete preferences
     */
    setPreferences(prefs) {
      if (!prefs || typeof prefs !== 'object') return;

      Object.assign(state.preferences, prefs);

      if (window.AppBus) {
        window.AppBus.emit('prefs:changed', {
          preferences: { ...state.preferences },
        });
      }
    },

    /**
     * Update a single preference key-value pair.
     * @param {string} key
     * @param {any} value
     */
    updatePreference(key, value) {
      if (!key) return;

      state.preferences[key] = value;

      if (window.AppBus) {
        window.AppBus.emit('prefs:changed', {
          key,
          value,
          preferences: { ...state.preferences },
        });
      }
    },

    /**
     * Add a new tab or activate existing tab if path matches.
     * @param {object} tabData { id, path, name, content, savedContent, mtime, scrollTop, dirty }
     * @returns {object} The added or existing tab
     */
    addTab(tabData) {
      if (!tabData) return null;

      // Check if file is already open
      const existing = tabData.path
        ? state.tabs.find((t) => t.path === tabData.path)
        : null;

      if (existing) {
        this.setActiveTab(existing.id);
        return existing;
      }

      const id = tabData.id || `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newTab = {
        id,
        path: tabData.path || null,
        name: tabData.name || (tabData.path ? tabData.path.split(/[/\\]/).pop() : '未命名.md'),
        content: tabData.content || '',
        savedContent: tabData.savedContent !== undefined ? tabData.savedContent : (tabData.content || ''),
        mtime: tabData.mtime || Date.now() / 1000,
        scrollTop: tabData.scrollTop || 0,
        dirty: !!tabData.dirty,
      };

      state.tabs.push(newTab);
      state.activeTabId = newTab.id;

      if (window.AppBus) {
        window.AppBus.emit('tab:added', { tab: { ...newTab } });
        window.AppBus.emit('tab:activated', { tab: { ...newTab } });
      }

      return newTab;
    },

    /**
     * Switch active tab by ID.
     * @param {string} tabId
     */
    setActiveTab(tabId) {
      const target = state.tabs.find((t) => t.id === tabId);
      if (!target || state.activeTabId === tabId) return;

      state.activeTabId = tabId;

      if (window.AppBus) {
        window.AppBus.emit('tab:activated', { tab: { ...target } });
      }
    },

    /**
     * Close a tab by ID.
     * @param {string} tabId
     * @returns {boolean} Whether tab was closed
     */
    closeTab(tabId) {
      const index = state.tabs.findIndex((t) => t.id === tabId);
      if (index === -1) return false;

      const [removed] = state.tabs.splice(index, 1);

      if (state.activeTabId === tabId) {
        // Activate adjacent tab
        const nextActive = state.tabs[index] || state.tabs[index - 1] || null;
        state.activeTabId = nextActive ? nextActive.id : null;

        if (window.AppBus) {
          window.AppBus.emit('tab:closed', { tab: removed });
          if (nextActive) {
            window.AppBus.emit('tab:activated', { tab: { ...nextActive } });
          } else {
            window.AppBus.emit('tab:activated', { tab: null });
          }
        }
      } else {
        if (window.AppBus) {
          window.AppBus.emit('tab:closed', { tab: removed });
        }
      }

      return true;
    },

    /**
     * Mark a tab as saved on disk.
     * @param {string} tabId
     * @param {number} [mtime]
     */
    markTabSaved(tabId, mtime) {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      tab.savedContent = tab.content;
      tab.dirty = false;
      if (typeof mtime === 'number') {
        tab.mtime = mtime;
      }

      if (window.AppBus) {
        window.AppBus.emit('tab:saved', { tab: { ...tab } });
        window.AppBus.emit('tab:content-updated', { tab: { ...tab }, dirty: false });
      }
    },
  };

  window.AppStore = AppStore;
})();
