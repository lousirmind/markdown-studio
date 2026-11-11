/**
 * SearchReplace - In-document find & replace for Markdown Studio.
 *
 * The search runs on the active tab's Markdown source
 * (AppStore.getActiveTab().content), so reader / ir / sv / wysiwyg modes all
 * behave identically. The panel is a non-modal floating overlay anchored at
 * the top-right: it never blocks editing and remembers its options for the
 * lifetime of the session (in memory only).
 */
(function () {
  'use strict';

  // Hard stop for pathological queries/documents (including >1MB files).
  // 20000 matches is far beyond anything a human reviews by hand and keeps
  // the UI responsive; once hit, replace-all is disabled rather than partial.
  const MAX_MATCHES = 20000;
  const EVENT_REFRESH_DEBOUNCE_MS = 120;
  const CONTEXT_CHARS = 60;

  // Session-only options. Deliberately not written to preferences.
  const state = {
    open: false,
    replaceVisible: false,
    caseSensitive: false,
    useRegex: false,
    wholeWord: false,
    matches: [],
    current: -1,
    truncated: false,
    error: '',
    message: '',
    snapshot: '',
    lastTabId: null,
  };

  const dom = {};
  let refreshTimer = null;
  let applying = false;

  function getActiveTab() {
    return window.AppStore && typeof window.AppStore.getActiveTab === 'function'
      ? window.AppStore.getActiveTab()
      : null;
  }

  function getSourceText() {
    const tab = getActiveTab();
    return tab && typeof tab.content === 'string' ? tab.content : '';
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Whole-word boundaries use ASCII word characters (letters, digits and _),
  // matching JS \b / \w and keeping CJK text searchable: Chinese characters
  // are boundaries, so "Markdown" still matches inside "Markdown编辑器".
  const WORD_CHAR_RE = /[A-Za-z0-9_]/;

  function isWordCharAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    return WORD_CHAR_RE.test(text.charAt(index));
  }

  /**
   * Build the global RegExp for the current query/options.
   * Regex + whole-word are combined by filtering raw matches with word
   * boundary checks, never by wrapping the user's pattern (which would break
   * anchors, alternation and lookarounds).
   */
  function buildRegex(query, options) {
    const source = options.useRegex ? query : escapeRegExp(query);
    let flags = 'gm';
    if (!options.caseSensitive) flags += 'i';
    try {
      return { regex: new RegExp(source, flags) };
    } catch (err) {
      return { error: (err && err.message) ? err.message : '无效的正则表达式' };
    }
  }

  function findMatches(text, regex, wholeWord) {
    const matches = [];
    let truncated = false;
    let guard = 0;
    regex.lastIndex = 0;

    let m;
    while ((m = regex.exec(text)) !== null) {
      guard += 1;
      const start = m.index;
      const value = m[0];
      const end = start + value.length;
      const boundariesOk = !wholeWord ||
        (!isWordCharAt(text, start - 1) && !isWordCharAt(text, end));

      if (boundariesOk) {
        matches.push({ start, end, text: value });
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          break;
        }
      }

      // Zero-length matches (^, \b, a*, ...) must advance lastIndex manually.
      if (value.length === 0 && regex.lastIndex === start) {
        regex.lastIndex = start + 1;
      }

      // Safety valve for exotic patterns that keep yielding empty matches.
      if (guard > text.length + MAX_MATCHES + 10) {
        truncated = true;
        break;
      }
    }

    return { matches, truncated };
  }

  function selectFromAnchor(anchor) {
    if (state.matches.length === 0) {
      state.current = -1;
      return;
    }
    const index = state.matches.findIndex((match) => match.start >= anchor);
    state.current = index === -1 ? 0 : index;
  }

  /**
   * Re-scan the active document. options:
   *   reset:  start again at the first match
   *   anchor: place the cursor on the first match at/after this source offset
   *   message: status text to keep after the re-scan
   */
  function recompute(options) {
    const opts = options || {};
    if (!state.open) return;

    const tab = getActiveTab();
    const text = tab && typeof tab.content === 'string' ? tab.content : '';
    state.snapshot = text;
    state.error = '';
    state.message = typeof opts.message === 'string' ? opts.message : '';
    state.truncated = false;

    const query = dom.findInput ? dom.findInput.value : '';
    if (!tab || !text || !query) {
      state.matches = [];
      state.current = -1;
      render();
      clearDomHighlights();
      return;
    }

    const built = buildRegex(query, state);
    if (built.error) {
      state.matches = [];
      state.current = -1;
      state.error = '正则表达式无效：' + built.error;
      render();
      clearDomHighlights();
      return;
    }

    const result = findMatches(text, built.regex, state.wholeWord);
    state.matches = result.matches;
    state.truncated = result.truncated;

    const total = state.matches.length;
    if (total === 0) {
      state.current = -1;
    } else if (typeof opts.anchor === 'number') {
      selectFromAnchor(opts.anchor);
    } else if (opts.reset || state.current < 0 || state.current >= total) {
      state.current = 0;
    }

    render();
    applyDomHighlights();
    if (opts.reveal) revealCurrent();
  }

  function goNext() {
    if (!state.open || state.matches.length === 0) {
      render();
      return;
    }
    state.current = (state.current + 1) % state.matches.length;
    render();
    applyDomHighlights();
    revealCurrent();
  }

  function goPrevious() {
    if (!state.open || state.matches.length === 0) {
      render();
      return;
    }
    const total = state.matches.length;
    state.current = (state.current - 1 + total) % total;
    render();
    applyDomHighlights();
    revealCurrent();
  }

  function render() {
    const total = state.matches.length;
    const hasCurrent = total > 0 && state.current >= 0;
    if (dom.count) {
      dom.count.textContent = hasCurrent ? (state.current + 1) + '/' + total : '0/0';
    }

    if (dom.prev) dom.prev.disabled = total === 0;
    if (dom.next) dom.next.disabled = total === 0;
    if (dom.replaceOne) dom.replaceOne.disabled = total === 0;
    if (dom.replaceAll) dom.replaceAll.disabled = total === 0 || state.truncated;

    if (dom.message) {
      let message = '';
      if (state.error) {
        message = state.error;
      } else if (state.truncated) {
        message = '匹配超过 ' + MAX_MATCHES + ' 个，已暂停「全部替换」';
      } else if (state.message) {
        message = state.message;
      }
      dom.message.textContent = message;
      dom.message.classList.toggle('sr-message-error', !!state.error);
      dom.message.classList.toggle(
        'sr-message-ok',
        !state.error && !!(state.message || state.truncated)
      );
    }

    if (dom.panel) {
      dom.panel.classList.toggle('sr-has-error', !!state.error);
    }

    renderPreview();
  }

  function renderPreview() {
    if (!dom.preview || !dom.previewText) return;
    const match = state.current >= 0 ? state.matches[state.current] : null;
    if (!match || state.error) {
      dom.preview.classList.add('hidden');
      return;
    }

    dom.preview.classList.remove('hidden');

    const text = state.snapshot;
    const start = Math.max(0, match.start - CONTEXT_CHARS);
    const end = Math.min(text.length, match.end + CONTEXT_CHARS);
    const before = text.slice(start, match.start).replace(/\s+/g, ' ');
    const after = text.slice(match.end, end).replace(/\s+/g, ' ');

    dom.previewText.textContent = '';
    if (start > 0) dom.previewText.appendChild(document.createTextNode('…'));
    if (before) dom.previewText.appendChild(document.createTextNode(before));

    const mark = document.createElement('mark');
    mark.className = 'sr-mark';
    mark.textContent = match.text || '∅';
    dom.previewText.appendChild(mark);

    if (after) dom.previewText.appendChild(document.createTextNode(after));
    if (end < text.length) dom.previewText.appendChild(document.createTextNode('…'));
  }

  function sameMatchText(a, b) {
    return state.caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Ordinal of the current match among earlier matches with the same text.
   * Used to scroll to the correct occurrence in the rendered DOM.
   */
  function occurrenceOrdinal(index, value) {
    let ordinal = 0;
    for (let i = 0; i < index; i++) {
      if (sameMatchText(state.matches[i].text, value)) ordinal += 1;
    }
    return ordinal;
  }

  function closestBlock(el) {
    if (!el) return null;
    if (typeof el.closest === 'function') {
      const block = el.closest(
        'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, .vditor-ir__node, div'
      );
      if (block) return block;
    }
    return el;
  }

  function getSearchRoot() {
    const mode = window.AppStore ? window.AppStore.getState().editorMode : 'ir';
    if (mode === 'reader') {
      return document.getElementById('reader-container');
    }

    const container = document.getElementById('vditor-container');
    if (!container) return null;

    const selectorsByMode = {
      ir: ['.vditor-ir .vditor-reset'],
      wysiwyg: ['.vditor-wysiwyg .vditor-reset'],
      // SV mode: the source pane itself is a contenteditable <pre> with text
      // nodes (Vditor's preview is lazily paginated), so highlight the source;
      // fall back to the preview container when the source is unavailable.
      sv: ['.vditor-sv', '.vditor-preview .vditor-reset'],
    };
    const selectors = selectorsByMode[mode] || [];
    for (let i = 0; i < selectors.length; i++) {
      const el = container.querySelector(selectors[i]);
      if (el) return el;
    }
    return container.querySelector('.vditor-reset');
  }

  // -------------------------------------------------------------------------
  // Rendered-DOM highlighting (CSS Custom Highlight API)
  // -------------------------------------------------------------------------
  // The panel counts matches in the Markdown source; for the visual highlight we
  // scan the rendered text nodes (same query/options) and register ranges with
  // CSS.highlights. This never mutates the editor DOM, so Vditor keeps working.
  const HL_MATCH = 'ms-search-match';
  const HL_CURRENT = 'ms-search-current';
  const HL_MAX_RANGES = 3000;
  let highlightRanges = [];
  let fallbackMarks = [];

  function supportsHighlightApi() {
    return !!(window.CSS && window.CSS.highlights && typeof window.Highlight === 'function');
  }

  function collectTextSegments(root) {
    const segments = [];
    let fullText = '';
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
    } catch (e) {
      return { segments: segments, fullText: fullText };
    }
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || '';
      if (!value) continue;
      segments.push({ node: node, start: fullText.length, end: fullText.length + value.length });
      fullText += value;
    }
    return { segments: segments, fullText: fullText };
  }

  function findSegmentAt(segments, offset) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const seg = segments[mid];
      if (offset < seg.start) {
        high = mid - 1;
      } else if (offset >= seg.end) {
        low = mid + 1;
      } else {
        return seg;
      }
    }
    return null;
  }

  function rangeFromOffsets(segments, start, end) {
    if (end <= start) return null;
    const startSeg = findSegmentAt(segments, start);
    const endSeg = findSegmentAt(segments, end - 1);
    if (!startSeg || !endSeg) return null;
    try {
      const range = document.createRange();
      range.setStart(startSeg.node, start - startSeg.start);
      range.setEnd(endSeg.node, end - endSeg.start);
      return range;
    } catch (e) {
      return null;
    }
  }

  function clearDomHighlights() {
    highlightRanges = [];
    try {
      if (supportsHighlightApi()) {
        window.CSS.highlights.delete(HL_MATCH);
        window.CSS.highlights.delete(HL_CURRENT);
      }
    } catch (e) {}
    fallbackMarks.forEach(function (mark) {
      try {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      } catch (e) {}
    });
    fallbackMarks = [];
  }

  function applyFallbackMarks(root, ranges, currentIndex) {
    // Progressive fallback for WebKit builds without CSS.highlights: only the
    // reader DOM is safe to mutate (editor modes are contenteditable).
    const mode = window.AppStore ? window.AppStore.getState().editorMode : 'ir';
    if (mode !== 'reader') return;
    ranges.forEach(function (range, index) {
      try {
        const mark = document.createElement('mark');
        mark.className = index === currentIndex ? 'sr-dom-mark sr-dom-mark-current' : 'sr-dom-mark';
        range.surroundContents(mark);
        fallbackMarks.push(mark);
      } catch (e) {}
    });
  }

  function applyDomHighlights() {
    clearDomHighlights();
    if (!state.open) return;

    const query = dom.findInput ? dom.findInput.value : '';
    if (!query) return;

    const root = getSearchRoot();
    if (!root) return;

    const collected = collectTextSegments(root);
    if (!collected.fullText) return;

    const built = buildRegex(query, state);
    if (built.error) return;

    const result = findMatches(collected.fullText, built.regex, state.wholeWord);
    const ranges = [];
    for (let i = 0; i < result.matches.length && ranges.length < HL_MAX_RANGES; i++) {
      const match = result.matches[i];
      const range = rangeFromOffsets(collected.segments, match.start, match.end);
      if (range) ranges.push(range);
    }
    highlightRanges = ranges;
    if (!ranges.length) return;

    const currentIndex = state.current >= 0 ? Math.min(state.current, ranges.length - 1) : 0;
    if (supportsHighlightApi()) {
      try {
        window.CSS.highlights.set(HL_MATCH, new window.Highlight(...ranges));
        window.CSS.highlights.set(HL_CURRENT, new window.Highlight(ranges[currentIndex]));
      } catch (e) {
        // Very large highlight sets can fail; visual highlight is best-effort.
      }
    } else {
      applyFallbackMarks(root, ranges, currentIndex);
    }
  }

  function scrollToHighlight(index) {
    if (!highlightRanges.length) return false;
    const range = highlightRanges[Math.max(0, Math.min(index, highlightRanges.length - 1))];
    if (!range) return false;
    try {
      const rect = range.getBoundingClientRect();
      const topLimit = 80;
      const bottomLimit = window.innerHeight - 80;
      if (rect && (rect.top < topLimit || rect.bottom > bottomLimit || rect.height === 0)) {
        const node = range.startContainer;
        const block = closestBlock(node && node.parentElement ? node.parentElement : node);
        if (block && typeof block.scrollIntoView === 'function') {
          block.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  /**
   * Best-effort "make the current match visible". In reader mode the rendered
   * DOM contains the text directly; in editor modes it usually does too. When
   * the rendered text differs from the source (e.g. Markdown syntax), we skip
   * silently - the context preview in the panel always shows the match.
   */
  function revealInDom(needle, ordinal, caseSensitive) {
    if (!needle) return;
    const root = getSearchRoot();
    if (!root) return;

    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (parent && (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
    } catch (e) {
      return;
    }

    const segments = [];
    let fullText = '';
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || '';
      if (!value) continue;
      segments.push({ node, start: fullText.length, end: fullText.length + value.length });
      fullText += value;
    }
    if (!fullText) return;

    const haystack = caseSensitive ? fullText : fullText.toLowerCase();
    const pin = caseSensitive ? needle : needle.toLowerCase();
    if (!pin) return;

    let from = 0;
    let found = -1;
    for (let i = 0; i <= ordinal; i++) {
      found = haystack.indexOf(pin, from);
      if (found === -1) return;
      from = found + Math.max(1, pin.length);
    }
    if (found === -1) return;

    let low = 0;
    let high = segments.length - 1;
    let segment = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidate = segments[mid];
      if (found < candidate.start) {
        high = mid - 1;
      } else if (found >= candidate.end) {
        low = mid + 1;
      } else {
        segment = candidate;
        break;
      }
    }
    if (!segment) return;

    try {
      const block = closestBlock(segment.node.parentElement);
      if (block && typeof block.scrollIntoView === 'function') {
        block.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } catch (e) {
      // Scrolling is a progressive enhancement; never let it break the panel.
    }
  }

  function revealCurrent() {
    // Prefer the rendered highlight range (exact position); fall back to the
    // source-text heuristic when the rendered DOM does not contain the match.
    if (scrollToHighlight(state.current)) return;
    const match = state.current >= 0 ? state.matches[state.current] : null;
    if (!match || !match.text) return;
    revealInDom(match.text, occurrenceOrdinal(state.current, match.text), state.caseSensitive);
  }

  /**
   * Push new Markdown to every consumer: editor view, AppStore, auto-save and
   * the render/outline/status-bar listeners. Falls back to the individual
   * public APIs when applyExternalContent is unavailable.
   */
  function applyContent(newText, anchor, message) {
    const tab = getActiveTab();
    if (!tab) return;

    applying = true;
    try {
      if (window.EditorEngine && typeof window.EditorEngine.applyExternalContent === 'function') {
        window.EditorEngine.applyExternalContent(newText);
      } else {
        if (window.AppStore) window.AppStore.updateActiveTabContent(newText);
        if (window.EditorEngine && typeof window.EditorEngine.setValue === 'function') {
          window.EditorEngine.setValue(newText);
        }
        if (window.AppBus) {
          window.AppBus.emit('editor:content-changed', {
            path: tab.path,
            content: newText,
          });
        }
      }
    } finally {
      applying = false;
    }

    recompute({
      anchor: typeof anchor === 'number' ? anchor : undefined,
      message,
      reveal: true,
    });
  }

  function replaceCurrent() {
    if (!state.open || state.error) return;
    if (state.current < 0 || state.current >= state.matches.length) return;

    // Stale indices would corrupt the document: re-scan instead of guessing.
    if (getSourceText() !== state.snapshot) {
      recompute({ reset: false, reveal: true });
      return;
    }

    const match = state.matches[state.current];
    const text = state.snapshot;
    const replacement = dom.replaceInput ? dom.replaceInput.value : '';
    const newText = text.slice(0, match.start) + replacement + text.slice(match.end);

    // Replacing with the identical text is a no-op; still advance the cursor.
    if (newText === text) {
      selectFromAnchor(match.start + Math.max(1, match.text.length));
      render();
      revealCurrent();
      return;
    }

    const anchor = match.start + replacement.length;
    applyContent(newText, anchor, '已替换 1 处');
  }

  function replaceAll() {
    if (!state.open || state.error || state.truncated) return;
    if (state.matches.length === 0) return;

    if (getSourceText() !== state.snapshot) {
      recompute({ reset: false, reveal: true });
      return;
    }

    const text = state.snapshot;
    const replacement = dom.replaceInput ? dom.replaceInput.value : '';
    const count = state.matches.length;
    let output = '';
    let cursor = 0;

    for (let i = 0; i < state.matches.length; i++) {
      const match = state.matches[i];
      output += text.slice(cursor, match.start) + replacement;
      cursor = match.end;
    }
    output += text.slice(cursor);

    if (output === text) {
      selectFromAnchor(0);
      render();
      return;
    }

    applyContent(output, 0, '已全部替换 ' + count + ' 处');
  }

  function copyCurrentMatch() {
    const match = state.current >= 0 ? state.matches[state.current] : null;
    if (!match) return;

    const value = match.text;
    const done = () => {
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', { message: '已复制匹配内容', type: 'success' });
      }
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done));
    } else {
      fallbackCopy(value, done);
    }
  }

  function fallbackCopy(value, done) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      done();
    } catch (e) {
      // Clipboard permission denied: nothing sensible to do.
    }
  }

  function setReplaceVisible(visible) {
    state.replaceVisible = !!visible;
    if (dom.replaceRow) {
      dom.replaceRow.classList.toggle('hidden', !state.replaceVisible);
    }
    if (dom.toggleReplace) {
      dom.toggleReplace.setAttribute('aria-expanded', state.replaceVisible ? 'true' : 'false');
      dom.toggleReplace.classList.toggle('expanded', state.replaceVisible);
      dom.toggleReplace.title = state.replaceVisible
        ? '收起替换 (Cmd/Ctrl+Alt+F)'
        : '展开替换 (Cmd/Ctrl+Alt+F)';
    }
  }

  function openPanel(options) {
    const opts = options || {};
    if (!dom.panel) return;

    const wasOpen = state.open;
    const tab = getActiveTab();
    state.open = true;
    state.lastTabId = tab ? tab.id : null;

    dom.panel.classList.remove('hidden');
    dom.panel.setAttribute('aria-hidden', 'false');
    if (dom.searchButton) dom.searchButton.classList.add('active');
    if (opts.showReplace) setReplaceVisible(true);

    if (opts.focus !== false && dom.findInput) {
      dom.findInput.focus();
      dom.findInput.select();
    }

    // First open starts from the top of the document; re-focusing an already
    // open panel keeps the user's current match.
    recompute({ reset: !wasOpen, reveal: true });
  }

  function closePanel() {
    if (!state.open) return;

    state.open = false;
    state.error = '';
    state.message = '';
    clearDomHighlights();
    if (dom.panel) {
      dom.panel.classList.add('hidden');
      dom.panel.setAttribute('aria-hidden', 'true');
    }
    if (dom.searchButton) dom.searchButton.classList.remove('active');

    clearTimeout(refreshTimer);
    refreshTimer = null;

    const active = document.activeElement;
    const focusInside = !!(active && dom.panel && dom.panel.contains(active));
    if (focusInside && window.EditorEngine && typeof window.EditorEngine.focus === 'function') {
      window.EditorEngine.focus();
    }
  }

  function scheduleRefresh(reset) {
    if (!state.open) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      recompute({ reset: !!reset, reveal: false });
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }

  function handleTabContextChanged() {
    if (!state.open) return;
    const tab = getActiveTab();
    if (!tab) {
      closePanel();
      return;
    }
    const changed = tab.id !== state.lastTabId;
    state.lastTabId = tab.id;
    // A different document restarts at its first match; a re-activation of the
    // same document keeps the current match position.
    recompute({ reset: changed, reveal: false });
  }

  function handleContentChanged() {
    if (!state.open || applying) return;
    scheduleRefresh(false);
  }

  function onGlobalKeydown(e) {
    const key = String(e.key || '').toLowerCase();
    const mod = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+F: open & focus (or re-focus an open panel).
    if (mod && !e.altKey && key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openPanel({ focus: true });
      return;
    }

    // Cmd/Ctrl+Alt+F: open with the replace row expanded.
    if (mod && e.altKey && key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openPanel({ focus: true, showReplace: true });
      if (dom.replaceInput) dom.replaceInput.focus();
      return;
    }

    if (e.key === 'Escape' && state.open) {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    }
  }

  function cacheDom() {
    dom.panel = document.getElementById('search-replace-panel');
    dom.findInput = document.getElementById('sr-find-input');
    dom.replaceInput = document.getElementById('sr-replace-input');
    dom.replaceRow = document.getElementById('sr-replace-row');
    dom.count = document.getElementById('sr-count');
    dom.prev = document.getElementById('sr-prev');
    dom.next = document.getElementById('sr-next');
    dom.close = document.getElementById('sr-close');
    dom.toggleReplace = document.getElementById('sr-toggle-replace');
    dom.replaceOne = document.getElementById('sr-replace-one');
    dom.replaceAll = document.getElementById('sr-replace-all');
    dom.caseToggle = document.getElementById('sr-option-case');
    dom.regexToggle = document.getElementById('sr-option-regex');
    dom.wholeToggle = document.getElementById('sr-option-whole');
    dom.message = document.getElementById('sr-message');
    dom.preview = document.getElementById('sr-preview');
    dom.previewText = document.getElementById('sr-preview-text');
    dom.copy = document.getElementById('sr-copy');
    dom.searchButton = document.getElementById('btn-search');
  }

  function bindEvents() {
    if (dom.searchButton) {
      dom.searchButton.addEventListener('click', function () {
        openPanel({ focus: true });
      });
    }
    if (dom.close) dom.close.addEventListener('click', closePanel);
    if (dom.next) dom.next.addEventListener('click', goNext);
    if (dom.prev) dom.prev.addEventListener('click', goPrevious);
    if (dom.toggleReplace) {
      dom.toggleReplace.addEventListener('click', function () {
        setReplaceVisible(!state.replaceVisible);
      });
    }
    if (dom.replaceOne) dom.replaceOne.addEventListener('click', replaceCurrent);
    if (dom.replaceAll) dom.replaceAll.addEventListener('click', replaceAll);
    if (dom.copy) dom.copy.addEventListener('click', copyCurrentMatch);

    if (dom.findInput) {
      dom.findInput.addEventListener('input', function () {
        recompute({ reset: true, reveal: true });
      });
      dom.findInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {
            goPrevious();
          } else {
            goNext();
          }
        }
      });
    }

    if (dom.replaceInput) {
      dom.replaceInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          replaceCurrent();
        }
      });
    }

    const optionBindings = [
      { input: dom.caseToggle, key: 'caseSensitive' },
      { input: dom.regexToggle, key: 'useRegex' },
      { input: dom.wholeToggle, key: 'wholeWord' },
    ];
    optionBindings.forEach(function (binding) {
      if (!binding.input) return;
      binding.input.checked = !!state[binding.key];
      binding.input.addEventListener('change', function () {
        state[binding.key] = !!binding.input.checked;
        recompute({ reset: true, reveal: true });
      });
    });

    document.addEventListener('keydown', onGlobalKeydown, true);

    if (window.AppBus) {
      window.AppBus.on('tab:activated', handleTabContextChanged);
      window.AppBus.on('tab:switched', handleTabContextChanged);
      window.AppBus.on('tab:closed', handleTabContextChanged);
      window.AppBus.on('editor:content-changed', handleContentChanged);
      window.AppBus.on('editor:mode-changed', handleContentChanged);
      window.AppBus.on('editor:rendered', handleContentChanged);
    }
  }

  const SearchReplace = {
    init() {
      cacheDom();
      if (!dom.panel) return;
      bindEvents();
      setReplaceVisible(false);
      render();
    },

    open(options) {
      openPanel(options);
    },

    close() {
      closePanel();
    },

    isOpen() {
      return state.open;
    },

    next() {
      goNext();
    },

    previous() {
      goPrevious();
    },

    replaceCurrent() {
      replaceCurrent();
    },

    replaceAll() {
      replaceAll();
    },

    // Small read-only surface used by acceptance scripts and future modules.
    getMatches() {
      return state.matches.map(function (match) {
        return { start: match.start, end: match.end, text: match.text };
      });
    },

    getCurrentIndex() {
      return state.current;
    },

    getOptions() {
      return {
        caseSensitive: state.caseSensitive,
        useRegex: state.useRegex,
        wholeWord: state.wholeWord,
      };
    },
  };

  window.SearchReplace = SearchReplace;
})();
