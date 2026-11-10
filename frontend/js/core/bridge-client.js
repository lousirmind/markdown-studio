/**
 * BridgeClient - Front-end client interface for pywebview Python desktop backend.
 * Provides unified Promise-based APIs with automatic camelCase/snake_case mapping,
 * readiness detection, error formatting, and browser-standalone mock fallback.
 */
(function () {
  'use strict';

  let apiInstance = null;
  let isMockMode = false;
  let readyPromise = null;

  // In-memory mock storage for standalone browser testing
  const mockStorage = {
    files: new Map([
      [
        '/sample/welcome.md',
        `# 欢迎使用 Markdown Studio\n\n这是一个优雅、现代的 Markdown 阅读与编辑工作台。\n\n## 核心特性\n- [x] 多模式自由切换：纯阅读、即时渲染 (IR)、分屏对比 (SV)、所见即所得 (WYSIWYG)\n- [x] 智能 Callout / Alert 渲染\n- [x] LaTeX 数学公式支持：$E = mc^2$\n- [x] 离线渲染与导出：支持导出独立 HTML 与高清 PDF\n- [ ] 探索更多定制偏好\n\n> [!NOTE]\n> 本文档在独立浏览器预览模式下由内存模拟器加载。\n\n> [!TIP]\n> 尝试点击右侧模式切换按钮体验不同排版模式！\n\n\`\`\`javascript\nconsole.log("Hello Markdown Studio!");\n\`\`\`\n`,
      ],
    ]),
    mtimes: new Map([['/sample/welcome.md', Date.now() / 1000]]),
  };

  /**
   * Check if pywebview API object is fully bound with exposed methods.
   */
  function isApiReady() {
    return (
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api === 'object' &&
      Object.keys(window.pywebview.api).length > 0
    );
  }

  /**
   * Wait for pywebview API to be exposed on window.
   * @param {number} timeoutMs
   * @returns {Promise<object>} The pywebview API object or mock fallback
   */
  function waitForApi(timeoutMs = 3000) {
    if (readyPromise) return readyPromise;

    readyPromise = new Promise((resolve) => {
      // 1. Direct check
      if (isApiReady()) {
        apiInstance = window.pywebview.api;
        return resolve(apiInstance);
      }

      let resolved = false;

      // 2. Event listener
      const onReady = () => {
        if (resolved) return;
        if (isApiReady()) {
          resolved = true;
          apiInstance = window.pywebview.api;
          if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('pywebviewready', onReady);
          }
          resolve(apiInstance);
        }
      };
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('pywebviewready', onReady);
      }

      // 3. Polling interval
      const interval = setInterval(() => {
        if (resolved) {
          clearInterval(interval);
          return;
        }
        if (isApiReady()) {
          resolved = true;
          clearInterval(interval);
          if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('pywebviewready', onReady);
          }
          apiInstance = window.pywebview.api;
          resolve(apiInstance);
        }
      }, 30);

      // 4. Standalone fallback timer
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        if (typeof window.removeEventListener === 'function') {
          window.removeEventListener('pywebviewready', onReady);
        }
        if (isApiReady()) {
          apiInstance = window.pywebview.api;
        } else {
          isMockMode = true;
          console.info('[BridgeClient] pywebview desktop bridge not detected; operating in mock mode.');
          apiInstance = createMockBridge();
        }
        resolve(apiInstance);
      }, timeoutMs);
    });

    return readyPromise;
  }

  /**
   * Create an in-browser mock bridge for development and testing.
   */
  function createMockBridge() {
    return {
      get_initial_state: async () => {
        const savedPrefs = localStorage.getItem('markdown_studio_prefs');
        const prefs = savedPrefs ? JSON.parse(savedPrefs) : {};
        return {
          ok: true,
          data: {
            preferences: prefs,
            welcome_path: '/sample/welcome.md',
            target_file: '/sample/welcome.md',
            workspace_dir: '/sample',
            project_root: '/sample',
          },
        };
      },
      read_file: async (path) => {
        if (mockStorage.files.has(path)) {
          return {
            ok: true,
            data: {
              path,
              name: path.split('/').pop(),
              content: mockStorage.files.get(path),
              mtime: mockStorage.mtimes.get(path) || Date.now() / 1000,
              size: (mockStorage.files.get(path) || '').length,
            },
          };
        }
        return { ok: false, error: `File not found: ${path}` };
      },
      write_file: async (path, content) => {
        const mtime = Date.now() / 1000;
        mockStorage.files.set(path, content);
        mockStorage.mtimes.set(path, mtime);
        return {
          ok: true,
          data: { path, mtime, size: (content || '').length },
        };
      },
      list_dir: async (dirPath) => {
        const items = [];
        for (const [filePath] of mockStorage.files.entries()) {
          items.push({
            name: filePath.split('/').pop(),
            path: filePath,
            isDir: false,
            size: (mockStorage.files.get(filePath) || '').length,
            mtime: mockStorage.mtimes.get(filePath) || Date.now() / 1000,
          });
        }
        return {
          ok: true,
          data: { root: dirPath || '/sample', items },
        };
      },
      create_item: async (parentDir, name, isDir) => {
        const target = `${parentDir}/${name}`.replace(/\/+/g, '/');
        if (!isDir) {
          mockStorage.files.set(target, '');
          mockStorage.mtimes.set(target, Date.now() / 1000);
        }
        return {
          ok: true,
          data: { path: target, name, isDir: !!isDir },
        };
      },
      rename_item: async (oldPath, newName) => {
        const parts = oldPath.split('/');
        parts.pop();
        const newPath = [...parts, newName].join('/');
        if (mockStorage.files.has(oldPath)) {
          const content = mockStorage.files.get(oldPath);
          mockStorage.files.delete(oldPath);
          mockStorage.files.set(newPath, content);
        }
        return {
          ok: true,
          data: { oldPath, newPath, name: newName },
        };
      },
      delete_item: async (path) => {
        mockStorage.files.delete(path);
        mockStorage.mtimes.delete(path);
        return { ok: true, data: { path } };
      },
      check_files_mtime: async (paths) => {
        const results = {};
        for (const p of paths) {
          if (mockStorage.mtimes.has(p)) {
            results[p] = mockStorage.mtimes.get(p);
          }
        }
        return { ok: true, data: { mtimes: results } };
      },
      read_file_data_url: async () => {
        return { ok: false, error: 'Mock mode: local image data URL unavailable' };
      },
      save_clipboard_image: async (currentMdPath, filename, base64Data) => {
        const imgName = filename || `img_${Date.now()}.png`;
        const relPath = `./assets/${imgName}`;
        return {
          ok: true,
          data: {
            rel_path: relPath,
            abs_path: `/sample/assets/${imgName}`,
            file_url: base64Data.startsWith('data:') ? base64Data : `data:image/png;base64,${base64Data}`,
          },
        };
      },
      load_preferences: async () => {
        const saved = localStorage.getItem('markdown_studio_prefs');
        return { ok: true, data: saved ? JSON.parse(saved) : {} };
      },
      save_preferences: async (prefs) => {
        localStorage.setItem('markdown_studio_prefs', JSON.stringify(prefs));
        return { ok: true, data: prefs };
      },
      select_file_dialog: async () => {
        return { ok: true, data: { path: '/sample/welcome.md' } };
      },
      select_folder_dialog: async () => {
        return { ok: true, data: { path: '/sample' } };
      },
      export_html_dialog: async (defaultName) => {
        return { ok: true, data: { path: `/sample/${defaultName || 'exported.html'}` } };
      },
    };
  }

  /**
   * Helper to execute a bridge call, supporting both snake_case and camelCase method names.
   * Standardizes response to { ok: boolean, success: boolean, ...data, error?: string }.
   */
  async function callBridge(methodName, ...args) {
    const api = await waitForApi();

    // Convert camelCase to snake_case
    const snakeCase = methodName.replace(/([A-Z])/g, '_$1').toLowerCase();

    const targetFn = api[snakeCase] || api[methodName];

    if (typeof targetFn !== 'function') {
      console.warn(`[BridgeClient] Method not implemented on bridge: ${methodName} / ${snakeCase}`);
      return {
        ok: false,
        success: false,
        error: `Bridge method not found: ${methodName}`,
      };
    }

    try {
      const rawRes = await targetFn.apply(api, args);

      if (!rawRes || typeof rawRes !== 'object') {
        return { ok: true, success: true, data: rawRes };
      }

      const isOk = rawRes.ok !== false && rawRes.success !== false;
      const dataPayload = rawRes.data !== undefined ? rawRes.data : rawRes;

      if (isOk) {
        if (typeof dataPayload === 'object' && dataPayload !== null) {
          return {
            ok: true,
            success: true,
            ...dataPayload,
            data: dataPayload,
          };
        }
        return {
          ok: true,
          success: true,
          data: dataPayload,
        };
      }

      const errorMsg = rawRes.error || rawRes.message || 'Unknown bridge error';
      const isCancelled = typeof errorMsg === 'string' && /cancel/i.test(errorMsg);
      return {
        ok: false,
        success: false,
        cancelled: isCancelled,
        error: errorMsg,
      };
    } catch (err) {
      console.error(`[BridgeClient] Exception calling ${methodName}:`, err);
      return {
        ok: false,
        success: false,
        error: err.message || String(err),
      };
    }
  }

  const BridgeClient = {
    /**
     * Check if currently running with real pywebview or in mock mode.
     */
    isMock() {
      return isMockMode;
    },

    /**
     * Get initial startup state (preferences, active file, workspace directory).
     * @returns {Promise<object>}
     */
    async getInitialState() {
      return callBridge('getInitialState');
    },

    /**
     * Read file content with UTF-8 / GBK fallback.
     * @param {string} path Absolute file path
     * @returns {Promise<{ success: boolean, content: string, mtime: number, size: number, error?: string }>}
     */
    async readFile(path) {
      return callBridge('readFile', path);
    },

    /**
     * Read a local image file as a base64 data URL.
     * Backend enforces regular-file-only, image-extension whitelist and a 20MB cap.
     * @param {string} path Absolute local image path
     * @returns {Promise<{ success: boolean, data_url?: string, mime?: string, error?: string }>}
     */
    async readFileDataUrl(path) {
      return callBridge('readFileDataUrl', path);
    },

    /**
     * Write file content safely (atomic write).
     * @param {string} path Absolute file path
     * @param {string} content Text content
     * @returns {Promise<{ success: boolean, mtime: number, size: number, error?: string }>}
     */
    async writeFile(path, content) {
      return callBridge('writeFile', path, content);
    },

    /**
     * List directory contents with sorting and hidden files filter.
     * @param {string} dirPath Directory path
     * @param {boolean} [showHidden=false]
     * @param {string} [sortBy='name'] 'name' | 'mtime' | 'size'
     * @param {boolean} [sortAsc=true]
     * @returns {Promise<{ success: boolean, root: string, items: Array, error?: string }>}
     */
    async listDir(dirPath, showHidden = false, sortBy = 'name', sortAsc = true) {
      return callBridge('listDir', dirPath, showHidden, sortBy, sortAsc);
    },

    /**
     * Create a new file or directory.
     * @param {string} parentDir
     * @param {string} name
     * @param {boolean} [isDir=false]
     * @returns {Promise<{ success: boolean, path: string, name: string, isDir: boolean, error?: string }>}
     */
    async createItem(parentDir, name, isDir = false) {
      return callBridge('createItem', parentDir, name, isDir);
    },

    /**
     * Rename a file or directory.
     * @param {string} oldPath
     * @param {string} newName
     * @returns {Promise<{ success: boolean, oldPath: string, newPath: string, name: string, error?: string }>}
     */
    async renameItem(oldPath, newName) {
      return callBridge('renameItem', oldPath, newName);
    },

    /**
     * Delete a file or directory.
     * @param {string} path
     * @returns {Promise<{ success: boolean, path: string, error?: string }>}
     */
    async deleteItem(path) {
      return callBridge('deleteItem', path);
    },

    /**
     * Query latest modification times for monitored file paths.
     * @param {string[]} paths
     * @returns {Promise<{ success: boolean, mtimes: { [path: string]: number }, error?: string }>}
     */
    async checkFilesMtime(paths) {
      return callBridge('checkFilesMtime', paths);
    },

    /**
     * Persist base64 image into assets/ folder relative to current document.
     * @param {string} currentMdPath
     * @param {string} filename
     * @param {string} base64Data
     * @returns {Promise<{ success: boolean, rel_path: string, abs_path: string, file_url: string, error?: string }>}
     */
    async saveClipboardImage(currentMdPath, filename, base64Data) {
      return callBridge('saveClipboardImage', currentMdPath, filename, base64Data);
    },

    /**
     * Load user preferences from disk.
     * @returns {Promise<{ success: boolean, preferences: object, error?: string }>}
     */
    async loadPreferences() {
      const res = await callBridge('loadPreferences');
      if (res.success && res.data) {
        return { success: true, ok: true, preferences: res.data, ...res.data };
      }
      return res;
    },

    /**
     * Save user preferences to disk.
     * @param {object} prefs
     * @returns {Promise<{ success: boolean, error?: string }>}
     */
    async savePreferences(prefs) {
      return callBridge('savePreferences', prefs);
    },

    /**
     * Show native desktop file open dialog.
     * @returns {Promise<{ success: boolean, path: string, cancelled?: boolean, error?: string }>}
     */
    async selectFileDialog() {
      return callBridge('selectFileDialog');
    },

    /**
     * Show native desktop folder open dialog.
     * @returns {Promise<{ success: boolean, path: string, cancelled?: boolean, error?: string }>}
     */
    async selectFolderDialog() {
      return callBridge('selectFolderDialog');
    },

    /**
     * Show native desktop export HTML save dialog.
     * @param {string} defaultName
     * @param {string} htmlContent
     * @returns {Promise<{ success: boolean, path: string, cancelled?: boolean, error?: string }>}
     */
    async exportHtmlDialog(defaultName, htmlContent) {
      return callBridge('exportHtmlDialog', defaultName, htmlContent);
    },
  };

  window.BridgeClient = BridgeClient;

  // Initialize eager bridge handshake
  waitForApi();
})();
