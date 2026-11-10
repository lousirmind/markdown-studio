/**
 * Appearance Module
 * Responsible for managing the settings drawer, user appearance preferences
 * (theme, code theme, typography, layout width, centering, auto-save, auto-refresh,
 * custom CSS injection), CSS variables updates, and debounced bridge persistence.
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore,
 * and window.BridgeClient.
 */
(function () {
  'use strict';

  let saveDebounceTimer = null;
  const SAVE_DEBOUNCE_MS = 500;

  // P2-7: 单一偏好应用路径 + 一帧合并
  let lastAppliedThemeKey = null; // effectiveTheme + '|' + codeTheme，仅此组合变化才通知 setTheme
  let applyScheduled = false;
  let pendingApplyPrefs = null;
  let fontSizeScheduled = false;
  let pendingFontSize = null;

  /**
   * 一帧合并执行（rAF 优先，附带超时兜底，避免窗口失焦时 rAF 被节流）。
   */
  function scheduleFrame(run) {
    let done = false;
    const invoke = () => {
      if (done) return;
      done = true;
      run();
    };
    const fallbackTimer = setTimeout(invoke, 100);
    requestAnimationFrame(() => {
      if (done) return;
      clearTimeout(fallbackTimer);
      invoke();
    });
  }

  // Font family mapping
  const FONT_FAMILIES = {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
    serif: 'Georgia, Cambria, "Times New Roman", Times, "Songti SC", serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace',
  };

  /**
   * Helper to get system color scheme (dark / light)
   */
  function getSystemTheme() {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  /**
   * Resolve effective theme:
   * 'auto' -> resolved from system media query
   */
  function resolveEffectiveTheme(themePref) {
    if (!themePref || themePref === 'auto') {
      return getSystemTheme();
    }
    return themePref === 'dark' ? 'dark' : 'light';
  }

  /**
   * Apply user preferences to DOM, CSS variables, and EditorEngine
   */
  function applyPreferences(prefs) {
    if (!prefs) return;

    const root = document.getElementById('app-root') || document.documentElement;
    const docEl = document.documentElement;

    // 1. Theme application
    const effectiveTheme = resolveEffectiveTheme(prefs.theme);
    const isDark = effectiveTheme === 'dark';

    setAttrIfChanged(root, 'data-theme', effectiveTheme);
    setAttrIfChanged(docEl, 'data-theme', effectiveTheme);

    // 2. Code Theme
    const codeTheme = prefs.codeTheme || 'github';
    setAttrIfChanged(root, 'data-code-theme', codeTheme);
    setAttrIfChanged(docEl, 'data-code-theme', codeTheme);

    // 3. Centered Layout
    const isCentered = prefs.centered !== false;
    setAttrIfChanged(root, 'data-centered', isCentered ? 'true' : 'false');
    setAttrIfChanged(docEl, 'data-centered', isCentered ? 'true' : 'false');

    // 4. Typography and Width CSS Variables
    const fontFamilyVal = FONT_FAMILIES[prefs.fontFamily] || prefs.fontFamily || FONT_FAMILIES.sans;
    const fontSizeVal = typeof prefs.fontSize === 'number' ? `${prefs.fontSize}px` : (prefs.fontSize || '16px');
    let maxWidthVal = prefs.maxWidth || '1000px';
    if (/^\d+$/.test(String(maxWidthVal).trim())) {
      maxWidthVal = `${maxWidthVal}px`;
    }

    setCssVarIfChanged(docEl, '--md-font-family', fontFamilyVal);
    setCssVarIfChanged(docEl, '--md-font-size', fontSizeVal);
    setCssVarIfChanged(docEl, '--md-max-width', maxWidthVal);

    if (root !== docEl) {
      setCssVarIfChanged(root, '--md-font-family', fontFamilyVal);
      setCssVarIfChanged(root, '--md-font-size', fontSizeVal);
      setCssVarIfChanged(root, '--md-max-width', maxWidthVal);
    }

    // 5. Custom CSS injection（内容未变不重写，避免样式重算）
    let customStyleEl = document.getElementById('user-custom-css');
    if (!customStyleEl) {
      customStyleEl = document.createElement('style');
      customStyleEl.id = 'user-custom-css';
      document.head.appendChild(customStyleEl);
    }
    const customCss = prefs.customCss || '';
    if (customStyleEl.textContent !== customCss) {
      customStyleEl.textContent = customCss;
    }

    // 6. 仅 theme / codeTheme 真正变化时才通知 EditorEngine。
    //    字号 / 最大宽度 / 字体族只改 CSS 变量，绝不触发阅读模式全文重渲染。
    const themeKey = effectiveTheme + '|' + codeTheme;
    if (lastAppliedThemeKey !== themeKey) {
      lastAppliedThemeKey = themeKey;
      if (window.EditorEngine && typeof window.EditorEngine.setTheme === 'function') {
        try {
          window.EditorEngine.setTheme(isDark, codeTheme);
        } catch (err) {
          console.warn('[Appearance] EditorEngine.setTheme error:', err);
        }
      }
    }
  }

  /**
   * 仅在属性值真正变化时写入
   */
  function setAttrIfChanged(el, name, value) {
    if (el && el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  /**
   * 仅在 CSS 变量真正变化时写入
   */
  function setCssVarIfChanged(el, name, value) {
    if (el && el.style.getPropertyValue(name) !== value) {
      el.style.setProperty(name, value);
    }
  }

  /**
   * 合并应用：同一帧内的多次偏好变更只应用一次
   */
  function scheduleApplyPreferences(prefs) {
    pendingApplyPrefs = prefs;
    if (applyScheduled) return;
    applyScheduled = true;
    scheduleFrame(() => {
      applyScheduled = false;
      const next = pendingApplyPrefs;
      pendingApplyPrefs = null;
      if (!next) return;
      applyPreferences(next);
      syncFormWithPreferences(next);
    });
  }

  /**
   * Debounced persistence to backend via BridgeClient
   */
  function scheduleSavePreferences(prefs) {
    if (!window.BridgeClient) return;

    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
    }

    saveDebounceTimer = setTimeout(async () => {
      try {
        await window.BridgeClient.savePreferences(prefs);
      } catch (err) {
        console.error('[Appearance] Error saving preferences:', err);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * 唯一偏好写入入口：写 store 后由 prefs:changed 监听统一应用 + 持久化，
   * 不再手动调用 applyPreferences（消除同一次变更被应用两次的问题）。
   */
  function onPreferenceChange(key, value) {
    if (!window.AppStore) return;

    window.AppStore.updatePreference(key, value);

    const currentPrefs = window.AppStore.getState().preferences;
    scheduleSavePreferences(currentPrefs);
  }

  /**
   * 字号滑块：rAF 合并，拖动过程中每帧最多应用一次
   */
  function scheduleFontSizeChange(value) {
    if (typeof value !== 'number') return;
    pendingFontSize = value;
    if (fontSizeScheduled) return;
    fontSizeScheduled = true;
    scheduleFrame(() => {
      fontSizeScheduled = false;
      const next = pendingFontSize;
      pendingFontSize = null;
      if (typeof next === 'number') onPreferenceChange('fontSize', next);
    });
  }

  /**
   * Open / Close Settings Drawer
   */
  function toggleSettingsDrawer(forceOpen) {
    const drawer = document.getElementById('settings-drawer');
    if (!drawer) return;

    const isOpen = typeof forceOpen === 'boolean' ? forceOpen : !drawer.classList.contains('open');

    // .hidden carries display:none; open/active drive the slide-in transform.
    // All three must be toggled together or the drawer stays invisible.
    drawer.classList.toggle('open', isOpen);
    drawer.classList.toggle('active', isOpen);
    drawer.classList.toggle('hidden', !isOpen);
    drawer.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

    if (window.AppStore && typeof window.AppStore.setState === 'function') {
      window.AppStore.setState({ settingsVisible: isOpen });
    }
  }

  /**
   * Sync form inputs in settings drawer with current preferences
   */
  function syncFormWithPreferences(prefs) {
    if (!prefs) return;

    // 正在编辑的控件不回写，避免打断用户输入/滑块拖动（光标跳动）
    const activeEl = document.activeElement;

    const elTheme = document.getElementById('pref-theme');
    if (elTheme) elTheme.value = prefs.theme || 'auto';

    const elCodeTheme = document.getElementById('pref-code-theme');
    if (elCodeTheme) elCodeTheme.value = prefs.codeTheme || 'github';

    const elFontFamily = document.getElementById('pref-font-family');
    if (elFontFamily) elFontFamily.value = prefs.fontFamily || 'sans';

    const elFontSize = document.getElementById('pref-font-size');
    const elFontSizeVal = document.getElementById('pref-font-size-val');
    if (elFontSize) {
      if (elFontSize !== activeEl) {
        elFontSize.value = prefs.fontSize || 16;
      }
      if (elFontSizeVal) {
        elFontSizeVal.textContent = (prefs.fontSize || 16) + 'px';
      }
    }

    const elMaxWidth = document.getElementById('pref-max-width');
    if (elMaxWidth) {
      // Option values are exactly "800px" / "1000px" / "1200px" / "1600px" / "100%".
      // Normalize legacy numeric values ("1000") to the canonical option value.
      let maxWidth = String(prefs.maxWidth === undefined || prefs.maxWidth === null ? '' : prefs.maxWidth).trim();
      if (/^\d+$/.test(maxWidth)) maxWidth = `${maxWidth}px`;
      if (maxWidth.toLowerCase() === '100%') maxWidth = '100%';
      if (!maxWidth) maxWidth = '1000px';
      elMaxWidth.value = maxWidth;
      // Unknown saved value: fall back to the default option instead of blank UI.
      if (elMaxWidth.value !== maxWidth) {
        elMaxWidth.value = '1000px';
      }
    }

    const elCentered = document.getElementById('pref-centered');
    if (elCentered) elCentered.checked = prefs.centered !== false;

    const elAutoSave = document.getElementById('pref-auto-save');
    if (elAutoSave) elAutoSave.checked = prefs.autoSave !== false;

    const elAutoRefresh = document.getElementById('pref-auto-refresh');
    if (elAutoRefresh) elAutoRefresh.checked = prefs.autoRefresh !== false;

    const elCustomCss = document.getElementById('pref-custom-css');
    if (elCustomCss && elCustomCss !== activeEl) {
      elCustomCss.value = prefs.customCss || '';
    }
  }

  /**
   * Bind event listeners to all settings form controls
   */
  function bindSettingsForm() {
    // Drawer buttons
    const btnToggleSettings = document.getElementById('btn-toggle-settings');
    if (btnToggleSettings) {
      btnToggleSettings.addEventListener('click', () => toggleSettingsDrawer());
    }

    const btnCloseSettings = document.getElementById('btn-close-settings');
    if (btnCloseSettings) {
      btnCloseSettings.addEventListener('click', () => toggleSettingsDrawer(false));
    }

    // Backdrop click to close
    const drawer = document.getElementById('settings-drawer');
    if (drawer) {
      drawer.addEventListener('click', (e) => {
        if (e.target === drawer) {
          toggleSettingsDrawer(false);
        }
      });
    }

    // 1. Theme select
    const elTheme = document.getElementById('pref-theme');
    if (elTheme) {
      elTheme.addEventListener('change', (e) => {
        onPreferenceChange('theme', e.target.value);
      });
    }

    // 2. Code Theme select
    const elCodeTheme = document.getElementById('pref-code-theme');
    if (elCodeTheme) {
      elCodeTheme.addEventListener('change', (e) => {
        onPreferenceChange('codeTheme', e.target.value);
      });
    }

    // 3. Font Family
    const elFontFamily = document.getElementById('pref-font-family');
    if (elFontFamily) {
      elFontFamily.addEventListener('change', (e) => {
        onPreferenceChange('fontFamily', e.target.value);
      });
    }

    // 4. Font Size
    const elFontSize = document.getElementById('pref-font-size');
    const elFontSizeVal = document.getElementById('pref-font-size-val');
    if (elFontSize) {
      elFontSize.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (!isNaN(val) && val >= 10 && val <= 36) {
          if (elFontSizeVal) {
            elFontSizeVal.textContent = val + 'px';
          }
          // rAF 合并：拖动滑块时每帧最多写一次偏好
          scheduleFontSizeChange(val);
        }
      });
    }

    // 5. Max Width
    const elMaxWidth = document.getElementById('pref-max-width');
    if (elMaxWidth) {
      elMaxWidth.addEventListener('input', (e) => {
        let val = e.target.value.trim();
        if (/^\d+$/.test(val)) val = `${val}px`;
        onPreferenceChange('maxWidth', val);
      });
    }

    // 6. Centered Checkbox
    const elCentered = document.getElementById('pref-centered');
    if (elCentered) {
      elCentered.addEventListener('change', (e) => {
        onPreferenceChange('centered', e.target.checked);
      });
    }

    // 7. Auto Save Checkbox
    const elAutoSave = document.getElementById('pref-auto-save');
    if (elAutoSave) {
      elAutoSave.addEventListener('change', (e) => {
        onPreferenceChange('autoSave', e.target.checked);
      });
    }

    // 8. Auto Refresh Checkbox
    const elAutoRefresh = document.getElementById('pref-auto-refresh');
    if (elAutoRefresh) {
      elAutoRefresh.addEventListener('change', (e) => {
        onPreferenceChange('autoRefresh', e.target.checked);
      });
    }

    // 9. Custom CSS Textarea
    const elCustomCss = document.getElementById('pref-custom-css');
    if (elCustomCss) {
      elCustomCss.addEventListener('input', (e) => {
        onPreferenceChange('customCss', e.target.value);
      });
    }
  }

  /**
   * Listen for system dark/light mode change
   */
  function listenSystemThemeChange() {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (window.AppStore) {
        const currentPrefs = window.AppStore.getState().preferences;
        if (currentPrefs.theme === 'auto') {
          scheduleApplyPreferences(currentPrefs);
        }
      }
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handler);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(handler);
    }
  }

  const Appearance = {
    init() {
      // 1. Bind form controls & drawer toggles
      bindSettingsForm();

      // 2. Listen to system dark/light changes
      listenSystemThemeChange();

      // 3. Listen to AppBus for external preference changes
      if (window.AppBus) {
        window.AppBus.on('prefs:changed', (payload) => {
          const prefs = (payload && payload.preferences) || (window.AppStore && window.AppStore.getState().preferences);
          if (prefs) {
            // 一帧合并：同一帧内多次偏好变更只应用一次
            scheduleApplyPreferences(prefs);
          }
        });
      }

      // 4. Apply initial preferences from store
      if (window.AppStore && typeof window.AppStore.getState === 'function') {
        const prefs = window.AppStore.getState().preferences;
        if (prefs) {
          applyPreferences(prefs);
          syncFormWithPreferences(prefs);
        }
      }
    },

    toggleDrawer(force) {
      toggleSettingsDrawer(force);
    },

    apply(prefs) {
      applyPreferences(prefs);
    },
  };

  window.Appearance = Appearance;
})();
