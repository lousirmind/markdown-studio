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

    root.setAttribute('data-theme', effectiveTheme);
    docEl.setAttribute('data-theme', effectiveTheme);

    // 2. Code Theme
    const codeTheme = prefs.codeTheme || 'github';
    root.setAttribute('data-code-theme', codeTheme);
    docEl.setAttribute('data-code-theme', codeTheme);

    // 3. Centered Layout
    const isCentered = prefs.centered !== false;
    root.setAttribute('data-centered', isCentered ? 'true' : 'false');
    docEl.setAttribute('data-centered', isCentered ? 'true' : 'false');

    // 4. Typography and Width CSS Variables
    const fontFamilyVal = FONT_FAMILIES[prefs.fontFamily] || prefs.fontFamily || FONT_FAMILIES.sans;
    const fontSizeVal = typeof prefs.fontSize === 'number' ? `${prefs.fontSize}px` : (prefs.fontSize || '16px');
    let maxWidthVal = prefs.maxWidth || '1000px';
    if (/^\d+$/.test(String(maxWidthVal).trim())) {
      maxWidthVal = `${maxWidthVal}px`;
    }

    docEl.style.setProperty('--md-font-family', fontFamilyVal);
    docEl.style.setProperty('--md-font-size', fontSizeVal);
    docEl.style.setProperty('--md-max-width', maxWidthVal);

    if (root !== docEl) {
      root.style.setProperty('--md-font-family', fontFamilyVal);
      root.style.setProperty('--md-font-size', fontSizeVal);
      root.style.setProperty('--md-max-width', maxWidthVal);
    }

    // 5. Custom CSS injection
    let customStyleEl = document.getElementById('user-custom-css');
    if (!customStyleEl) {
      customStyleEl = document.createElement('style');
      customStyleEl.id = 'user-custom-css';
      document.head.appendChild(customStyleEl);
    }
    customStyleEl.textContent = prefs.customCss || '';

    // 6. Notify EditorEngine of theme & code theme change
    if (window.EditorEngine && typeof window.EditorEngine.setTheme === 'function') {
      try {
        window.EditorEngine.setTheme(isDark, codeTheme);
      } catch (err) {
        console.warn('[Appearance] EditorEngine.setTheme error:', err);
      }
    }
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
   * Open / Close Settings Drawer
   */
  function toggleSettingsDrawer(forceOpen) {
    const drawer = document.getElementById('settings-drawer');
    if (!drawer) return;

    const isOpen = typeof forceOpen === 'boolean' ? forceOpen : !drawer.classList.contains('open');

    drawer.classList.toggle('open', isOpen);
    drawer.classList.toggle('active', isOpen);

    if (window.AppStore && typeof window.AppStore.setState === 'function') {
      window.AppStore.setState({ settingsVisible: isOpen });
    }
  }

  /**
   * Sync form inputs in settings drawer with current preferences
   */
  function syncFormWithPreferences(prefs) {
    if (!prefs) return;

    const elTheme = document.getElementById('pref-theme');
    if (elTheme) elTheme.value = prefs.theme || 'auto';

    const elCodeTheme = document.getElementById('pref-code-theme');
    if (elCodeTheme) elCodeTheme.value = prefs.codeTheme || 'github';

    const elFontFamily = document.getElementById('pref-font-family');
    if (elFontFamily) elFontFamily.value = prefs.fontFamily || 'sans';

    const elFontSize = document.getElementById('pref-font-size');
    const elFontSizeVal = document.getElementById('pref-font-size-val');
    if (elFontSize) {
      elFontSize.value = prefs.fontSize || 16;
      if (elFontSizeVal) {
        elFontSizeVal.textContent = `${prefs.fontSize || 16}px`;
      }
    }

    const elMaxWidth = document.getElementById('pref-max-width');
    if (elMaxWidth) {
      elMaxWidth.value = String(prefs.maxWidth || '1000px').replace(/px$/i, '');
    }

    const elCentered = document.getElementById('pref-centered');
    if (elCentered) elCentered.checked = prefs.centered !== false;

    const elAutoSave = document.getElementById('pref-auto-save');
    if (elAutoSave) elAutoSave.checked = prefs.autoSave !== false;

    const elAutoRefresh = document.getElementById('pref-auto-refresh');
    if (elAutoRefresh) elAutoRefresh.checked = prefs.autoRefresh !== false;

    const elCustomCss = document.getElementById('pref-custom-css');
    if (elCustomCss) elCustomCss.value = prefs.customCss || '';
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

    // Generic handler for preference change
    function onPreferenceChange(key, value) {
      if (!window.AppStore) return;

      window.AppStore.updatePreference(key, value);
      const currentPrefs = window.AppStore.getState().preferences;

      applyPreferences(currentPrefs);
      scheduleSavePreferences(currentPrefs);
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
            elFontSizeVal.textContent = `${val}px`;
          }
          onPreferenceChange('fontSize', val);
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
          applyPreferences(currentPrefs);
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
            applyPreferences(prefs);
            syncFormWithPreferences(prefs);
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
