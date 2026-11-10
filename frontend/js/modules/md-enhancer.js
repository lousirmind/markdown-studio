/**
 * Markdown Enhancer - Non-intrusive post-render enhancements for Markdown containers.
 * 1. Callout / Alert block styling (GitHub & Obsidian styles: NOTE, TIP, IMPORTANT, WARNING, CAUTION, etc.)
 * 2. Extended Image sizing syntax (|300x200, |300, =300x200)
 * 3. Click-to-lightbox integration
 * 4. Interactive task list checkbox toggling in Reader mode
 */
(function () {
  'use strict';

  // SVG Icons for callout types
  const CALLOUT_ICONS = {
    note: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`,
    tip: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.913.307.54.414 1.01.414 1.78h3.43c0-.77.107-1.24.414-1.78.203-.357.45-.65.673-.913l.214-.253.003-.004C11.576 6.875 12 6.234 12 5.25 12 3.19 10.363 1.5 8 1.5ZM5.5 12h5a.75.75 0 0 1 0 1.5h-5a.75.75 0 0 1 0-1.5Zm1 2.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>`,
    important: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 3.75a.75.75 0 0 1 1.5 0v5.5a.75.75 0 0 1-1.5 0ZM8 12a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`,
    warning: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>`,
    caution: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM4.47 4.47a.75.75 0 0 1 1.06 0L8 6.94l2.47-2.47a.75.75 0 1 1 1.06 1.06L9.06 8l2.47 2.47a.75.75 0 1 1-1.06 1.06L8 9.06l-2.47 2.47a.75.75 0 0 1-1.06-1.06L6.94 8 4.47 5.53a.75.75 0 0 1 0-1.06Z"/></svg>`,
    danger: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.56 1.25a.75.75 0 0 1 .88 0c1.07.78 2.07 1.8 2.65 3.01.6 1.25.66 2.68.17 3.95-.5 1.3-1.46 2.3-2.6 2.87-.2.1-.42.1-.62 0-1.14-.57-2.1-1.57-2.6-2.87-.49-1.27-.43-2.7.17-3.95.58-1.21 1.58-2.23 2.65-3.01Z"/></svg>`,
  };

  const CALLOUT_TYPE_MAP = {
    note: 'note',
    info: 'note',
    tip: 'tip',
    hint: 'tip',
    important: 'important',
    warning: 'warning',
    caution: 'caution',
    danger: 'danger',
    bug: 'danger',
    failure: 'danger',
    fail: 'danger',
    error: 'danger',
  };

  // ---------------- 渲染增强调度（P2-7） ----------------
  // 高频 editor:rendered 不再逐次全量扫描，统一合并到约 150ms 后执行一次。
  const ENHANCE_DEBOUNCE_MS = 150;
  let enhanceTimer = null;
  let pendingEnhanceContainer = null;
  let listenersBound = false;

  /**
   * 解析当前活动的渲染容器（payload 缺失时的兜底）。
   */
  function resolveContainer() {
    const store = window.AppStore ? window.AppStore.getState() : {};
    const mode = store.editorMode || 'ir';
    if (mode === 'reader') {
      return document.getElementById('reader-container');
    }
    return (
      document.querySelector('#vditor-container .vditor-reset') ||
      document.getElementById('vditor-container')
    );
  }

  /**
   * 合并调度：同一批 rendered 事件只做一次增强扫描。
   */
  function scheduleEnhance(containerEl, delay) {
    if (containerEl) pendingEnhanceContainer = containerEl;
    if (enhanceTimer) clearTimeout(enhanceTimer);
    enhanceTimer = setTimeout(() => {
      enhanceTimer = null;
      let container = pendingEnhanceContainer;
      pendingEnhanceContainer = null;
      // 目标容器已被替换/移除时，改为增强当前活动容器
      if (!container || container.isConnected === false) {
        container = resolveContainer();
      }
      enhance(container);
    }, typeof delay === 'number' ? delay : ENHANCE_DEBOUNCE_MS);
  }

  /**
   * 1. Callout / Alert Container Enhancement
   */
  function enhanceCallouts(containerEl) {
    const blockquotes = containerEl.querySelectorAll('blockquote');

    blockquotes.forEach((bq) => {
      // Avoid re-processing（幂等：已增强的 blockquote 直接跳过）
      if (bq.classList.contains('md-callout') || bq.dataset.mdCallout === '1') return;

      const firstChild = bq.firstElementChild;
      if (!firstChild || firstChild.tagName !== 'P') return;

      const firstText = firstChild.innerHTML || '';
      const match = firstText.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|DANGER|INFO|QUESTION|SUCCESS|BUG|FAILURE)\](?:\s+([^\n<]+))?/i);

      if (match) {
        const rawType = match[1].toLowerCase();
        const calloutType = CALLOUT_TYPE_MAP[rawType] || 'note';
        const customTitle = match[2] ? match[2].trim() : match[1].toUpperCase();

        bq.classList.add('md-callout', 'md-callout-' + calloutType);
        bq.dataset.mdCallout = '1';

        const iconSvg = CALLOUT_ICONS[calloutType] || CALLOUT_ICONS.note;

        // Header element
        const headerEl = document.createElement('div');
        headerEl.className = 'md-callout-header';
        headerEl.innerHTML = `
          <span class="md-callout-icon">${iconSvg}</span>
          <span class="md-callout-title">${customTitle}</span>
        `;

        // Strip the [!TYPE] line from the first paragraph
        const remainder = firstText.replace(/^\s*\[!(?:[a-zA-Z]+)\](?:\s+[^\n<]+)?(?:<br\s*\/?>)?\s*/i, '');

        if (remainder.trim()) {
          firstChild.innerHTML = remainder;
          bq.insertBefore(headerEl, firstChild);
        } else {
          // If first paragraph was ONLY the title tag, replace it with header
          bq.replaceChild(headerEl, firstChild);
        }
      }
    });
  }

  /**
   * 2. Image Dimension Syntax Parsing (|300x200, |300, =300x200)
   */
  function enhanceImageDimensions(containerEl) {
    const imgs = containerEl.querySelectorAll('img');

    imgs.forEach((img) => {
      // 已处理过的图片直接跳过（幂等）
      if (img.dataset.mdSized === '1') return;

      const alt = img.getAttribute('alt') || '';

      // Pattern 1: Obsidian style: ![alt|300x200](...) or ![alt|300](...)
      const obsidianMatch = alt.match(/^(.*?)\|(\d+)(?:x(\d+))?$/i);
      if (obsidianMatch) {
        const cleanAlt = obsidianMatch[1].trim();
        const width = obsidianMatch[2];
        const height = obsidianMatch[3];

        img.setAttribute('alt', cleanAlt);
        if (cleanAlt) img.setAttribute('title', cleanAlt);
        img.style.width = width + 'px';
        if (height) {
          img.style.height = height + 'px';
        }
        img.dataset.mdSized = '1';
        return;
      }

      // Pattern 2: Extended syntax: ![alt =300x200](...) or ![alt =300](...)
      const equalsMatch = alt.match(/^(.*?)\s*=(\d+)(?:x(\d+))?$/i);
      if (equalsMatch) {
        const cleanAlt = equalsMatch[1].trim();
        const width = equalsMatch[2];
        const height = equalsMatch[3];

        img.setAttribute('alt', cleanAlt);
        if (cleanAlt) img.setAttribute('title', cleanAlt);
        img.style.width = width + 'px';
        if (height) {
          img.style.height = height + 'px';
        }
      }

      // 无尺寸语法也标记，避免下次重复匹配
      img.dataset.mdSized = '1';
    });
  }

  /**
   * 3. Click Image to Open Lightbox
   */
  function enhanceImageLightbox(containerEl) {
    const rawImgs = containerEl.querySelectorAll('img');
    const images = [];

    rawImgs.forEach((img) => {
      // Skip callout icons, small decorative icons, or badge SVGs
      if (img.closest('.md-callout-header')) return;
      images.push(img);
    });

    const allImagesData = images.map((img, idx) => ({
      index: idx,
      src: img.src,
      alt: img.getAttribute('alt') || '',
      title: img.getAttribute('title') || img.getAttribute('alt') || '',
    }));

    images.forEach((img, idx) => {
      if (img.dataset.mdLightbox !== '1') {
        img.dataset.mdLightbox = '1';
        img.classList.add('lightbox-trigger');
        img.style.cursor = 'zoom-in';
      }

      // 覆盖式绑定（onclick 赋值），重复执行不会累积监听器
      img.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.AppBus) {
          window.AppBus.emit('lightbox:open', {
            src: img.src,
            alt: img.getAttribute('alt') || '',
            allImages: allImagesData,
            index: idx,
          });
        }
      };
    });
  }

  /**
   * 4. Interactive Task List Checkboxes in Reader Mode
   */
  function enhanceTaskLists(containerEl) {
    const store = window.AppStore ? window.AppStore.getState() : {};
    const isReaderMode = store.editorMode === 'reader';

    const checkboxes = containerEl.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length === 0) return;

    checkboxes.forEach((cb, index) => {
      if (isReaderMode) {
        // Enable clickable interaction in reader mode（仅在需要时改 DOM）
        if (cb.hasAttribute('disabled')) cb.removeAttribute('disabled');
        if (cb.style.cursor !== 'pointer') cb.style.cursor = 'pointer';

        cb.onchange = (e) => {
          e.stopPropagation();
          const isChecked = cb.checked;
          toggleMarkdownCheckbox(index, isChecked);
        };
      } else {
        // In editor mode, Vditor manages clicks inside editor
        if (cb.style.cursor !== 'default') cb.style.cursor = 'default';
      }
    });
  }

  /**
   * Toggle the N-th task checkbox in the active Markdown source document.
   */
  function toggleMarkdownCheckbox(targetIndex, newChecked) {
    if (!window.AppStore || !window.EditorEngine) return;

    const activeTab = window.AppStore.getActiveTab();
    if (!activeTab || typeof activeTab.content !== 'string') return;

    const content = activeTab.content;
    let currentIndex = 0;

    // Matches: "- [ ]", "* [ ]", "+ [ ]", "- [x]", etc.
    const taskRegex = /(^|\n)([ \t]*[-*+]\s+\[)([ xX])(\]\s+)/g;

    const updatedContent = content.replace(taskRegex, (fullMatch, prefix, lead, checkChar, tail) => {
      if (currentIndex === targetIndex) {
        currentIndex++;
        const replacementChar = newChecked ? 'x' : ' ';
        return `${prefix}${lead}${replacementChar}${tail}`;
      }
      currentIndex++;
      return fullMatch;
    });

    if (updatedContent !== content) {
      window.AppStore.updateActiveTabContent(updatedContent);

      if (window.AppBus) {
        window.AppBus.emit('editor:content-changed', {
          path: activeTab.path,
          content: updatedContent,
        });

        // If auto-save preference is enabled, trigger save
        const prefs = window.AppStore.getState().preferences || {};
        if (prefs.autoSave) {
          window.AppBus.emit('file:save-request', { tab: activeTab });
        }
      }
    }
  }

  /**
   * Main enhancer entry point
   */
  function enhance(containerEl) {
    if (!containerEl) return;

    enhanceCallouts(containerEl);
    enhanceImageDimensions(containerEl);
    enhanceImageLightbox(containerEl);
    enhanceTaskLists(containerEl);
  }

  // Bind to AppBus
  function setup() {
    if (listenersBound) return;
    if (window.AppBus) {
      listenersBound = true;
      window.AppBus.on('editor:rendered', (payload) => {
        // 与 TOC 刷新节奏错开但同样合并：一批 rendered 只增强一次
        scheduleEnhance(payload && payload.containerEl, ENHANCE_DEBOUNCE_MS);
      });
    }
  }

  window.MdEnhancer = {
    enhance,
    setup,
    init: setup,
    schedule: scheduleEnhance,
  };

  setup();
})();
