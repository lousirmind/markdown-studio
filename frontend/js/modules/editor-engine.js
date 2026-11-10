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
  let currentMode = 'ir';
  let vditorContainerEl = null;
  let readerScrollWrapEl = null;
  let readerContainerEl = null;
  let isRenderingReader = false;
  let renderDebounceTimer = null;

  /**
   * Resolve relative local image src paths in the DOM into file:// URLs
   * without modifying Markdown source content.
   */
  function resolveRelativeImages(containerEl) {
    if (!containerEl) return;
    const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
    const filePath = activeTab ? activeTab.path : null;
    if (!filePath) return;

    // Extract directory from active file path
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    if (lastSlash === -1) return;
    const docDir = filePath.slice(0, lastSlash);

    const imgs = containerEl.querySelectorAll('img');
    imgs.forEach((img) => {
      const rawSrc = img.getAttribute('src');
      if (!rawSrc) return;

      // Skip absolute protocols and data URLs
      if (
        rawSrc.startsWith('http://') ||
        rawSrc.startsWith('https://') ||
        rawSrc.startsWith('data:') ||
        rawSrc.startsWith('file://') ||
        rawSrc.startsWith('blob:')
      ) {
        return;
      }

      // Clean relative path (e.g. "./assets/img.png" -> "assets/img.png")
      let cleanRel = rawSrc.replace(/^\.\//, '');
      let fullPath = `${docDir}/${cleanRel}`.replace(/\\/g, '/');

      // Ensure proper file URL scheme
      if (!fullPath.startsWith('/')) {
        fullPath = `/${fullPath}`;
      }
      img.src = `file://${fullPath}`;
    });
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

  /**
   * Emit editor:rendered with debounce.
   */
  function notifyRendered(content) {
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(() => {
      const container = getActiveContentElement();
      if (container) {
        resolveRelativeImages(container);
        if (window.AppBus) {
          window.AppBus.emit('editor:rendered', {
            containerEl: container,
            content: typeof content === 'string' ? content : EditorEngine.getValue(),
            mode: currentMode,
          });
        }
      }
    }, 40);
  }

  /**
   * Render document in high-fidelity pure reader mode using Vditor.preview.
   */
  async function renderReaderMode(markdownText) {
    if (!readerContainerEl) return;

    const store = window.AppStore ? window.AppStore.getState() : {};
    const prefs = store.preferences || {};
    const isDark =
      prefs.theme === 'dark' ||
      (prefs.theme === 'auto' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    const md = typeof markdownText === 'string' ? markdownText : EditorEngine.getValue();

    isRenderingReader = true;

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
            isRenderingReader = false;
            notifyRendered(md);
          },
        });
      } else {
        // Fallback simple pre formatting if Vditor script not loaded
        readerContainerEl.innerHTML = `<pre>${md}</pre>`;
        isRenderingReader = false;
        notifyRendered(md);
      }
    } catch (err) {
      console.error('[EditorEngine] Reader preview render error:', err);
      isRenderingReader = false;
    }
  }

  /**
   * Initialize or re-create Vditor instance for editor modes (ir, sv, wysiwyg).
   */
  function initVditorInstance(mode, initialContent) {
    if (!vditorContainerEl || !window.Vditor) return;

    isVditorReady = false;

    // Destroy existing instance cleanly if mode changes
    if (vditorInstance) {
      try {
        vditorInstance.destroy();
      } catch (e) {
        console.warn('[EditorEngine] Error destroying existing Vditor:', e);
      }
      vditorInstance = null;
      vditorContainerEl.innerHTML = '';
    }

    const store = window.AppStore ? window.AppStore.getState() : {};
    const prefs = store.preferences || {};
    const isDark =
      prefs.theme === 'dark' ||
      (prefs.theme === 'auto' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    const value =
      initialContent !== undefined ? initialContent : store.tabs.find((t) => t.id === store.activeTabId)?.content || '';

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
      ],
      input(val) {
        if (window.AppStore) {
          window.AppStore.updateActiveTabContent(val);
        }
        if (window.AppBus) {
          const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
          window.AppBus.emit('editor:content-changed', {
            path: activeTab ? activeTab.path : null,
            content: val,
          });
        }
        notifyRendered(val);
      },
      after() {
        isVditorReady = true;
        const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
        const targetContent = pendingContent !== null
          ? pendingContent
          : (activeTab && activeTab.content !== undefined ? activeTab.content : value);
        pendingContent = null;
        if (targetContent !== undefined && targetContent !== null && targetContent !== value) {
          try {
            vditorInstance.setValue(targetContent, true);
          } catch (e) {
            console.warn('[EditorEngine] setValue in after() error:', e);
          }
        }
        if (window.AppBus) {
          window.AppBus.emit('editor:ready', {
            engine: EditorEngine,
            mode: currentMode,
          });
        }
        notifyRendered(targetContent !== undefined && targetContent !== null ? targetContent : value);
      },
    });

    // Attach scroll tracking to Vditor preview or editor
    setTimeout(() => {
      attachEditorScrollListener();
    }, 200);
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

        const handleTabLoad = (payload) => {
          const tab = (payload && payload.tab) || payload;
          const content = tab && typeof tab.content === 'string' ? tab.content : (tab ? tab.content : '');
          this.setValue(content);
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
      } else if (vditorInstance && isVditorReady) {
        try {
          vditorInstance.setValue(text, true);
        } catch (e) {
          console.warn('[EditorEngine] setValue error, buffered:', e);
          pendingContent = text;
        }
        if (!silent) {
          notifyRendered(text);
        }
      } else {
        pendingContent = text;
        if (!silent) {
          notifyRendered(text);
        }
      }
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

      const activeTab = window.AppStore ? window.AppStore.getActiveTab() : null;
      const currentContent = activeTab ? activeTab.content : this.getValue();

      if (targetMode === 'reader') {
        if (vditorContainerEl) vditorContainerEl.style.display = 'none';
        if (readerScrollWrapEl) readerScrollWrapEl.style.display = 'flex';
        renderReaderMode(currentContent);
      } else {
        if (readerScrollWrapEl) readerScrollWrapEl.style.display = 'none';
        if (vditorContainerEl) vditorContainerEl.style.display = 'block';

        // Re-initialize Vditor if switching mode or first creation
        if (!vditorInstance || prevMode !== targetMode || force) {
          initVditorInstance(targetMode, currentContent);
        }
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
