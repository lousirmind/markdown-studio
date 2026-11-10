/**
 * CommandPalette Module
 * Unified Quick Open (Cmd/Ctrl+P) + Command Palette (Cmd/Ctrl+Shift+P).
 *
 * Quick Open:
 *  - Builds an in-memory index of the workspace from BridgeClient.listDir()'s
 *    recursive tree (one disk read per workspace open, never per keystroke).
 *  - Fuzzy-matches .md / .markdown / .mdown / .txt files by filename and
 *    relative path, prioritising filename hits and recently opened files.
 *  - Opens the selected file through AppBus 'file:open-request'.
 *
 * Command Palette:
 *  - Registry of { id, title, keywords, shortcut, run } descriptors. Every
 *    command dispatches through an existing AppBus event, AppStore mutation or
 *    public module API; no business logic is duplicated here.
 *  - The same overlay is reused; typing a leading ">" in Quick Open switches
 *    to command mode.
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore,
 * window.BridgeClient and the other modules' public APIs.
 */
(function () {
  'use strict';

  const MAX_RESULTS = 50;
  const RECENT_PREF_KEY = 'recentFiles';
  const PREF_SAVE_DEBOUNCE_MS = 400;
  const FILE_EXTENSIONS = ['.md', '.markdown', '.mdown', '.txt'];

  const IS_MAC =
    /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') ||
    /Mac OS X/.test(navigator.userAgent || '');
  const SHORTCUTS = {
    save: IS_MAC ? '⌘S' : 'Ctrl+S',
    find: IS_MAC ? '⌘F' : 'Ctrl+F',
    sidebar: IS_MAC ? '⌘B' : 'Ctrl+B',
    openFolder: IS_MAC ? '⇧⌘O' : 'Ctrl+Shift+O',
    settings: IS_MAC ? '⌘,' : 'Ctrl+,',
    quickOpen: IS_MAC ? '⌘P' : 'Ctrl+P',
    commandPalette: IS_MAC ? '⇧⌘P' : 'Ctrl+Shift+P',
  };

  const state = {
    open: false,
    mode: 'files', // 'files' | 'commands'
    query: '',
    activeIndex: 0,
    results: [],
    optionEls: [],
    totalMatches: 0,
    // Workspace index
    workspace: null,
    files: [],
    indexedWorkspace: null,
    indexLoaded: false,
    indexToken: 0,
    indexInFlight: null,
    loading: false,
    error: null,
    // Ranking helpers
    recentOrder: new Map(),
  };

  let dom = {};
  let prefSaveTimer = null;
  let commands = [];

  /* ==========================================================================
     Small helpers
     ========================================================================== */

  function normalizePath(p) {
    return typeof p === 'string' ? p.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  }

  function basenameOf(p) {
    const norm = normalizePath(p);
    const idx = norm.lastIndexOf('/');
    return idx === -1 ? norm : norm.slice(idx + 1);
  }

  function extOf(name) {
    const idx = String(name || '').lastIndexOf('.');
    return idx === -1 ? '' : String(name).slice(idx).toLowerCase();
  }

  function isSupportedFile(name) {
    const lower = String(name || '').toLowerCase();
    return FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function relativePathOf(filePath, workspace) {
    const p = normalizePath(filePath);
    const ws = normalizePath(workspace);
    if (!ws) return p;
    if (p === ws) return basenameOf(p);
    if (p.indexOf(ws + '/') === 0) return p.slice(ws.length + 1);
    return p;
  }

  function stopImmediate(e) {
    if (e && typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }
  }

  function reportError(message, error) {
    console.error('[CommandPalette]', message, error);
  }

  function toast(message, type) {
    if (window.AppBus) {
      window.AppBus.emit('notify:toast', { message, type: type || 'info' });
    }
  }

  /* ==========================================================================
     Fuzzy matching
     ========================================================================== */

  function fuzzyMatch(query, text) {
    if (!query) return { score: 0, indices: [] };
    if (!text) return null;

    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (q.length > t.length) return null;

    let score = 0;
    let ti = 0;
    let last = -1;
    let streak = 0;
    const indices = [];

    for (let qi = 0; qi < q.length; qi++) {
      const ch = q.charAt(qi);
      const idx = t.indexOf(ch, ti);
      if (idx === -1) return null;

      if (idx === last + 1) {
        streak += 1;
        score += 6 + streak * 3;
      } else {
        streak = 0;
        score += 4;
      }

      if (idx === 0) {
        score += 14;
      } else {
        const prev = t.charAt(idx - 1);
        if (prev === '/' || prev === '\\' || prev === ' ' || prev === '_' || prev === '-' || prev === '.') {
          score += 10;
        }
        const cur = t.charAt(idx);
        const prevRaw = text.charAt(idx - 1);
        if (cur >= 'a' && cur <= 'z' && prevRaw >= 'A' && prevRaw <= 'Z') {
          score += 8;
        }
      }

      indices.push(idx);
      last = idx;
      ti = idx + 1;
    }

    // Prefer compact matches over very long haystacks.
    score -= Math.min(24, Math.floor(t.length / 8));
    return { score: Math.max(1, score), indices };
  }

  /**
   * Score one indexed file against the query.
   * Filename hits are intentionally worth more than path-only hits.
   * @returns {{score: number, nameIndices: number[], recentRank: number}|null}
   */
  function scoreFile(file, query) {
    if (!query) {
      const recentRank = state.recentOrder.has(file.path)
        ? state.recentOrder.get(file.path)
        : -1;
      return { score: 0, nameIndices: [], recentRank };
    }

    const nameMatch = fuzzyMatch(query, file.nameLower);
    const relMatch = fuzzyMatch(query, file.relLower);
    if (!nameMatch && !relMatch) return null;

    let score = 0;
    let nameIndices = [];

    if (nameMatch) {
      score = nameMatch.score + 35; // filename hits win over path-only hits
      nameIndices = nameMatch.indices;
    }
    if (relMatch && relMatch.score > score) {
      score = relMatch.score;
    }

    if (nameMatch) {
      if (file.nameLower === query) score += 150;
      else if (file.nameLower.indexOf(query) === 0) score += 90;
      else if (file.nameLower.indexOf(query) !== -1) score += 45;
    }
    if (file.relLower.indexOf(query) !== -1) score += 12;

    const recentRank = state.recentOrder.has(file.path)
      ? state.recentOrder.get(file.path)
      : -1;
    if (recentRank >= 0) {
      // Strong but not absolute boost: an exactly-matching non-recent file can
      // still outrank a weak subsequence hit in a recent file.
      score += Math.max(6, 120 - recentRank * 6);
    }

    return { score, nameIndices, recentRank };
  }

  /**
   * Score one command descriptor against the query.
   * Title matches rank above keyword/id matches.
   */
  function scoreCommand(command, query) {
    if (!query) return { score: 0, titleIndices: [] };

    const titleMatch = fuzzyMatch(query, command.titleLower);
    let score = titleMatch ? titleMatch.score + 30 : -1;
    let titleIndices = titleMatch ? titleMatch.indices : [];

    for (let i = 0; i < command.keywordsLower.length; i++) {
      const match = fuzzyMatch(query, command.keywordsLower[i]);
      if (match && match.score > score) {
        score = match.score;
      }
    }

    const idMatch = fuzzyMatch(query, command.idLower);
    if (idMatch && idMatch.score > score) {
      score = idMatch.score;
    }

    if (score < 0) return null;

    if (command.titleLower === query) score += 120;
    else if (command.titleLower.indexOf(query) === 0) score += 80;
    else if (command.titleLower.indexOf(query) !== -1) score += 40;

    return { score, titleIndices };
  }

  /* ==========================================================================
     Workspace index
     ========================================================================== */

  function collectFiles(nodes, workspace, out, seen) {
    if (!Array.isArray(nodes)) return;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || typeof node !== 'object') continue;

      const isDir = !!(node.is_dir || node.isDir);
      if (isDir) {
        collectFiles(node.children, workspace, out, seen);
        continue;
      }

      const name = String(node.name || '');
      const fullPath = normalizePath(node.path || '');
      if (!name || !fullPath) continue;
      if (name.charAt(0) === '.') continue; // hidden files stay out of Quick Open
      if (!isSupportedFile(name)) continue;
      if (seen.has(fullPath)) continue;

      seen.add(fullPath);

      const relPath = relativePathOf(fullPath, workspace);
      const slash = relPath.lastIndexOf('/');
      const relDir = slash === -1 ? '' : relPath.slice(0, slash);

      out.push({
        path: fullPath,
        name,
        ext: extOf(name),
        relPath,
        dirLabel: relDir ? relDir + '/' : '工作区根目录',
        nameLower: name.toLowerCase(),
        relLower: relPath.toLowerCase(),
      });
    }
  }

  function buildIndex(workspace, force) {
    const target = normalizePath(workspace);
    if (!target) return Promise.resolve([]);

    if (!force && state.indexInFlight && state.indexInFlight.workspace === target) {
      return state.indexInFlight.promise;
    }
    if (!force && state.indexLoaded && state.indexedWorkspace === target) {
      return Promise.resolve(state.files);
    }

    const token = ++state.indexToken;
    state.workspace = target;
    state.loading = true;
    state.error = null;

    const promise = (async () => {
      try {
        if (!window.BridgeClient || typeof window.BridgeClient.listDir !== 'function') {
          throw new Error('BridgeClient.listDir 不可用');
        }

        const res = await window.BridgeClient.listDir(target, false, 'name', true);
        if (token !== state.indexToken) return state.files;

        const isOk = res && (res.ok === true || res.success === true) && !res.error;
        if (!isOk) {
          throw new Error((res && res.error) || '读取工作区目录失败');
        }

        const data = res.data && typeof res.data === 'object' ? res.data : res;
        let nodes = [];
        if (Array.isArray(data.tree)) nodes = data.tree;
        else if (Array.isArray(data.items)) nodes = data.items; // browser mock bridge
        else if (Array.isArray(res.tree)) nodes = res.tree;
        else if (Array.isArray(res.items)) nodes = res.items;

        const files = [];
        collectFiles(nodes, target, files, new Set());

        files.sort(
          (a, b) =>
            a.nameLower.localeCompare(b.nameLower) ||
            a.relLower.localeCompare(b.relLower)
        );

        state.files = files;
        state.indexedWorkspace = target;
        state.indexLoaded = true;
        state.error = null;
        return state.files;
      } catch (err) {
        if (token === state.indexToken) {
          state.files = [];
          state.indexedWorkspace = null;
          state.indexLoaded = false;
          state.error = (err && err.message) || String(err);
        }
        reportError('Failed to build workspace index:', err);
        return [];
      } finally {
        if (token === state.indexToken) {
          state.loading = false;
          if (state.open) renderResults();
        }
      }
    })();

    state.indexInFlight = { workspace: target, promise };
    promise.then(() => {
      if (state.indexInFlight && state.indexInFlight.promise === promise) {
        state.indexInFlight = null;
      }
    });

    return promise;
  }

  function ensureIndex() {
    const storeState =
      window.AppStore && typeof window.AppStore.getState === 'function'
        ? window.AppStore.getState()
        : null;
    const storeWorkspace = normalizePath((storeState && storeState.workspaceDir) || '');
    const target = storeWorkspace || normalizePath(state.workspace);

    if (!target) {
      state.workspace = null;
      state.files = [];
      state.indexedWorkspace = null;
      state.indexLoaded = true;
      state.loading = false;
      return Promise.resolve([]);
    }

    if (state.indexedWorkspace && state.indexedWorkspace !== target) {
      state.files = [];
      state.indexLoaded = false;
    }

    state.workspace = target;
    return buildIndex(target, false);
  }

  function refreshRecentOrder() {
    const order = new Map();
    const prefs =
      window.AppStore && typeof window.AppStore.getState === 'function'
        ? window.AppStore.getState().preferences
        : null;
    const recent = prefs ? prefs[RECENT_PREF_KEY] : null;

    if (Array.isArray(recent)) {
      recent.forEach((entry, index) => {
        const path =
          typeof entry === 'string' ? entry : entry && typeof entry.path === 'string' ? entry.path : '';
        const norm = normalizePath(path);
        if (norm && !order.has(norm)) {
          order.set(norm, index);
        }
      });
    }

    state.recentOrder = order;
  }

  function handleFolderOpenRequest(payload) {
    const path = normalizePath(payload && payload.path);
    if (!path) return;

    // Invalidate any in-flight scan for the previous workspace.
    state.indexToken++;
    state.workspace = path;
    state.files = [];
    state.indexedWorkspace = null;
    state.indexLoaded = false;
    state.error = null;
    state.loading = true;

    if (state.open) renderResults();
    buildIndex(path, true);
  }

  /* ==========================================================================
     Command registry
     ========================================================================== */

  function getActiveTab() {
    if (window.AppStore && typeof window.AppStore.getActiveTab === 'function') {
      return window.AppStore.getActiveTab();
    }
    return null;
  }

  function clickById(id) {
    const el = document.getElementById(id);
    if (el && typeof el.click === 'function') {
      el.click();
      return true;
    }
    return false;
  }

  function setEditorMode(mode) {
    if (window.AppBus) {
      window.AppBus.emit('editor:mode-change-request', { mode });
    }
  }

  function persistPreferencesSoon() {
    if (!window.BridgeClient || typeof window.BridgeClient.savePreferences !== 'function') {
      return;
    }
    if (!window.AppStore || typeof window.AppStore.getState !== 'function') return;

    if (prefSaveTimer) clearTimeout(prefSaveTimer);
    prefSaveTimer = setTimeout(async () => {
      prefSaveTimer = null;
      try {
        const prefs = window.AppStore.getState().preferences;
        await window.BridgeClient.savePreferences(prefs);
      } catch (err) {
        reportError('Failed to persist preferences:', err);
      }
    }, PREF_SAVE_DEBOUNCE_MS);
  }

  function setPreference(key, value) {
    if (!window.AppStore || typeof window.AppStore.updatePreference !== 'function') return;
    window.AppStore.updatePreference(key, value);
    persistPreferencesSoon();
  }

  function closeActiveTab() {
    const tab = getActiveTab();
    if (!tab) {
      toast('没有可关闭的标签页', 'info');
      return;
    }
    if (window.TabManager && typeof window.TabManager.close === 'function') {
      window.TabManager.close(tab.id);
    } else if (window.AppStore && typeof window.AppStore.closeTab === 'function') {
      window.AppStore.closeTab(tab.id);
    }
  }

  function cycleTab(delta) {
    if (!window.AppStore || typeof window.AppStore.getState !== 'function') return;

    const storeState = window.AppStore.getState();
    const tabs = Array.isArray(storeState.tabs) ? storeState.tabs : [];
    if (tabs.length === 0) {
      toast('没有已打开的标签页', 'info');
      return;
    }
    if (tabs.length === 1) {
      toast('只有一个标签页', 'info');
      return;
    }

    let index = tabs.findIndex((tab) => tab.id === storeState.activeTabId);
    if (index === -1) index = 0;
    const nextIndex = ((index + delta) % tabs.length + tabs.length) % tabs.length;
    window.AppStore.setActiveTab(tabs[nextIndex].id);
  }

  function saveCurrentFile() {
    if (window.TabManager && typeof window.TabManager.saveCurrent === 'function') {
      const result = window.TabManager.saveCurrent();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => reportError('Save failed:', err));
      }
      return;
    }
    clickById('btn-save-file');
  }

  function openFindReplace() {
    if (window.SearchReplace && typeof window.SearchReplace.open === 'function') {
      window.SearchReplace.open({ focus: true });
      return;
    }
    clickById('btn-search');
  }

  function openRecentFiles() {
    if (window.TabManager && typeof window.TabManager.openRecentPopover === 'function') {
      window.TabManager.openRecentPopover();
      return;
    }
    clickById('btn-recent-files');
  }

  function exportPdf() {
    if (window.ExporterStatus && typeof window.ExporterStatus.exportPdf === 'function') {
      const result = window.ExporterStatus.exportPdf();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => reportError('PDF export failed:', err));
      }
      return;
    }
    clickById('btn-export-pdf');
  }

  function buildCommands() {
    const list = [
      {
        id: 'view.mode.reader',
        title: '切换到阅读模式',
        keywords: ['reader', 'read', 'pure', '阅读', '阅读模式', '纯阅读'],
        run() {
          setEditorMode('reader');
        },
      },
      {
        id: 'view.mode.ir',
        title: '切换到即时渲染模式（IR）',
        keywords: ['ir', 'instant', 'rendering', '即时', '渲染', '即时渲染'],
        run() {
          setEditorMode('ir');
        },
      },
      {
        id: 'view.mode.sv',
        title: '切换到分屏模式（SV）',
        keywords: ['sv', 'split', 'split view', '分屏', '对比', '源码'],
        run() {
          setEditorMode('sv');
        },
      },
      {
        id: 'view.mode.wysiwyg',
        title: '切换到富文本模式（WYSIWYG）',
        keywords: ['wysiwyg', 'rich', 'rich text', '富文本', '所见即所得', 'typora'],
        run() {
          setEditorMode('wysiwyg');
        },
      },
      {
        id: 'theme.auto',
        title: '主题：跟随系统',
        keywords: ['theme', 'auto', 'system', '主题', '跟随系统', '自动'],
        run() {
          setPreference('theme', 'auto');
        },
      },
      {
        id: 'theme.light',
        title: '主题：浅色',
        keywords: ['theme', 'light', 'day', '主题', '浅色', '明亮'],
        run() {
          setPreference('theme', 'light');
        },
      },
      {
        id: 'theme.dark',
        title: '主题：深色',
        keywords: ['theme', 'dark', 'night', '主题', '深色', '黑夜'],
        run() {
          setPreference('theme', 'dark');
        },
      },
      {
        id: 'view.toggle-sidebar',
        title: '切换侧边栏',
        keywords: ['sidebar', 'toggle sidebar', '侧边栏', '侧栏', '隐藏侧栏'],
        shortcut: SHORTCUTS.sidebar,
        run() {
          clickById('btn-toggle-sidebar');
        },
      },
      {
        id: 'file.save',
        title: '保存当前文件',
        keywords: ['save', '保存', '保存文件', '写入'],
        shortcut: SHORTCUTS.save,
        run() {
          saveCurrentFile();
        },
      },
      {
        id: 'edit.find-replace',
        title: '查找替换',
        keywords: ['find', 'replace', 'search', '查找', '替换', '查找替换'],
        shortcut: SHORTCUTS.find,
        restoreEditorFocus: false,
        run() {
          openFindReplace();
        },
      },
      {
        id: 'file.recent',
        title: '最近文件',
        keywords: ['recent', 'recent files', 'history', '最近', '最近文件', '历史'],
        restoreEditorFocus: false,
        run() {
          openRecentFiles();
        },
      },
      {
        id: 'file.open-folder',
        title: '打开文件夹…',
        keywords: ['open folder', 'folder', 'workspace', '打开文件夹', '工作区', '切换工作区'],
        shortcut: SHORTCUTS.openFolder,
        restoreEditorFocus: false,
        run() {
          clickById('btn-open-folder');
        },
      },
      {
        id: 'export.html',
        title: '导出独立 HTML…',
        keywords: ['export html', 'html', 'export', '导出', '独立 html', '网页'],
        restoreEditorFocus: false,
        run() {
          clickById('btn-export-html');
        },
      },
      {
        id: 'export.pdf',
        title: '导出 PDF（当前设置）…',
        keywords: ['export pdf', 'pdf', 'print', '导出', '打印', 'pdf 设置'],
        restoreEditorFocus: false,
        run() {
          exportPdf();
        },
      },
      {
        id: 'tab.close',
        title: '关闭当前标签页',
        keywords: ['close tab', 'close', 'tab', '关闭', '关闭标签', '关闭当前标签'],
        run() {
          closeActiveTab();
        },
      },
      {
        id: 'tab.next',
        title: '下一个标签页',
        keywords: ['next tab', 'tab', 'next', '下一个', '下一个标签'],
        run() {
          cycleTab(1);
        },
      },
      {
        id: 'tab.previous',
        title: '上一个标签页',
        keywords: ['previous tab', 'prev tab', 'tab', 'previous', '上一个', '上一个标签'],
        run() {
          cycleTab(-1);
        },
      },
      {
        id: 'app.settings',
        title: '打开外观与排版设置',
        keywords: ['settings', 'preferences', 'appearance', '设置', '偏好', '外观'],
        shortcut: SHORTCUTS.settings,
        restoreEditorFocus: false,
        run() {
          clickById('btn-toggle-settings');
        },
      },
    ];

    return list.map((command) => ({
      ...command,
      titleLower: command.title.toLowerCase(),
      idLower: command.id.toLowerCase(),
      keywordsLower: (command.keywords || []).map((keyword) => String(keyword).toLowerCase()),
    }));
  }

  /* ==========================================================================
     Rendering
     ========================================================================== */

  function appendHighlighted(container, text, indices) {
    if (!indices || indices.length === 0) {
      container.textContent = text;
      return;
    }

    const marks = new Set(indices.filter((index) => index >= 0 && index < text.length));
    if (marks.size === 0) {
      container.textContent = text;
      return;
    }

    let buffer = '';
    let inMark = false;
    let markEl = null;

    for (let i = 0; i < text.length; i++) {
      const isMark = marks.has(i);
      if (isMark !== inMark) {
        if (buffer) {
          if (markEl) markEl.textContent += buffer;
          else container.appendChild(document.createTextNode(buffer));
          buffer = '';
        }
        if (isMark) {
          markEl = document.createElement('span');
          markEl.className = 'cp-match';
          container.appendChild(markEl);
        }
        inMark = isMark;
        if (!isMark) markEl = null;
      }
      buffer += text.charAt(i);
    }

    if (buffer) {
      if (markEl) markEl.textContent += buffer;
      else container.appendChild(document.createTextNode(buffer));
    }
  }

  function renderEmpty(title, hint) {
    if (!dom.list) return;
    dom.list.innerHTML = '';
    state.optionEls = [];

    const empty = document.createElement('div');
    empty.className = 'cp-empty';

    const titleEl = document.createElement('div');
    titleEl.className = 'cp-empty-title';
    titleEl.textContent = title;
    empty.appendChild(titleEl);

    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'cp-empty-hint';
      hintEl.textContent = hint;
      empty.appendChild(hintEl);
    }

    dom.list.appendChild(empty);
  }

  function renderList(results) {
    if (!dom.list) return;

    dom.list.innerHTML = '';
    state.optionEls = [];
    const fragment = document.createDocumentFragment();

    results.forEach((entry, index) => {
      const el = document.createElement('div');
      el.className = 'cp-item';
      el.id = 'cp-option-' + index;
      el.dataset.index = String(index);
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', 'false');

      const icon = document.createElement('span');
      icon.className = 'cp-item-icon';
      icon.setAttribute('aria-hidden', 'true');

      const main = document.createElement('div');
      main.className = 'cp-item-main';

      const title = document.createElement('div');
      title.className = 'cp-item-title';

      const sub = document.createElement('div');
      sub.className = 'cp-item-sub';

      const extra = document.createElement('span');
      extra.className = 'cp-item-extra';

      if (entry.type === 'file') {
        icon.textContent = entry.file.ext === '.txt' ? '📄' : '📝';
        appendHighlighted(title, entry.file.name, entry.nameIndices);
        sub.textContent = entry.file.dirLabel;
        if (entry.recentRank >= 0) {
          const badge = document.createElement('span');
          badge.className = 'cp-item-badge';
          badge.textContent = '最近';
          extra.appendChild(badge);
        }
      } else {
        icon.textContent = '⌘';
        appendHighlighted(title, entry.command.title, entry.titleIndices);
        if (entry.command.shortcut) {
          extra.textContent = entry.command.shortcut;
        }
      }

      main.appendChild(title);
      if (sub.textContent) main.appendChild(sub);

      el.appendChild(icon);
      el.appendChild(main);
      el.appendChild(extra);

      el.addEventListener('mouseenter', () => setActiveIndex(index, false));
      el.addEventListener('mousedown', (event) => event.preventDefault());
      el.addEventListener('click', () => {
        setActiveIndex(index, false, true);
        activateIndex(index);
      });

      state.optionEls.push(el);
      fragment.appendChild(el);
    });

    dom.list.appendChild(fragment);
  }

  function updateFooter() {
    if (!dom.count) return;

    if (state.mode === 'files') {
      if (!state.workspace) {
        dom.count.textContent = '未打开工作区';
        return;
      }
      if (state.query.trim()) {
        dom.count.textContent =
          state.totalMatches + ' 个匹配' + (state.totalMatches > MAX_RESULTS ? '（显示前 50）' : '');
      } else {
        dom.count.textContent = state.files.length + ' 个文件';
      }
      return;
    }

    dom.count.textContent =
      state.totalMatches + ' 条命令' + (state.totalMatches > MAX_RESULTS ? '（显示前 50）' : '');
  }

  function renderResults() {
    if (!dom.list) return;
    refreshRecentOrder();

    const query = state.query.trim();

    if (state.mode === 'files') {
      if (!state.workspace) {
        renderEmpty('未打开工作区', '使用「打开文件夹…」命令选择一个目录');
        state.results = [];
        state.totalMatches = 0;
        updateFooter();
        return;
      }
      if (!state.indexLoaded && state.loading) {
        renderEmpty('正在索引工作区…', '首次索引只读取一次目录');
        state.results = [];
        state.totalMatches = 0;
        updateFooter();
        return;
      }
      if (state.error) {
        renderEmpty('无法读取工作区目录', state.error);
        state.results = [];
        state.totalMatches = 0;
        updateFooter();
        return;
      }

      const lowerQuery = query.toLowerCase();
      const matched = [];

      for (let i = 0; i < state.files.length; i++) {
        const file = state.files[i];
        const scored = scoreFile(file, lowerQuery);
        if (!scored) continue;
        matched.push({
          type: 'file',
          file,
          score: scored.score,
          nameIndices: scored.nameIndices,
          recentRank: scored.recentRank,
        });
      }

      matched.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.recentRank !== b.recentRank) {
          if (a.recentRank < 0) return 1;
          if (b.recentRank < 0) return -1;
          return a.recentRank - b.recentRank;
        }
        return (
          a.file.nameLower.localeCompare(b.file.nameLower) ||
          a.file.relLower.localeCompare(b.file.relLower)
        );
      });

      state.totalMatches = matched.length;
      state.results = matched.slice(0, MAX_RESULTS);

      if (state.results.length === 0) {
        renderEmpty(
          query ? '无匹配文件' : '工作区中没有 Markdown / 文本文件',
          query ? '换个关键词试试' : '支持 .md / .markdown / .mdown / .txt'
        );
      } else {
        renderList(state.results);
      }
    } else {
      const lowerQuery = query.toLowerCase();
      const matched = [];

      for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        const scored = scoreCommand(command, lowerQuery);
        if (!scored) continue;
        matched.push({
          type: 'command',
          command,
          score: scored.score,
          titleIndices: scored.titleIndices,
        });
      }

      matched.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.command.titleLower.localeCompare(b.command.titleLower);
      });

      state.totalMatches = matched.length;
      state.results = matched.slice(0, MAX_RESULTS);

      if (state.results.length === 0) {
        renderEmpty('无匹配命令', '试试「主题」「分屏」「保存」等关键词');
      } else {
        renderList(state.results);
      }
    }

    const max = state.results.length - 1;
    state.activeIndex = max < 0 ? -1 : Math.min(state.activeIndex, max);
    if (state.activeIndex < 0) state.activeIndex = max < 0 ? -1 : 0;

    updateActiveClasses();
    updateFooter();
  }

  function updateActiveClasses() {
    for (let i = 0; i < state.optionEls.length; i++) {
      const el = state.optionEls[i];
      const isActive = i === state.activeIndex;
      el.classList.toggle('active', isActive);
      el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (dom.input && state.activeIndex >= 0) {
      dom.input.setAttribute('aria-activedescendant', 'cp-option-' + state.activeIndex);
    } else if (dom.input) {
      dom.input.removeAttribute('aria-activedescendant');
    }
  }

  function setActiveIndex(index, scroll, force) {
    if (!state.results.length) {
      state.activeIndex = -1;
      updateActiveClasses();
      return;
    }
    if (!force && index === state.activeIndex) {
      if (scroll && state.optionEls[index]) {
        state.optionEls[index].scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    const length = state.results.length;
    state.activeIndex = ((index % length) + length) % length;
    updateActiveClasses();

    if (scroll !== false && state.optionEls[state.activeIndex]) {
      state.optionEls[state.activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSelection(delta) {
    if (!state.results.length) return;
    setActiveIndex(state.activeIndex + delta, true);
  }

  function updateModeChrome() {
    if (dom.root) dom.root.dataset.paletteMode = state.mode;
    if (dom.input) {
      dom.input.placeholder =
        state.mode === 'commands'
          ? '输入命令…（模式、主题、导出等）'
          : '输入文件名或路径…（输入 > 可切换命令模式）';
      dom.input.setAttribute(
        'aria-label',
        state.mode === 'commands' ? '搜索命令' : '搜索工作区文件'
      );
    }
    if (dom.modeLabel) {
      dom.modeLabel.textContent = state.mode === 'commands' ? '命令' : '文件';
    }
    if (dom.modeIcon) {
      dom.modeIcon.textContent = state.mode === 'commands' ? '⌘' : '⌕';
    }
    if (dom.list) {
      dom.list.setAttribute(
        'aria-label',
        state.mode === 'commands' ? '命令列表' : '文件列表'
      );
    }
  }

  /* ==========================================================================
     Open / close / activation
     ========================================================================== */

  function focusInput(selectAll) {
    const run = () => {
      if (!state.open || !dom.input) return;
      try {
        dom.input.focus();
        if (selectAll) dom.input.select();
        else {
          const length = dom.input.value.length;
          dom.input.setSelectionRange(length, length);
        }
      } catch (err) {
        // Focus is best-effort; never let it break the palette.
      }
    };
    run();
    setTimeout(run, 0);
  }

  function focusEditor() {
    if (window.EditorEngine && typeof window.EditorEngine.focus === 'function') {
      try {
        window.EditorEngine.focus();
      } catch (err) {
        reportError('EditorEngine.focus failed:', err);
      }
    }

    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;

    const fallback = document.querySelector(
      '#vditor-container .vditor-reset [contenteditable="true"], #vditor-container .vditor-reset'
    );
    if (fallback && typeof fallback.focus === 'function') {
      try {
        fallback.focus({ preventScroll: true });
      } catch (err) {
        // ignore
      }
    }
  }

  function openPalette(mode) {
    if (!dom.root) return false;

    const nextMode = mode === 'commands' ? 'commands' : 'files';
    const wasOpen = state.open;

    if (wasOpen && state.mode === nextMode) {
      focusInput(true);
      return true;
    }

    state.open = true;
    state.mode = nextMode;
    state.query = '';
    state.activeIndex = 0;

    if (dom.input) {
      dom.input.value = '';
      dom.input.setAttribute('aria-expanded', 'true');
    }
    dom.root.classList.remove('hidden');
    dom.root.setAttribute('aria-hidden', 'false');
    if (dom.button) {
      dom.button.classList.add('active');
      dom.button.setAttribute('aria-expanded', 'true');
    }

    updateModeChrome();
    refreshRecentOrder();
    renderResults();
    focusInput(false);

    ensureIndex().then(() => {
      if (state.open) renderResults();
    });

    return true;
  }

  function closePalette(options) {
    if (!state.open) return;
    const opts = options || {};

    state.open = false;
    state.query = '';
    state.activeIndex = 0;
    state.results = [];
    state.optionEls = [];

    if (dom.root) {
      dom.root.classList.add('hidden');
      dom.root.setAttribute('aria-hidden', 'true');
    }
    if (dom.input) {
      dom.input.setAttribute('aria-expanded', 'false');
      try {
        dom.input.blur();
      } catch (err) {
        // ignore
      }
    }
    if (dom.button) {
      dom.button.classList.remove('active');
      dom.button.setAttribute('aria-expanded', 'false');
    }

    if (opts.restoreFocus !== false) {
      focusEditor();
      setTimeout(focusEditor, 30);
    }
  }

  function executeCommand(command) {
    if (!command) return;

    const restoreFocus = command.restoreEditorFocus !== false;
    closePalette({ restoreFocus: false });

    try {
      const result = command.run();
      if (result && typeof result.then === 'function') {
        result.catch((err) => {
          reportError('Command failed: ' + command.id, err);
          toast('命令执行失败：' + command.title, 'error');
        });
      }
    } catch (err) {
      reportError('Command failed: ' + command.id, err);
      toast('命令执行失败：' + command.title, 'error');
    }

    if (restoreFocus) {
      focusEditor();
      setTimeout(focusEditor, 30);
    }
  }

  function openFileResult(file) {
    if (!file) return;
    closePalette({ restoreFocus: true });
    if (window.AppBus) {
      window.AppBus.emit('file:open-request', { path: file.path });
    }
  }

  function activateIndex(index) {
    const targetIndex = typeof index === 'number' ? index : state.activeIndex;
    const entry = state.results[targetIndex];
    if (!entry) return;

    if (entry.type === 'file') openFileResult(entry.file);
    else executeCommand(entry.command);
  }

  function activateActive() {
    activateIndex(state.activeIndex);
  }

  /* ==========================================================================
     Events
     ========================================================================== */

  function handleInput() {
    if (!dom.input) return;

    let raw = dom.input.value;

    if (state.mode === 'files' && raw.charAt(0) === '>') {
      state.mode = 'commands';
      raw = raw.slice(1).replace(/^\s+/, '');
      dom.input.value = raw;
      try {
        const length = raw.length;
        dom.input.setSelectionRange(length, length);
      } catch (err) {
        // ignore
      }
      updateModeChrome();
    }

    state.query = raw;
    state.activeIndex = 0;
    renderResults();
  }

  function handleGlobalKeydown(event) {
    if (!event || typeof event.key !== 'string') return;
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;

    if (state.open) {
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        event.stopPropagation();
        stopImmediate(event);
        closePalette({ restoreFocus: true });
        return;
      }

      if (!mod && !event.altKey) {
        if (key === 'arrowdown') {
          event.preventDefault();
          event.stopPropagation();
          moveSelection(1);
          return;
        }
        if (key === 'arrowup') {
          event.preventDefault();
          event.stopPropagation();
          moveSelection(-1);
          return;
        }
        if (key === 'enter' && !event.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          event.stopPropagation();
          activateActive();
          return;
        }
      }
    }

    if (mod && key === 'p') {
      event.preventDefault();
      event.stopPropagation();
      stopImmediate(event);
      if (event.shiftKey) openPalette('commands');
      else openPalette('files');
    }
  }

  function cacheDom() {
    dom.root = document.getElementById('command-palette');
    dom.panel = dom.root ? dom.root.querySelector('.cp-panel') : null;
    dom.backdrop = dom.root ? dom.root.querySelector('.cp-backdrop') : null;
    dom.input = document.getElementById('cp-input');
    dom.list = document.getElementById('cp-list');
    dom.count = document.getElementById('cp-count');
    dom.close = document.getElementById('cp-close');
    dom.modeLabel = document.getElementById('cp-mode-label');
    dom.modeIcon = document.getElementById('cp-mode-icon');
    dom.button = document.getElementById('btn-command-palette');
  }

  function bindEvents() {
    if (dom.button) {
      dom.button.addEventListener('click', () => {
        openPalette('files');
      });
    }
    if (dom.close) {
      dom.close.addEventListener('click', () => closePalette({ restoreFocus: true }));
    }
    if (dom.backdrop) {
      dom.backdrop.addEventListener('click', () => closePalette({ restoreFocus: true }));
    }
    if (dom.input) {
      dom.input.addEventListener('input', handleInput);
      dom.input.addEventListener('compositionstart', () => {
        // IME composition is handled naturally: filtering still uses the
        // composed value, and Enter during composition is ignored above.
      });
    }

    window.addEventListener('keydown', handleGlobalKeydown, true);

    if (window.AppBus) {
      window.AppBus.on('folder:open-request', (payload) => {
        handleFolderOpenRequest(payload);
      });
    }
  }

  const CommandPalette = {
    init() {
      cacheDom();
      if (!dom.root) {
        console.warn('[CommandPalette] #command-palette not found; module disabled.');
        return;
      }

      commands = buildCommands();
      bindEvents();

      // Pick up a workspace that was already hydrated before this module init.
      refreshRecentOrder();
      if (window.AppStore && typeof window.AppStore.getState === 'function') {
        const workspace = normalizePath(window.AppStore.getState().workspaceDir || '');
        if (workspace) buildIndex(workspace, false);
      }
    },

    open(mode) {
      return openPalette(mode);
    },

    openFiles() {
      return openPalette('files');
    },

    openCommands() {
      return openPalette('commands');
    },

    close(options) {
      closePalette(options);
    },

    isOpen() {
      return state.open;
    },

    getMode() {
      return state.mode;
    },

    /**
     * Read-only snapshot used by acceptance tests and future modules.
     */
    getState() {
      return {
        open: state.open,
        mode: state.mode,
        query: state.query,
        activeIndex: state.activeIndex,
        resultCount: state.results.length,
        totalMatches: state.totalMatches,
        indexSize: state.files.length,
        indexedWorkspace: state.indexedWorkspace,
        workspace: state.workspace,
        loading: state.loading,
        error: state.error,
        results: state.results.map((entry) =>
          entry.type === 'file'
            ? {
                type: 'file',
                path: entry.file.path,
                name: entry.file.name,
                relPath: entry.file.relPath,
                dirLabel: entry.file.dirLabel,
                score: entry.score,
                recentRank: entry.recentRank,
              }
            : {
                type: 'command',
                id: entry.command.id,
                title: entry.command.title,
                shortcut: entry.command.shortcut || '',
                score: entry.score,
              }
        ),
      };
    },

    listCommands() {
      return commands.map((command) => ({
        id: command.id,
        title: command.title,
        shortcut: command.shortcut || '',
      }));
    },

    refreshIndex() {
      state.indexToken++;
      state.indexInFlight = null;
      state.indexLoaded = false;
      state.indexedWorkspace = null;
      state.files = [];
      state.error = null;
      return ensureIndex().then((files) => {
        if (state.open) renderResults();
        return files;
      });
    },

    shortcuts: {
      quickOpen: SHORTCUTS.quickOpen,
      commandPalette: SHORTCUTS.commandPalette,
    },
  };

  window.CommandPalette = CommandPalette;
})();
