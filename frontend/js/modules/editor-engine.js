/**
 * EditorEngine - Decoupled Vditor-based Markdown Editing & Reading Engine.
 * Supports 4 modes ('reader', 'ir', 'sv', 'wysiwyg'), offline CDN assets,
 * relative local image resolution, clipboard image pasting, and render events.
 */
(function () {
  'use strict';

  let vditorInstance = null;
  let isVditorReady = false;
  let pendingContent = null;
  let pendingMode = null;
  let currentMode = 'ir';
  let vditorContainerEl = null;
  let readerScrollWrapEl = null;
  let readerContainerEl = null;
  let isRenderingReader = false;
  let renderDebounceTimer = null;

  // TOC/MdEnhancer refresh debounce. 120ms keeps typing from rebuilding the
  // outline on every keystroke while staying well inside E2E wait budgets.
  const RENDER_DEBOUNCE_MS = 120;

  // Reader render de-duplication + serialization. Vditor.preview rewrites
  // #reader-container, so concurrent calls would interleave DOM; only one
  // render runs at a time and at most one newer request is queued.
  let lastReaderRenderSignature = '';
  let queuedReaderRender = null;

  // Guard against tab:activated + tab:switched (and save/refresh echoes)
  // applying the same tab content to Vditor more than once.
  let lastEditorTabId = null;
  let lastEditorPath = null;
  let lastEditorContent = null;

  // Latest editor theme actually applied to the Vditor instance.
  let lastAppliedThemeKey = null;

  // Cache of absolute local image path -> { dataUrl, ts } for bridge reads.
  const imageDataUrlCache = new Map();
  const IMAGE_FAILURE_RETRY_MS = 10000;

  /**
   * Normalize a local filesystem path: collapses '.', '..' and duplicate
   * separators while preserving POSIX / Windows drive prefixes.
   * @param {string} rawPath
   * @returns {string}
   */
  function normalizeLocalPath(rawPath) {
    const unified = String(rawPath || '').replace(/\\/g, '/');
    const driveMatch = unified.match(/^([A-Za-z]:)(\/?)/);
    const prefix = driveMatch ? driveMatch[1] : '';
    const rest = driveMatch ? unified.slice(driveMatch[0].length) : unified;
    const isAbsolute = rest.charAt(0) === '/';
    const segments = [];

    rest.split('/').forEach((segment) => {
      if (!segment || segment === '.') return;
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') {
          segments.pop();
        } else if (!isAbsolute) {
          segments.push('..');
        }
        return;
      }
      segments.push(segment);
    });

    const body = segments.join('/');
    if (prefix) return prefix + (isAbsolute ? '/' : '') + body;
    return (isAbsolute ? '/' : '') + body;
  }

  /**
   * Safely percent-decode a path fragment produced by the browser/Vditor.
   */
  function safeDecodeURI(value) {
    if (!value || value.indexOf('%') === -1) return value;
    try {
      return decodeURIComponent(value);
    } catch (e) {
      return value;
    }
  }

  /**
   * Convert an <img> src into an absolute local filesystem path.
   * Handles relative paths (./, ../, spaces/Chinese), file:// URLs, and
   * loopback http://127.0.0.1:<port>/... URLs produced by the static server.
   * Returns null for external http(s)/data/blob URLs or unsupported values.
   * @param {string} rawSrc
   * @param {string} docDir
   * @returns {string|null}
   */
  function localImagePathFromSrc(rawSrc, docDir) {
    const src = String(rawSrc || '').trim();
    if (!src) return null;

    // Inline / runtime URLs are already usable by the <img> element.
    if (/^(data:|blob:)/i.test(src)) return null;

    // file:// URLs (legacy content or absolute markdown references)
    if (/^file:\/\//i.test(src)) {
      let filePath = src.replace(/^file:\/\//i, '');
      if (/^localhost\//i.test(filePath)) {
        filePath = filePath.slice('localhost'.length);
      }
      // Windows file:///C:/... -> C:/...
      if (/^\/[A-Za-z]:\//.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return normalizeLocalPath(safeDecodeURI(filePath));
    }

    // External links stay untouched; only loopback static-server URLs are local.
    if (/^https?:\/\//i.test(src)) {
      let parsed = null;
      try {
        parsed = new URL(src, window.location.href);
      } catch (e) {
        return null;
      }
      const host = (parsed.hostname || '').toLowerCase();
      const isLoopback =
        host === '127.0.0.1' ||
        host === 'localhost' ||
        host === '::1' ||
        host === '[::1]';
      if (!isLoopback) return null;
      const pathname = safeDecodeURI(parsed.pathname || '');
      const rel = pathname.replace(/^\/+/, '');
      if (!rel) return null;
      // The static server root is frontend/; document media lives next to the
      // markdown file, so resolve the URL path against the document directory.
      return normalizeLocalPath(`${docDir}/${rel}`);
    }

    // Protocol-relative URLs point at remote hosts.
    if (/^\/\//.test(src)) return null;

    // Absolute local filesystem paths.
    if (/^\//.test(src) || /^[A-Za-z]:[\\/]/.test(src)) {
      return normalizeLocalPath(safeDecodeURI(src));
    }

    // Plain relative path ("assets/a.png", "../images/a b.png", "./x/中文.png").
    return normalizeLocalPath(`${docDir}/${safeDecodeURI(src)}`);
  }

  /**
   * Look up a cached data URL. Returns undefined when not cached, null when a
   * recent failure should be skipped.
   */
  function getCachedImageDataUrl(absPath) {
    const entry = imageDataUrlCache.get(absPath);
    if (!entry) return undefined;
    if (entry.dataUrl) return entry.dataUrl;
    if (Date.now() - entry.ts > IMAGE_FAILURE_RETRY_MS) {
      imageDataUrlCache.delete(absPath);
      return undefined;
    }
    return null;
  }

  /**
   * Resolve local image references into data URLs through the Python bridge.
   * pywebview serves frontend/ over http://127.0.0.1:<port>, so files that live
   * next to the opened markdown document (sample/assets/...) are outside the
   * static root and must be embedded. Never throws; failures fall back silently.
   * @param {HTMLElement} containerEl
   * @returns {Promise<void>}
   */
  async function resolveRelativeImages(containerEl) {
    if (!containerEl) return;
    if (!window.BridgeClient || typeof window.BridgeClient.readFileDataUrl !== 'function') {
      return;
    }

    const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
    const filePath = activeTab ? activeTab.path : null;
    if (!filePath) return;

    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (lastSlash === -1) return;
    const docDir = filePath.slice(0, lastSlash);
    if (!docDir) return;

    const imgs = Array.from(containerEl.querySelectorAll('img'));
    const pending = [];

    imgs.forEach((img) => {
      const rawSrc = img.getAttribute('src');
      if (!rawSrc) return;

      const absPath = localImagePathFromSrc(rawSrc, docDir);
      if (!absPath) return;

      const cached = getCachedImageDataUrl(absPath);
      if (typeof cached === 'string') {
        if (img.getAttribute('src') !== cached) {
          img.setAttribute('src', cached);
        }
        return;
      }
      if (cached === null) return;

      pending.push(
        (async () => {
          try {
            const res = await window.BridgeClient.readFileDataUrl(absPath);
            const isOk = !!res && res.ok !== false && res.success !== false;
            const dataUrl =
              res && (res.data_url || res.dataUrl ||
                (res.data && (res.data.data_url || res.data.dataUrl)));
            if (isOk && typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
              imageDataUrlCache.set(absPath, { dataUrl, ts: Date.now() });
              img.setAttribute('src', dataUrl);
            } else {
              imageDataUrlCache.set(absPath, { dataUrl: null, ts: Date.now() });
            }
          } catch (err) {
            // Broken/missing local image: keep original src, never break render.
            imageDataUrlCache.set(absPath, { dataUrl: null, ts: Date.now() });
          }
        })()
      );
    });

    if (pending.length > 0) {
      await Promise.all(pending);
    }
  }

  /**
   * Find the current active scrollable and preview container element.
   */
  function getActiveContentElement() {
    if (currentMode === 'reader') {
      return readerContainerEl;
    }
    if (vditorContainerEl) {
      if (currentMode === 'ir') {
        const irEl = vditorContainerEl.querySelector('.vditor-ir .vditor-reset');
        if (irEl) return irEl;
      } else if (currentMode === 'sv') {
        const previewReset = vditorContainerEl.querySelector('.vditor-preview .vditor-reset') ||
                             vditorContainerEl.querySelector('.vditor-preview');
        if (previewReset) return previewReset;
      } else if (currentMode === 'wysiwyg') {
        const wysiwygEl = vditorContainerEl.querySelector('.vditor-wysiwyg .vditor-reset');
        if (wysiwygEl) return wysiwygEl;
      }
      const allResets = vditorContainerEl.querySelectorAll('.vditor-reset');
      for (const el of allResets) {
        if (el.querySelectorAll('h1, h2, h3, h4, h5, h6').length > 0) {
          return el;
        }
      }
      return vditorContainerEl;
    }
    return null;
  }

  let lastNotifyContent = null;
  let lastNotifyForce = false;

  /**
   * Emit editor:rendered with a 120ms debounce.
   *
   * Typing notifications may be dropped while the window is hidden (they are
   * flushed on visibilitychange). Explicit actions - tab switch, mode switch,
   * reader preview completion, external refresh - pass {force:true} so TOC,
   * callouts and image resolution are never delayed by the initial window
   * visibility state.
   *
   * @param {string} content
   * @param {{force?: boolean}} [options]
   */
  function notifyRendered(content, options) {
    lastNotifyContent = typeof content === 'string' ? content : null;
    lastNotifyForce = !!(options && options.force);
    clearTimeout(renderDebounceTimer);
    // Forced (explicit user/engine actions) flush on the next task so TOC,
    // callouts and image resolution are never delayed behind the typing
    // debounce; keystroke-level notifications stay debounced at 120ms.
    renderDebounceTimer = setTimeout(flushRendered, lastNotifyForce ? 0 : RENDER_DEBOUNCE_MS);
  }

  /**
   * Resolve images and publish editor:rendered for the current container.
   */
  function flushRendered() {
    if (typeof document !== 'undefined' && document.hidden && !lastNotifyForce) return;

    const container = getActiveContentElement();
    if (!container) return;

    resolveRelativeImages(container);

    if (window.AppBus) {
      window.AppBus.emit('editor:rendered', {
        containerEl: container,
        content: lastNotifyContent !== null ? lastNotifyContent : EditorEngine.getValue(),
        mode: currentMode,
      });
    }
  }

  /**
   * Cheap, stable string hash (djb2-xor) used for render signatures.
   */
  function hashString(value) {
    const text = typeof value === 'string' ? value : '';
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Signature of everything that changes reader preview output.
   * fontSize / maxWidth / centered are pure CSS (Appearance module) and are
   * deliberately excluded, so preference changes never re-run Vditor.preview.
   */
  function getReaderRenderSignature(markdownText, isDark, prefs, filePath) {
    const text = typeof markdownText === 'string' ? markdownText : '';
    return [
      filePath || '',
      text.length,
      hashString(text),
      isDark ? 'dark' : 'light',
      (prefs && prefs.codeTheme) || 'github',
    ].join('\u0000');
  }

  function isReaderContainerRendered() {
    return !!(readerContainerEl && readerContainerEl.childElementCount > 0);
  }

  /**
   * Render document in high-fidelity pure reader mode using Vditor.preview.
   * Renders are de-duplicated by signature and serialized: a second request
   * while one is in flight is queued (only the newest) instead of racing.
   */
  async function renderReaderMode(markdownText, options) {
    if (!readerContainerEl) return;

    const opts = options || {};
    const store = window.AppStore ? window.AppStore.getState() : {};
    const prefs = store.preferences || {};
    const isDark =
      prefs.theme === 'dark' ||
      (prefs.theme === 'auto' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    const md = typeof markdownText === 'string' ? markdownText : EditorEngine.getValue();
    const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
    const signature = getReaderRenderSignature(md, isDark, prefs, activeTab ? activeTab.path : null);

    // Same document + theme + preferences: the existing DOM is still valid.
    if (!opts.force && signature === lastReaderRenderSignature && isReaderContainerRendered()) {
      return;
    }

    if (isRenderingReader) {
      queuedReaderRender = { markdown: md, signature, force: !!opts.force };
      return;
    }

    isRenderingReader = true;
    let succeeded = false;

    try {
      if (window.Vditor && typeof window.Vditor.preview === 'function') {
        await window.Vditor.preview(readerContainerEl, md, {
          cdn: './vendor/vditor',
          mode: isDark ? 'dark' : 'light',
          hljs: {
            style: prefs.codeTheme || 'github',
            lineNumber: true,
          },
          math: {
            engine: 'KaTeX',
            inlineDigit: true,
          },
          markdown: {
            toc: true,
            mark: true,
            footnotes: true,
            autoSpace: true,
          },
          theme: {
            current: isDark ? 'dark' : 'classic',
          },
          after: () => {
            notifyRendered(md, { force: true });
          },
        });
        succeeded = true;
      } else {
        // Fallback simple pre formatting if Vditor script not loaded.
        readerContainerEl.innerHTML = '';
        const pre = document.createElement('pre');
        pre.textContent = md;
        readerContainerEl.appendChild(pre);
        succeeded = true;
        notifyRendered(md, { force: true });
      }
    } catch (err) {
      console.error('[EditorEngine] Reader preview render error:', err);
    } finally {
      isRenderingReader = false;
      if (succeeded) {
        lastReaderRenderSignature = signature;
      }

      const queued = queuedReaderRender;
      queuedReaderRender = null;
      if (queued && (queued.force || queued.signature !== lastReaderRenderSignature)) {
        renderReaderMode(queued.markdown, { force: queued.force });
      }
    }
  }

  /**
   * Current preferences snapshot.
   */
  function getPreferences() {
    return window.AppStore ? (window.AppStore.getState().preferences || {}) : {};
  }

  function isDarkTheme(prefs) {
    const p = prefs || getPreferences();
    return (
      p.theme === 'dark' ||
      (p.theme === 'auto' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    );
  }

  function getActiveTabSafe() {
    return window.AppStore ? window.AppStore.getActiveTab() : null;
  }

  function markEditorApplied(tab, content) {
    lastEditorTabId = tab ? (tab.id || null) : null;
    lastEditorPath = tab ? (tab.path || null) : null;
    lastEditorContent = typeof content === 'string' ? content : '';
  }

  function safeGetEditorValue() {
    if (!vditorInstance || !isVditorReady) return null;
    try {
      return vditorInstance.getValue();
    } catch (e) {
      return null;
    }
  }

  /**
   * Apply tab content to the Vditor instance at most once.
   *
   * tab:activated and tab:switched fire back-to-back for the same tab (a save
   * or external refresh can echo again), so identical tab id + path + content
   * is a no-op. Another tab/file still refreshes.
   */
  function applyEditorContent(tab, content) {
    const text = typeof content === 'string' ? content : '';
    const tabId = tab ? (tab.id || null) : null;
    const path = tab ? (tab.path || null) : null;

    if (!vditorInstance || !isVditorReady) {
      pendingContent = text;
      markEditorApplied(tab, text);
      return false;
    }

    const current = safeGetEditorValue();
    const sameTarget =
      tabId === lastEditorTabId && path === lastEditorPath && text === lastEditorContent;

    if (sameTarget) {
      // Same tab file + same content: never re-set. Vditor's Markdown
      // round-trip normalizes some text (e.g. trailing newlines), so a strict
      // getValue() === text comparison here would defeat the dedupe and make
      // tab:activated + tab:switched write the same content twice.
      if (current === null) {
        pendingContent = text;
      }
      return false;
    }

    if (current !== text) {
      try {
        vditorInstance.setValue(text, true);
      } catch (e) {
        console.warn('[EditorEngine] setValue error, buffered:', e);
        pendingContent = text;
      }
    }
    markEditorApplied(tab, text);
    notifyRendered(text, { force: true });
    return true;
  }

  /**
   * Apply a tab payload coming from tab:activated / tab:switched.
   */
  function applyTabContent(tab) {
    const content = tab && typeof tab.content === 'string' ? tab.content : '';
    if (currentMode === 'reader') {
      renderReaderMode(content);
      return;
    }
    applyEditorContent(tab, content);
  }

  /**
   * Hide Vditor's own edit-mode toolbar menu.
   *
   * Vditor 3.10.x exposes no public setMode(); mode switching is performed by
   * its internal edit-mode menu (exactly what the toolbar item does). The menu
   * element stays in the DOM (hidden) so the Vditor instance, toolbar nodes and
   * editor DOM survive ir <-> sv <-> wysiwyg switches.
   */
  function hideVditorEditModeButton() {
    if (!vditorContainerEl) return;
    const btn = vditorContainerEl.querySelector('.vditor-toolbar button[data-type="edit-mode"]');
    const item = btn ? (btn.closest('.vditor-toolbar__item') || btn.parentElement) : null;
    if (item && item.style.display !== 'none') {
      item.style.display = 'none';
    }
  }

  /**
   * In-place editor mode switch (never destroy/recreate).
   * @param {'ir'|'sv'|'wysiwyg'} targetMode
   * @returns {boolean} whether the instance is now in targetMode
   */
  function switchVditorMode(targetMode) {
    if (!vditorInstance || !isVditorReady || !vditorContainerEl) return false;

    try {
      if (typeof vditorInstance.getCurrentMode === 'function') {
        if (vditorInstance.getCurrentMode() === targetMode) return true;
      }

      const editModeBtn = vditorContainerEl.querySelector('.vditor-toolbar button[data-type="edit-mode"]');
      const wrapper = editModeBtn
        ? (editModeBtn.closest('.vditor-toolbar__item') || editModeBtn.parentElement)
        : null;
      const modeBtn = wrapper ? wrapper.querySelector(`button[data-mode="${targetMode}"]`) : null;
      if (!modeBtn) return false;

      // Same code path as the user clicking the toolbar menu item.
      modeBtn.click();

      return typeof vditorInstance.getCurrentMode === 'function'
        ? vditorInstance.getCurrentMode() === targetMode
        : true;
    } catch (err) {
      console.warn('[EditorEngine] In-place mode switch failed:', err);
      return false;
    }
  }

  function destroyVditorInstance() {
    if (!vditorInstance) return;
    try {
      vditorInstance.destroy();
    } catch (e) {
      console.warn('[EditorEngine] Error destroying Vditor:', e);
    }
    vditorInstance = null;
    isVditorReady = false;
    if (vditorContainerEl) vditorContainerEl.innerHTML = '';
  }

  /**
   * Create the single Vditor instance for editor modes.
   */
  function createVditorInstance(mode, initialContent) {
    if (!vditorContainerEl || !window.Vditor) return;

    isVditorReady = false;

    const prefs = getPreferences();
    const isDark = isDarkTheme(prefs);
    const value = typeof initialContent === 'string' ? initialContent : '';

    vditorInstance = new window.Vditor(vditorContainerEl, {
      cdn: './vendor/vditor',
      value: value,
      mode: mode || 'ir',
      theme: isDark ? 'dark' : 'classic',
      debugger: false,
      typewriterMode: false,
      placeholder: '输入 Markdown 内容，支持即时预览与公式...',
      counter: {
        enable: true,
      },
      cache: {
        enable: false,
      },
      preview: {
        theme: {
          current: isDark ? 'dark' : 'classic',
        },
        hljs: {
          style: prefs.codeTheme || 'github',
          lineNumber: true,
        },
        math: {
          engine: 'KaTeX',
          inlineDigit: true,
        },
        markdown: {
          toc: true,
          mark: true,
          footnotes: true,
          autoSpace: true,
        },
        actions: [],
      },
      toolbar: [
        'emoji',
        'headings',
        'bold',
        'italic',
        'strike',
        'link',
        '|',
        'list',
        'ordered-list',
        'check',
        'outdent',
        'indent',
        '|',
        'quote',
        'line',
        'code',
        'inline-code',
        'insert-before',
        'insert-after',
        '|',
        'table',
        'undo',
        'redo',
        'edit-mode',
      ],
      input(val) {
        const activeTab = getActiveTabSafe();
        if (window.AppStore) {
          // Single content/dirty update path; AppStore emits tab:content-updated.
          window.AppStore.updateActiveTabContent(val);
        }
        markEditorApplied(activeTab, val);
        if (window.AppBus) {
          window.AppBus.emit('editor:content-changed', {
            path: activeTab ? activeTab.path : null,
            content: val,
          });
        }
        notifyRendered(val);
      },
      after() {
        isVditorReady = true;
        hideVditorEditModeButton();

        const activeTab = getActiveTabSafe();
        const targetContent = pendingContent !== null
          ? pendingContent
          : (activeTab && typeof activeTab.content === 'string' ? activeTab.content : value);
        pendingContent = null;

        const current = safeGetEditorValue();
        if (typeof targetContent === 'string' && current !== targetContent) {
          try {
            vditorInstance.setValue(targetContent, true);
          } catch (e) {
            console.warn('[EditorEngine] setValue in after() error:', e);
            pendingContent = targetContent;
          }
        }
        markEditorApplied(activeTab, typeof targetContent === 'string' ? targetContent : value);

        // A mode requested while Vditor was still booting is applied now.
        const modeToApply = pendingMode;
        pendingMode = null;
        if (modeToApply && modeToApply !== mode) {
          switchVditorMode(modeToApply);
        }
        hideVditorEditModeButton();

        if (window.AppBus) {
          window.AppBus.emit('editor:ready', {
            engine: EditorEngine,
            mode: currentMode,
          });
        }
        notifyRendered(targetContent, { force: true });
        attachEditorScrollListener();
      },
    });

    // Attach scroll tracking once the toolbar/content DOM is in place.
    setTimeout(() => {
      attachEditorScrollListener();
    }, 200);
  }

  /**
   * Ensure an editor mode is visible and shows the given content, reusing the
   * existing Vditor instance whenever possible.
   */
  function ensureEditorMode(targetMode, content) {
    if (!vditorContainerEl || !window.Vditor) return;

    if (!vditorInstance) {
      createVditorInstance(targetMode, content);
      return;
    }

    // Vditor is still booting (lute loads asynchronously): remember the
    // request, after() applies it without creating a second instance.
    if (!isVditorReady) {
      pendingContent = typeof content === 'string' ? content : pendingContent;
      pendingMode = targetMode;
      return;
    }

    const activeTab = getActiveTabSafe();
    applyEditorContent(activeTab, content);

    if (!switchVditorMode(targetMode)) {
      // Defensive fallback only; the in-place switch must normally succeed.
      destroyVditorInstance();
      createVditorInstance(targetMode, content);
      return;
    }

    hideVditorEditModeButton();
    attachEditorScrollListener();
    notifyRendered(content);
  }

  /**
   * Listen to scroll events on active editor container and emit editor:scroll.
   */
  function attachEditorScrollListener() {
    if (!vditorContainerEl) return;

    const scrollTargets = vditorContainerEl.querySelectorAll(
      '.vditor-reset, .vditor-ir, .vditor-preview, .vditor-wysiwyg'
    );

    scrollTargets.forEach((target) => {
      target.removeEventListener('scroll', handleElementScroll);
      target.addEventListener('scroll', handleElementScroll, { passive: true });
    });
  }

  function handleElementScroll(e) {
    const el = e.target;
    if (!el || !window.AppBus) return;

    window.AppBus.emit('editor:scroll', {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      containerEl: el,
    });
  }

  /**
   * Intercept paste event on container to handle image uploads from clipboard.
   */
  function setupClipboardPaste() {
    window.addEventListener('paste', async (e) => {
      // Only process when app workspace is focused or target is within workspace
      if (!e.clipboardData || !e.clipboardData.items) return;

      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type && item.type.indexOf('image') !== -1) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;

          const reader = new FileReader();
          reader.onload = async (event) => {
            const base64Data = event.target.result;
            const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
            const currentMdPath = activeTab ? activeTab.path : null;

            if (window.BridgeClient) {
              const res = await window.BridgeClient.saveClipboardImage(
                currentMdPath,
                file.name || 'clipboard.png',
                base64Data
              );

              if (res.success && (res.rel_path || res.relPath)) {
                const imgPath = res.rel_path || res.relPath;
                const mdImage = `![image](${imgPath})`;
                EditorEngine.insertValue(mdImage);
              }
            }
          };
          reader.readAsDataURL(file);
          break;
        }
      }
    });
  }

  const EditorEngine = {
    /**
     * Initialize the editor and preview engine.
     */
    init() {
      vditorContainerEl = document.getElementById('vditor-container');
      readerScrollWrapEl = document.getElementById('reader-scroll-wrap');
      readerContainerEl = document.getElementById('reader-container');

      const store = window.AppStore ? window.AppStore.getState() : {};
      currentMode = store.editorMode || 'ir';

      // Setup reader scroll listener
      if (readerScrollWrapEl) {
        readerScrollWrapEl.addEventListener('scroll', handleElementScroll, { passive: true });
      }

      setupClipboardPaste();

      // Rendering work is skipped while the window is hidden; flush once it
      // becomes visible again so TOC/images never stay stale.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        clearTimeout(renderDebounceTimer);
        renderDebounceTimer = setTimeout(flushRendered, RENDER_DEBOUNCE_MS);
      });

      // Bind mode switcher buttons
      const modeButtons = document.querySelectorAll('#mode-switcher .mode-btn');
      modeButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const targetMode = btn.dataset.mode;
          if (targetMode) {
            EditorEngine.setMode(targetMode);
          }
        });
      });

      // Listen for mode changes
      if (window.AppBus) {
        window.AppBus.on('editor:mode-change-request', ({ mode }) => {
          this.setMode(mode);
        });

        // tab:activated and tab:switched both fire for a single switch; the
        // last-applied guard inside applyTabContent collapses those duplicates.
        const handleTabLoad = (payload) => {
          const tab = (payload && payload.tab) || payload;
          applyTabContent(tab);
        };

        window.AppBus.on('tab:activated', handleTabLoad);
        window.AppBus.on('tab:switched', handleTabLoad);

        window.AppBus.on('prefs:changed', ({ preferences }) => {
          if (!preferences) return;
          const isDark =
            preferences.theme === 'dark' ||
            (preferences.theme === 'auto' &&
              window.matchMedia &&
              window.matchMedia('(prefers-color-scheme: dark)').matches);
          this.setTheme(isDark, preferences.codeTheme);
        });

        window.AppBus.on('editor:scroll-to', ({ scrollTop, selector, headingText }) => {
          this.scrollTo({ scrollTop, selector, headingText });
        });
      }

      // Initial mount
      this.setMode(currentMode, true);
    },

    /**
     * Get current Markdown content.
     * @returns {string}
     */
    getValue() {
      if (currentMode === 'reader') {
        const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
        return activeTab ? activeTab.content : '';
      }
      if (pendingContent !== null) {
        return pendingContent;
      }
      if (vditorInstance && isVditorReady) {
        try {
          return vditorInstance.getValue();
        } catch (e) {
          // ignore if unready
        }
      }
      const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
      return activeTab ? activeTab.content : '';
    },

    /**
     * Set Markdown content into active editor or reader.
     * @param {string} markdown
     * @param {boolean} [silent=false]
     */
    setValue(markdown, silent = false) {
      const text = typeof markdown === 'string' ? markdown : '';

      if (currentMode === 'reader') {
        renderReaderMode(text);
        return;
      }

      if (vditorInstance && isVditorReady) {
        if (safeGetEditorValue() === text) {
          // Already showing this content: keep the dedupe guard in sync but
          // skip the (expensive) full Vditor re-render.
          markEditorApplied(getActiveTabSafe(), text);
          if (!silent) {
            notifyRendered(text, { force: true });
          }
          return;
        }

        try {
          vditorInstance.setValue(text, true);
        } catch (e) {
          console.warn('[EditorEngine] setValue error, buffered:', e);
          pendingContent = text;
        }
        markEditorApplied(getActiveTabSafe(), text);
        if (!silent) {
          notifyRendered(text, { force: true });
        }
      } else {
        pendingContent = text;
        markEditorApplied(getActiveTabSafe(), text);
        if (!silent) {
          notifyRendered(text, { force: true });
        }
      }
    },

    /**
     * Apply externally produced content (find & replace, scripted edits) to the
     * active document through the normal state/save chain.
     *
     * Unlike setValue(), this also updates AppStore and emits
     * editor:content-changed, so auto-save, status bar and any listener observe
     * exactly the same document. Vditor's undo stack is preserved
     * (clearStack = false), so Cmd+Z can still revert the change.
     *
     * @param {string} markdown
     * @returns {boolean} whether the content actually changed
     */
    applyExternalContent(markdown) {
      const text = typeof markdown === 'string' ? markdown : '';
      const activeTab = getActiveTabSafe();
      const previous = activeTab && typeof activeTab.content === 'string'
        ? activeTab.content
        : this.getValue();
      if (previous === text) return false;

      // 1. Store content + dirty state (single owner of content state).
      if (window.AppStore) {
        window.AppStore.updateActiveTabContent(text);
      }

      // 2. Editor / reader view.
      if (currentMode === 'reader') {
        renderReaderMode(text);
      } else if (vditorInstance && isVditorReady) {
        if (safeGetEditorValue() !== text) {
          try {
            vditorInstance.setValue(text, false);
          } catch (e) {
            console.warn('[EditorEngine] applyExternalContent setValue error, buffered:', e);
            pendingContent = text;
          }
        }
        markEditorApplied(getActiveTabSafe(), text);
        notifyRendered(text, { force: true });
      } else {
        pendingContent = text;
        markEditorApplied(getActiveTabSafe(), text);
        notifyRendered(text, { force: true });
      }

      // 3. Save chain + consumers that only listen to editor:content-changed.
      if (window.AppBus) {
        window.AppBus.emit('editor:content-changed', {
          path: activeTab ? activeTab.path : null,
          content: text,
        });
      }

      return true;
    },

    /**
     * Insert Markdown content at current cursor position.
     * @param {string} val
     */
    insertValue(val) {
      if (!val) return;

      if (currentMode === 'reader') {
        // In reader mode, append to current document and notify
        const current = this.getValue();
        const updated = current + '\n\n' + val;
        this.setValue(updated);
        if (window.AppStore) {
          window.AppStore.updateActiveTabContent(updated);
        }
      } else if (vditorInstance) {
        vditorInstance.insertValue(val, true);
      }
    },

    /**
     * Get rendered HTML from current view.
     * @returns {string}
     */
    getHTML() {
      if (currentMode === 'reader' && readerContainerEl) {
        return readerContainerEl.innerHTML;
      }
      if (vditorInstance) {
        return vditorInstance.getHTML();
      }
      return '';
    },

    /**
     * Switch view mode ('reader', 'ir', 'sv', 'wysiwyg').
     * @param {string} targetMode
     * @param {boolean} [force=false]
     */
    setMode(targetMode, force = false) {
      const validModes = ['reader', 'ir', 'sv', 'wysiwyg'];
      if (!validModes.includes(targetMode)) return;

      if (currentMode === targetMode && !force) return;

      const prevMode = currentMode;
      currentMode = targetMode;

      // Update AppStore state
      if (window.AppStore) {
        window.AppStore.setState({ editorMode: targetMode });
      }

      // Update Root element dataset
      const appRoot = document.getElementById('app-root');
      if (appRoot) {
        appRoot.dataset.mode = targetMode;
      }

      // Update Header Mode switcher active buttons
      const modeButtons = document.querySelectorAll('#mode-switcher .mode-btn');
      modeButtons.forEach((btn) => {
        if (btn.dataset.mode === targetMode) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      const activeTab = getActiveTabSafe();
      const currentContent = activeTab && typeof activeTab.content === 'string'
        ? activeTab.content
        : this.getValue();

      // Visibility is driven by the .hidden utility class (never inline
      // display + !important), so flex layout and scroll listeners stay intact.
      if (targetMode === 'reader') {
        if (vditorContainerEl) {
          vditorContainerEl.classList.add('hidden');
          vditorContainerEl.style.removeProperty('display');
        }
        if (readerScrollWrapEl) {
          readerScrollWrapEl.classList.remove('hidden');
          readerScrollWrapEl.style.removeProperty('display');
        }
        renderReaderMode(currentContent);
      } else {
        if (readerScrollWrapEl) {
          readerScrollWrapEl.classList.add('hidden');
          readerScrollWrapEl.style.removeProperty('display');
        }
        if (vditorContainerEl) {
          vditorContainerEl.classList.remove('hidden');
          vditorContainerEl.style.removeProperty('display');
        }

        // Reuse the single Vditor instance: only the first mount creates it,
        // later switches call Vditor's own in-place edit-mode switch.
        ensureEditorMode(targetMode, currentContent);
        notifyRendered(currentContent, { force: true });
      }

      if (window.AppBus) {
        window.AppBus.emit('editor:mode-changed', {
          mode: targetMode,
          prevMode,
        });
      }
    },

    /**
     * Update editor theme and code syntax theme.
     * @param {boolean} isDark
     * @param {string} codeTheme
     */
    setTheme(isDark, codeTheme) {
      const themeName = isDark ? 'dark' : 'classic';
      const cTheme = codeTheme || 'github';
      const themeKey = `${themeName}|${cTheme}`;

      // Font family/size, max width and centering are pure CSS handled by the
      // Appearance module. If neither theme nor code theme changed there is
      // nothing to re-render - bail out before touching Vditor or the reader.
      if (themeKey === lastAppliedThemeKey) return;

      lastAppliedThemeKey = themeKey;

      if (vditorInstance) {
        try {
          vditorInstance.setTheme(themeName, themeName, cTheme);
        } catch (e) {
          console.warn('[EditorEngine] Error updating Vditor theme:', e);
        }
      }

      if (currentMode === 'reader') {
        renderReaderMode(this.getValue());
      }
    },

    /**
     * Scroll active view to a specific scroll position, heading, or element selector.
     */
    scrollTo({ scrollTop, selector, headingText }) {
      const activeEl = currentMode === 'reader' ? readerScrollWrapEl : getActiveContentElement();
      if (!activeEl) return;

      if (typeof scrollTop === 'number') {
        activeEl.scrollTo({ top: scrollTop, behavior: 'smooth' });
        return;
      }

      if (selector) {
        const target = activeEl.querySelector(selector);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }

      if (headingText) {
        const headings = activeEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const trimmed = headingText.trim();
        for (const h of headings) {
          if (h.textContent.trim() === trimmed || h.textContent.includes(trimmed)) {
            h.scrollIntoView({ behavior: 'smooth', block: 'start' });
            break;
          }
        }
      }
    },

    /**
     * Focus editor.
     */
    focus() {
      if (vditorInstance && currentMode !== 'reader') {
        vditorInstance.focus();
      }
    },
  };

  window.EditorEngine = EditorEngine;
})();
