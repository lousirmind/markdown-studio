/**
 * ExporterStatus Module
 * Responsible for updating bottom status bar metrics (active document path,
 * save state, word/char/line count, estimated reading time, editor mode label),
 * exporting standalone HTML, high-quality vector PDF printing,
 * toast notification banner system, and global keyboard shortcuts.
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore,
 * and window.BridgeClient.
 */
(function () {
  'use strict';

  // Mode label mapping
  const MODE_LABELS = {
    reader: '纯阅读',
    ir: '即时渲染',
    sv: '双栏分屏',
    wysiwyg: '所见即所得',
  };

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
   * Calculate text statistics
   */
  function calculateStats(text) {
    if (!text || typeof text !== 'string') {
      return {
        words: 0,
        chars: 0,
        lines: 1,
        readTimeMin: 1,
      };
    }

    const cjkMatches = text.match(/[\u4e00-\u9fa5]/g) || [];
    const enWords = text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_\-]+/g) || [];
    const totalWords = cjkMatches.length + enWords.length;
    const totalChars = text.length;
    const totalLines = text.split('\n').length;
    const readTimeMin = Math.max(1, Math.ceil(totalWords / 300));

    return {
      words: totalWords,
      chars: totalChars,
      lines: totalLines,
      readTimeMin,
    };
  }

  // ---------------- 状态栏刷新合并（P2-7） ----------------
  let statusUpdateScheduled = false;
  let statusFallbackTimer = null;
  let statsCacheText = null;
  let statsCacheResult = null;

  /**
   * 统计结果缓存：同一内容字符串只做一次全文正则统计。
   */
  function getStats(text) {
    const value = typeof text === 'string' ? text : '';
    if (statsCacheText === value && statsCacheResult) {
      return statsCacheResult;
    }
    const result = calculateStats(value);
    statsCacheText = value;
    statsCacheResult = result;
    return result;
  }

  /**
   * rAF 合并：一帧内多次事件只刷新一次状态栏（带超时兜底）。
   */
  function scheduleStatusBarUpdate() {
    if (statusUpdateScheduled) return;
    statusUpdateScheduled = true;

    const run = () => {
      if (!statusUpdateScheduled) return;
      statusUpdateScheduled = false;
      if (statusFallbackTimer) {
        clearTimeout(statusFallbackTimer);
        statusFallbackTimer = null;
      }
      updateStatusBar();
    };

    requestAnimationFrame(run);
    statusFallbackTimer = setTimeout(run, 100);
  }

  /**
   * 仅在文本真正变化时写入，避免状态栏高频刷新产生大量 DOM 变更
   */
  function setTextIfChanged(el, text) {
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  /**
   * 仅在 title 真正变化时写入
   */
  function setTitleIfChanged(el, title) {
    if (el && el.getAttribute('title') !== title) {
      el.title = title;
    }
  }

  /**
   * Update bottom status bar UI elements
   */
  function updateStatusBar() {
    if (!window.AppStore || typeof window.AppStore.getActiveTab !== 'function') return;

    const activeTab = window.AppStore.getActiveTab();
    const storeState = window.AppStore.getState();
    const currentMode = storeState.editorMode || 'ir';

    // 1. File Path
    const pathEl = document.getElementById('status-file-path');
    if (pathEl) {
      const pathText = activeTab
        ? activeTab.path || activeTab.name || '未命名.md'
        : '未打开文档';
      setTextIfChanged(pathEl, pathText);
      setTitleIfChanged(pathEl, activeTab ? pathText : '');
    }

    // 2. Save State
    // 容器 #status-save-state 必须同步切换 saved / unsaved 类，否则颜色永远是绿色。
    // 内层 span 只负责文案，颜色由容器类 + .status-dirty/.status-saved 共同决定。
    const saveStateEl = document.getElementById('status-save-state');
    if (saveStateEl) {
      const isDirty = !!(activeTab && activeTab.dirty);

      saveStateEl.classList.add('status-item');
      saveStateEl.classList.toggle('unsaved', isDirty);
      saveStateEl.classList.toggle('saved', !isDirty);

      // 避免每次事件都重写 innerHTML（会产生大量 DOM 变更），仅在状态真正变化时更新
      const nextState = isDirty ? 'dirty' : 'saved';
      if (saveStateEl.getAttribute('data-save-state') !== nextState) {
        saveStateEl.setAttribute('data-save-state', nextState);
        if (isDirty) {
          saveStateEl.innerHTML = '<span class="status-dirty">● 未保存修改</span>';
          saveStateEl.title = '文档包含未保存的修改';
        } else {
          saveStateEl.innerHTML = '<span class="status-saved">已保存</span>';
          saveStateEl.title = '文档内容与磁盘同步';
        }
      }
    }

    // 3. Document statistics
    const stats = getStats(activeTab ? activeTab.content : '');

    const wordEl = document.getElementById('status-word-count');
    if (wordEl) {
      setTextIfChanged(wordEl, `${stats.words} 词`);
      setTitleIfChanged(wordEl, `总词数 (汉字 + 英文单词): ${stats.words}`);
    }

    const charEl = document.getElementById('status-char-count');
    if (charEl) {
      setTextIfChanged(charEl, `${stats.chars} 字符`);
      setTitleIfChanged(charEl, `总字符数: ${stats.chars}`);
    }

    const lineEl = document.getElementById('status-line-count');
    if (lineEl) {
      setTextIfChanged(lineEl, `${stats.lines} 行`);
      setTitleIfChanged(lineEl, `总行数: ${stats.lines}`);
    }

    const readTimeEl = document.getElementById('status-read-time');
    if (readTimeEl) {
      setTextIfChanged(readTimeEl, `约 ${stats.readTimeMin} 分钟`);
      setTitleIfChanged(readTimeEl, `按每分钟 300 词估算阅读耗时: 约 ${stats.readTimeMin} 分钟`);
    }

    // 4. Editor Mode Label
    const modeEl = document.getElementById('status-mode-label');
    if (modeEl) {
      const modeLabel = MODE_LABELS[currentMode] || currentMode;
      setTextIfChanged(modeEl, modeLabel);
      setTitleIfChanged(modeEl, `当前排版模式: ${modeLabel}`);
    }
  }

  /**
   * Export standalone HTML document with self-contained typography and styling
   */
  async function handleExportHtml() {
    if (!window.BridgeClient) return;

    let htmlContent = '';
    if (window.EditorEngine && typeof window.EditorEngine.getHTML === 'function') {
      try {
        htmlContent = await window.EditorEngine.getHTML();
      } catch (e) {
        console.warn('[ExporterStatus] getHTML error:', e);
      }
    }

    if (!htmlContent) {
      const renderEl =
        document.querySelector('.vditor-reset') ||
        document.querySelector('#vditor .vditor-reset') ||
        document.querySelector('.vditor-preview');
      if (renderEl) {
        htmlContent = renderEl.innerHTML;
      }
    }

    const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
    const docTitle = activeTab ? activeTab.name.replace(/\.(md|markdown|mdown|txt)$/i, '') : 'Markdown Document';

    // Assemble full standalone HTML
    const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(docTitle)}</title>
  <style>
    :root {
      --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    body {
      font-family: var(--font-family);
      line-height: 1.68;
      color: #24292f;
      background-color: #ffffff;
      padding: 40px 24px;
      margin: 0;
    }
    .markdown-body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 900px;
      margin: 0 auto;
    }
    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {
      margin-top: 24px;
      margin-bottom: 16px;
      font-weight: 600;
      line-height: 1.25;
    }
    .markdown-body h1 { font-size: 2em; border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
    .markdown-body h2 { font-size: 1.5em; border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
    .markdown-body h3 { font-size: 1.25em; }
    .markdown-body p, .markdown-body blockquote, .markdown-body ul, .markdown-body ol, .markdown-body dl, .markdown-body table, .markdown-body pre {
      margin-top: 0;
      margin-bottom: 16px;
    }
    .markdown-body code {
      padding: .2em .4em;
      margin: 0;
      font-size: 85%;
      background-color: rgba(175, 184, 193, 0.2);
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    .markdown-body pre {
      padding: 16px;
      overflow: auto;
      font-size: 85%;
      line-height: 1.45;
      background-color: #f6f8fa;
      border-radius: 6px;
    }
    .markdown-body pre code {
      padding: 0;
      background-color: transparent;
    }
    .markdown-body blockquote {
      padding: 0 1em;
      color: #57606a;
      border-left: .25em solid #d0d7de;
    }
    .markdown-body table {
      border-spacing: 0;
      border-collapse: collapse;
      width: 100%;
      margin-bottom: 16px;
    }
    .markdown-body table th, .markdown-body table td {
      padding: 6px 13px;
      border: 1px solid #d0d7de;
    }
    .markdown-body table tr:nth-child(2n) {
      background-color: #f6f8fa;
    }
    .markdown-body img {
      max-width: 100%;
      box-sizing: border-box;
    }
    @media (prefers-color-scheme: dark) {
      body {
        color: #c9d1d9;
        background-color: #0d1117;
      }
      .markdown-body h1, .markdown-body h2 { border-color: #30363d; }
      .markdown-body code { background-color: rgba(110, 118, 129, 0.4); }
      .markdown-body pre { background-color: #161b22; }
      .markdown-body blockquote { color: #8b949e; border-color: #30363d; }
      .markdown-body table th, .markdown-body table td { border-color: #30363d; }
      .markdown-body table tr:nth-child(2n) { background-color: #161b22; }
    }
  </style>
</head>
<body>
  <article class="markdown-body">
    ${htmlContent}
  </article>
</body>
</html>`;

    try {
      const defaultName = `${docTitle}.html`;
      const res = await window.BridgeClient.exportHtmlDialog(defaultName, fullHtml);
      const isOk = res && (res.ok || res.success);

      if (isOk) {
        const targetPath = res.path || (res.data && res.data.path);
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', {
            message: `HTML 文件已成功导出: ${targetPath ? targetPath.split(/[/\\]/).pop() : defaultName}`,
            type: 'success',
          });
        }
      }
    } catch (err) {
      console.error('[ExporterStatus] Export HTML error:', err);
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', {
          message: `导出 HTML 失败: ${err.message}`,
          type: 'error',
        });
      }
    }
  }

  /**
   * Switch to reader mode (the print layout) before native PDF export.
   * Returns the previous mode so the caller can restore it afterwards.
   */
  async function prepareReaderForPdfExport() {
    const store = window.AppStore ? window.AppStore.getState() : {};
    const prevMode = store.editorMode || 'ir';
    if (prevMode === 'reader') return null;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      if (window.AppBus) {
        const off = window.AppBus.on('editor:rendered', () => {
          off();
          finish();
        });
        window.AppBus.emit('editor:mode-change-request', { mode: 'reader' });
      } else {
        finish();
      }

      // Never block the export when the preview is slow.
      setTimeout(finish, 3000);
    });

    // Let fonts, embedded images and layout settle before WebKit paginates.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)));
    });

    return prevMode;
  }

  function restoreEditorMode(prevMode) {
    if (!prevMode || prevMode === 'reader') return;
    if (window.AppBus) {
      window.AppBus.emit('editor:mode-change-request', { mode: prevMode });
    }
  }

  /**
   * Export the current document to a paginated A4 PDF through the native
   * WKWebView print pipeline. Falls back to window.print() in browser mock mode.
   */
  async function handleExportPdf() {
    const bridgeAvailable =
      window.BridgeClient && typeof window.BridgeClient.exportPdf === 'function';

    if (!bridgeAvailable) {
      window.print();
      return;
    }

    const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
    const docTitle = activeTab
      ? (activeTab.name || 'document').replace(/\.(md|markdown|mdown|txt)$/i, '')
      : 'document';
    const defaultName = `${docTitle || 'document'}.pdf`;

    let prevMode = null;
    try {
      prevMode = await prepareReaderForPdfExport();
      const startRes = await window.BridgeClient.exportPdf(defaultName);
      const started = startRes && (startRes.ok || startRes.success);
      if (!started) {
        const startError = (startRes && startRes.error) || '';
        if (!/cancel/i.test(startError) && window.AppBus) {
          window.AppBus.emit('notify:toast', {
            message: startError || 'PDF 导出失败',
            type: 'error',
          });
        }
        return;
      }

      // Native printing runs on the Cocoa main thread after this bridge call
      // returns; poll the export state instead of blocking the WebKit handler.
      let finalRes = null;
      if (typeof window.BridgeClient.getPdfExportResult === 'function') {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          const polled = await window.BridgeClient.getPdfExportResult();
          const state = (polled && (polled.data || polled)) || {};
          if (state.status === 'done' || state.status === 'error') {
            finalRes = state.result || state;
            break;
          }
        }
      }

      const startData = (startRes.data || startRes) || {};
      const data = finalRes ? (finalRes.data || finalRes) : startData;
      const isOk = finalRes ? !!(finalRes.ok || finalRes.success) : false;
      const errorMsg = (finalRes && finalRes.error) || (finalRes ? '' : 'PDF 导出超时');

      if (isOk) {
        const targetPath = data.path || startData.path || '';
        const pages = data.pages;
        const fileName = targetPath ? targetPath.split(/[/\\]/).pop() : defaultName;
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', {
            message: `PDF 已导出${pages ? `（${pages} 页）` : ''}: ${fileName}`,
            type: 'success',
          });
        }
      } else if (!/cancel/i.test(errorMsg)) {
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', {
            message: errorMsg || 'PDF 导出失败',
            type: 'error',
          });
        }
      }
    } catch (err) {
      console.error('[ExporterStatus] Export PDF error:', err);
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', {
          message: `PDF 导出失败: ${err.message || err}`,
          type: 'error',
        });
      }
    } finally {
      restoreEditorMode(prevMode);
    }
  }

  /**
   * Toast notification system
   */
  function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;

    const icons = {
      info: 'ℹ',
      success: '✓',
      warning: '⚠',
      error: '✕',
    };

    const iconSpan = document.createElement('span');
    iconSpan.className = 'toast-icon';
    iconSpan.textContent = icons[type] || 'ℹ';
    toast.appendChild(iconSpan);

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-message';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close-btn';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      removeToast(toast);
    });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    // Auto dismiss after 3200ms
    const timer = setTimeout(() => {
      removeToast(toast);
    }, 3200);

    function removeToast(el) {
      clearTimeout(timer);
      el.classList.add('toast-fade-out');
      setTimeout(() => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }, 300);
    }
  }

  /**
   * Global Keyboard Shortcuts
   */
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (!modKey) return;

      const key = e.key.toLowerCase();

      // Cmd/Ctrl + Shift + O : Open Folder
      if (e.shiftKey && key === 'o') {
        e.preventDefault();
        const btnOpenFolder = document.getElementById('btn-open-folder');
        if (btnOpenFolder) btnOpenFolder.click();
        return;
      }

      // Cmd/Ctrl + O : Open File
      if (!e.shiftKey && key === 'o') {
        e.preventDefault();
        const btnOpenFile = document.getElementById('btn-open-file');
        if (btnOpenFile) btnOpenFile.click();
        return;
      }

      // Cmd/Ctrl + S : Save File
      if (!e.shiftKey && key === 's') {
        e.preventDefault();
        const btnSaveFile = document.getElementById('btn-save-file');
        if (btnSaveFile) {
          btnSaveFile.click();
        } else if (window.TabManager && typeof window.TabManager.saveCurrent === 'function') {
          window.TabManager.saveCurrent();
        }
        return;
      }

      // Cmd/Ctrl + E : Fast Toggle Reader / IR mode
      if (!e.shiftKey && key === 'e') {
        e.preventDefault();
        const store = window.AppStore ? window.AppStore.getState() : {};
        const currentMode = store.editorMode || 'ir';
        const targetMode = currentMode === 'reader' ? 'ir' : 'reader';
        if (window.AppBus) {
          window.AppBus.emit('editor:mode-change-request', { mode: targetMode });
        }
        return;
      }

      // Cmd/Ctrl + B : Toggle Sidebar
      if (!e.shiftKey && key === 'b') {
        e.preventDefault();
        const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
        if (btnToggleSidebar) btnToggleSidebar.click();
        return;
      }

      // Cmd/Ctrl + , : Toggle Appearance Settings Drawer
      if (!e.shiftKey && key === ',') {
        e.preventDefault();
        const btnToggleSettings = document.getElementById('btn-toggle-settings');
        if (btnToggleSettings) btnToggleSettings.click();
        return;
      }
    });
  }

  const ExporterStatus = {
    init() {
      // 1. Bind export buttons
      const btnExportHtml = document.getElementById('btn-export-html');
      if (btnExportHtml) {
        btnExportHtml.addEventListener('click', handleExportHtml);
      }

      const btnExportPdf = document.getElementById('btn-export-pdf');
      if (btnExportPdf) {
        btnExportPdf.addEventListener('click', handleExportPdf);
      }

      // 2. Setup keyboard shortcuts
      initKeyboardShortcuts();

      // 3. Register AppBus events
      if (window.AppBus) {
        // 所有状态变更事件统一走 rAF 合并，避免每个事件都重算全文统计 + 重写 DOM
        window.AppBus.on('tab:switched', () => scheduleStatusBarUpdate());
        window.AppBus.on('tab:activated', () => scheduleStatusBarUpdate());
        window.AppBus.on('tab:content-updated', () => scheduleStatusBarUpdate());
        window.AppBus.on('editor:content-changed', () => scheduleStatusBarUpdate());
        window.AppBus.on('file:saved', () => scheduleStatusBarUpdate());
        window.AppBus.on('editor:mode-changed', (payload) => {
          if (payload && payload.mode && window.AppStore) {
            window.AppStore.setState({ editorMode: payload.mode });
          }
          scheduleStatusBarUpdate();
        });

        // Toast notifications
        window.AppBus.on('notify:toast', (payload) => {
          if (payload && payload.message) {
            showToast(payload.message, payload.type || 'info');
          }
        });
      }

      // 4. Initial status bar update
      updateStatusBar();
    },

    toast(message, type = 'info') {
      showToast(message, type);
    },

    update() {
      updateStatusBar();
    },
  };

  window.ExporterStatus = ExporterStatus;
})();
