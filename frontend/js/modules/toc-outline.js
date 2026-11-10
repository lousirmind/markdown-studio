/**
 * TocOutline Module
 * Responsible for sidebar panel switching (TOC / File Tree),
 * parsing headings from rendered Markdown content, building a hierarchical
 * collapsible Table of Contents tree, real-time searching, smooth navigation,
 * and throttled ScrollSpy synchronization.
 *
 * Fully decoupled: communicates strictly through window.AppBus and window.AppStore.
 */
(function () {
  'use strict';

  // Private state
  let currentHeadings = [];
  let isScrollingFromClick = false;
  let scrollTimeout = null;
  let lastScrollTime = 0;
  const SCROLL_THROTTLE_MS = 80;

  /**
   * Escape HTML to prevent XSS in TOC item titles.
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
   * Helper to safely query container element for rendered content.
   */
  function getRenderContainer() {
    const store = window.AppStore ? window.AppStore.getState() : {};
    const mode = store.editorMode || 'ir';
    if (mode === 'reader') {
      return document.getElementById('reader-container');
    }
    const vditorContainer = document.getElementById('vditor-container');
    if (vditorContainer) {
      if (mode === 'ir') {
        const irEl = vditorContainer.querySelector('.vditor-ir .vditor-reset');
        if (irEl) return irEl;
      } else if (mode === 'sv') {
        const preview = vditorContainer.querySelector('.vditor-preview .vditor-reset') ||
                        vditorContainer.querySelector('.vditor-preview');
        if (preview) return preview;
      } else if (mode === 'wysiwyg') {
        const wysiwygEl = vditorContainer.querySelector('.vditor-wysiwyg .vditor-reset');
        if (wysiwygEl) return wysiwygEl;
      }
      const allResets = vditorContainer.querySelectorAll('.vditor-reset');
      for (const el of allResets) {
        if (el.querySelectorAll('h1, h2, h3, h4, h5, h6').length > 0) {
          return el;
        }
      }
      return vditorContainer;
    }
    return (
      document.querySelector('.vditor-reset') ||
      document.body
    );
  }

  /**
   * Sidebar UI controller:
   * Handles toggle sidebar collapse and tab switching between TOC and Files.
   */
  function initSidebarControls() {
    const sidebar = document.getElementById('app-sidebar');
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const tabToc = document.getElementById('sidebar-tab-toc');
    const tabFiles = document.getElementById('sidebar-tab-files');
    const panelToc = document.getElementById('panel-toc');
    const panelFiles = document.getElementById('panel-files');

    // Toggle sidebar visibility
    if (btnToggleSidebar && sidebar) {
      btnToggleSidebar.addEventListener('click', () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        if (window.AppStore && typeof window.AppStore.setState === 'function') {
          window.AppStore.setState({ sidebarVisible: !isCollapsed });
        }
      });
    }

    // Switch to TOC panel
    function activateTocTab() {
      if (sidebar) sidebar.classList.remove('collapsed');
      if (tabToc) tabToc.classList.add('active');
      if (tabFiles) tabFiles.classList.remove('active');
      if (panelToc) {
        panelToc.classList.remove('hidden');
        panelToc.classList.add('active');
        panelToc.style.display = '';
      }
      if (panelFiles) {
        panelFiles.classList.add('hidden');
        panelFiles.classList.remove('active');
        panelFiles.style.display = 'none';
      }
      if (window.AppStore && typeof window.AppStore.setState === 'function') {
        window.AppStore.setState({ sidebarTab: 'toc', sidebarVisible: true });
      }
    }

    // Switch to Files panel
    function activateFilesTab() {
      if (sidebar) sidebar.classList.remove('collapsed');
      if (tabFiles) tabFiles.classList.add('active');
      if (tabToc) tabToc.classList.remove('active');
      if (panelFiles) {
        panelFiles.classList.remove('hidden');
        panelFiles.classList.add('active');
        panelFiles.style.display = '';
      }
      if (panelToc) {
        panelToc.classList.add('hidden');
        panelToc.classList.remove('active');
        panelToc.style.display = 'none';
      }
      if (window.AppStore && typeof window.AppStore.setState === 'function') {
        window.AppStore.setState({ sidebarTab: 'files', sidebarVisible: true });
      }
    }

    if (tabToc) tabToc.addEventListener('click', activateTocTab);
    if (tabFiles) tabFiles.addEventListener('click', activateFilesTab);
  }

  /**
   * Scan headings in the rendered container and build tree.
   */
  function refreshToc(containerEl) {
    const container = containerEl || getRenderContainer();
    const tocContainer = document.getElementById('toc-tree-container');
    if (!tocContainer) return;

    if (!container) {
      tocContainer.innerHTML = '<div class="toc-empty">未找到渲染文档</div>';
      return;
    }

    // Query all heading tags
    const headingEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (!headingEls || headingEls.length === 0) {
      currentHeadings = [];
      tocContainer.innerHTML = '<div class="toc-empty">本文档暂无标题大纲</div>';
      return;
    }

    const items = [];
    headingEls.forEach((el, index) => {
      // Ensure element has unique id
      if (!el.id || el.id.trim() === '') {
        const raw = el.textContent.trim().toLowerCase();
        const slug = raw.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'heading';
        el.id = `heading-${index}-${slug}`;
      }

      const level = parseInt(el.tagName.substring(1), 10) || 1;
      items.push({
        id: el.id,
        level,
        text: el.textContent.trim(),
        element: el,
        index,
      });
    });

    currentHeadings = items;

    // Build hierarchical tree using stack
    const rootNodes = [];
    const stack = []; // { node, level }

    items.forEach((item) => {
      const node = {
        ...item,
        children: [],
      };

      while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
        stack.pop();
      }

      if (stack.length === 0) {
        rootNodes.push(node);
      } else {
        stack[stack.length - 1].node.children.push(node);
      }

      stack.push({ node, level: node.level });
    });

    // Render tree DOM
    renderTocTree(rootNodes, tocContainer);

    // Apply existing search filter if present
    const searchInput = document.getElementById('toc-search-input');
    if (searchInput && searchInput.value.trim()) {
      filterToc(searchInput.value.trim());
    }
  }

  /**
   * Render hierarchical TOC node list recursively.
   */
  function renderTocTree(nodes, containerEl) {
    containerEl.innerHTML = '';
    const fragment = document.createDocumentFragment();

    function createNodeEl(node) {
      const itemEl = document.createElement('div');
      itemEl.className = `toc-item toc-level-${node.level}`;
      itemEl.setAttribute('data-id', node.id);
      itemEl.setAttribute('data-level', node.level);

      const rowEl = document.createElement('div');
      rowEl.className = 'toc-item-row';

      // Toggle arrow if has children
      if (node.children && node.children.length > 0) {
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'toc-toggle-icon expanded';
        toggleBtn.innerHTML = '▾';
        toggleBtn.title = '展开/折叠';
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const childrenContainer = itemEl.querySelector(':scope > .toc-children');
          if (childrenContainer) {
            const isCollapsed = childrenContainer.classList.toggle('collapsed');
            toggleBtn.innerHTML = isCollapsed ? '▸' : '▾';
            toggleBtn.classList.toggle('expanded', !isCollapsed);
          }
        });
        rowEl.appendChild(toggleBtn);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'toc-spacer';
        rowEl.appendChild(spacer);
      }

      // Title element
      const titleEl = document.createElement('span');
      titleEl.className = 'toc-title';
      titleEl.textContent = node.text;
      titleEl.title = node.text;
      rowEl.appendChild(titleEl);

      // Click to scroll heading into view
      rowEl.addEventListener('click', () => {
        scrollToHeading(node.id);
      });

      itemEl.appendChild(rowEl);

      // Children container
      if (node.children && node.children.length > 0) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'toc-children';
        node.children.forEach((child) => {
          childrenEl.appendChild(createNodeEl(child));
        });
        itemEl.appendChild(childrenEl);
      }

      return itemEl;
    }

    nodes.forEach((node) => {
      fragment.appendChild(createNodeEl(node));
    });

    containerEl.appendChild(fragment);
  }

  /**
   * Smoothly scroll target heading into view and mark active.
   */
  function scrollToHeading(headingId) {
    const headingEl = document.getElementById(headingId);
    if (!headingEl) return;

    isScrollingFromClick = true;
    if (scrollTimeout) clearTimeout(scrollTimeout);

    headingEl.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });

    setActiveTocItem(headingId);

    // Release click lock after smooth scroll finishes
    scrollTimeout = setTimeout(() => {
      isScrollingFromClick = false;
    }, 600);
  }

  /**
   * Highlight the active item in TOC sidebar and ensure it's in view.
   */
  function setActiveTocItem(headingId) {
    const tocContainer = document.getElementById('toc-tree-container');
    if (!tocContainer) return;

    const prevActive = tocContainer.querySelectorAll('.toc-item.active, .toc-item-row.active');
    prevActive.forEach((el) => el.classList.remove('active'));

    if (!headingId) return;

    const targetItem = tocContainer.querySelector(`.toc-item[data-id="${headingId}"]`);
    if (targetItem) {
      targetItem.classList.add('active');
      const row = targetItem.querySelector(':scope > .toc-item-row');
      if (row) row.classList.add('active');
      targetItem.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }

  /**
   * Filter TOC items based on search input.
   */
  function filterToc(query) {
    const tocContainer = document.getElementById('toc-tree-container');
    if (!tocContainer) return;

    const q = (query || '').toLowerCase().trim();
    const items = tocContainer.querySelectorAll('.toc-item');

    if (!q) {
      items.forEach((it) => {
        it.style.display = '';
        const children = it.querySelector(':scope > .toc-children');
        if (children) children.classList.remove('collapsed');
      });
      return;
    }

    // Traverse and mark matches
    items.forEach((it) => {
      const titleEl = it.querySelector(':scope > .toc-item-row > .toc-title');
      const text = titleEl ? titleEl.textContent.toLowerCase() : '';
      const isMatch = text.includes(q);

      if (isMatch) {
        it.style.display = '';
        // Expand and show all parent items
        let parent = it.parentElement;
        while (parent && parent !== tocContainer) {
          if (parent.classList.contains('toc-children')) {
            parent.classList.remove('collapsed');
            parent.style.display = '';
          }
          if (parent.classList.contains('toc-item')) {
            parent.style.display = '';
          }
          parent = parent.parentElement;
        }
      } else {
        // If none of its children match, hide it
        const hasMatchingChild = Array.from(it.querySelectorAll('.toc-title')).some((t) =>
          t.textContent.toLowerCase().includes(q)
        );
        it.style.display = hasMatchingChild ? '' : 'none';
      }
    });
  }

  /**
   * ScrollSpy: Detect currently visible heading at top of editor viewport
   * and update active TOC item.
   */
  function handleScrollSpy(scrollPayload) {
    if (isScrollingFromClick) return;
    if (!currentHeadings || currentHeadings.length === 0) return;

    const now = Date.now();
    if (now - lastScrollTime < SCROLL_THROTTLE_MS) return;
    lastScrollTime = now;

    // Use container element if provided, or default editor preview/content
    const container = (scrollPayload && scrollPayload.containerEl) || getRenderContainer();
    const containerRect = container ? container.getBoundingClientRect() : { top: 0 };
    const offsetThreshold = containerRect.top + 80;

    let activeHeadingId = null;

    for (let i = 0; i < currentHeadings.length; i++) {
      const h = currentHeadings[i];
      const el = h.element || document.getElementById(h.id);
      if (!el) continue;

      const rect = el.getBoundingClientRect();
      if (rect.top <= offsetThreshold) {
        activeHeadingId = h.id;
      } else {
        break;
      }
    }

    if (!activeHeadingId && currentHeadings.length > 0) {
      activeHeadingId = currentHeadings[0].id;
    }

    if (activeHeadingId) {
      setActiveTocItem(activeHeadingId);
    }
  }

  const TocOutline = {
    init() {
      // 1. Setup sidebar toggles and tab navigation
      initSidebarControls();

      // 2. Setup TOC search filter
      const searchInput = document.getElementById('toc-search-input');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          filterToc(e.target.value);
        });
      }

      // 3. Register EventBus listeners
      if (window.AppBus) {
        // Document rendered or tab switched: rebuild outline
        window.AppBus.on('editor:rendered', (payload) => {
          const container = payload && payload.containerEl;
          refreshToc(container);
        });

        window.AppBus.on('tab:switched', () => {
          setTimeout(() => {
            refreshToc();
          }, 100);
        });

        window.AppBus.on('tab:activated', () => {
          setTimeout(() => {
            refreshToc();
          }, 100);
        });

        // ScrollSpy listener
        window.AppBus.on('editor:scroll', (payload) => {
          handleScrollSpy(payload);
        });
      }

      // Fallback: listen to window/container scroll events if editor emits native scroll
      const container = getRenderContainer();
      if (container) {
        container.addEventListener('scroll', () => {
          handleScrollSpy({ containerEl: container });
        }, { passive: true });
      }
    },

    refresh() {
      refreshToc();
    },

    setActive(headingId) {
      setActiveTocItem(headingId);
    },
  };

  window.TocOutline = TocOutline;
})();
