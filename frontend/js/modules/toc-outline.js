/**
 * TocOutline Module
 * Responsible for sidebar panel switching (TOC / File Tree),
 * parsing headings from rendered Markdown content, building a hierarchical
 * collapsible Table of Contents tree, real-time searching, and navigation.
 *
 * 性能要点（P2-7）：
 * 1. editor:rendered 走 260ms 防抖合并，并对标题结构签名去重：
 *    结构未变化时完全跳过 DOM 重建（只刷新元素引用与 offset 缓存）。
 * 2. tab:activated / tab:switched 共用同一个合并调度器（互相取消），
 *    切换标签后约 200ms 只刷新一次。
 * 3. ScrollSpy 在重建时缓存各标题相对滚动容器的 offsetTop，
 *    滚动时只做一次 rAF 合并计算，不再逐个 getBoundingClientRect。
 * 4. setActiveTocItem 不再使用 behavior:'smooth'，仅在目标不可见时
 *    用 behavior:'auto' 做一次瞬时定位，避免平滑滚动风暴。
 *
 * Fully decoupled: communicates strictly through window.AppBus and window.AppStore.
 */
(function () {
  'use strict';

  // ---------------- 调度参数 ----------------
  const TOC_REBUILD_DEBOUNCE_MS = 260; // editor:rendered 合并窗口（250-300ms）
  const TOC_TAB_REFRESH_DELAY_MS = 200; // 标签切换后的刷新延迟
  const SCROLL_THROTTLE_MS = 100; // ScrollSpy 节流（80-120ms）
  const SPY_ANCHOR_OFFSET = 80; // 视口顶部判定线
  const TOC_VISIBLE_PADDING = 8; // 侧栏可视区安全边距

  // ---------------- 私有状态 ----------------
  let currentHeadings = []; // { id, level, text, element, index, offsetTop }
  let activeTocId = null;

  let isScrollingFromClick = false;
  let clickLockTimer = null;

  let lastStructureSignature = null; // 标题结构签名（null 表示尚未构建）
  let lastStructureContainer = null; // 签名对应的渲染容器

  let offsetContainer = null; // offsetTop 缓存所相对的滚动容器
  let offsetRenderContainer = null; // 缓存所属的渲染容器
  let offsetScrollHeight = -1; // 缓存时的 scrollHeight，用于探测布局漂移

  let boundScroller = null;
  let scrollerResizeObserver = null;

  let rebuildTimer = null; // 唯一的合并重建定时器
  let pendingRebuildContainer = null;

  let offsetRefreshPending = false;
  let pendingOffsetContainer = null;
  let spyPending = false;
  let lastSpyAt = 0;
  let pendingSpyContainer = null;
  let throttleTimer = null;

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
   * 解析当前模式下真正负责滚动的容器（ScrollSpy 的坐标系基准）。
   */
  function getScrollContainer(renderContainer) {
    const store = window.AppStore ? window.AppStore.getState() : {};
    const mode = store.editorMode || 'ir';

    if (mode === 'reader') {
      return document.getElementById('reader-scroll-wrap') || document.scrollingElement;
    }

    const vditorContainer = document.getElementById('vditor-container');
    if (vditorContainer) {
      const preferred = ['.vditor-ir', '.vditor-wysiwyg', '.vditor-preview', '.vditor-sv'];
      for (let i = 0; i < preferred.length; i++) {
        const el = vditorContainer.querySelector(preferred[i]);
        if (el && el.clientHeight > 0) {
          const cs = window.getComputedStyle(el);
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') return el;
        }
      }
    }

    // 兜底：从渲染容器向上找可滚动祖先
    let el = renderContainer || getRenderContainer();
    let hops = 0;
    while (el && hops < 8 && el !== document.body) {
      const cs = window.getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.clientHeight > 0) {
        return el;
      }
      el = el.parentElement;
      hops++;
    }

    return document.scrollingElement || document.documentElement;
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
        // 侧栏折叠会改变可视宽度，TOC 行位置随之变化
        scheduleOffsetRefresh();
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
      scheduleOffsetRefresh();
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
   * 扫描渲染容器中的标题，补齐 id，并生成结构签名。
   * 不触碰 TOC DOM，可在“结构未变化”时安全调用。
   */
  function collectHeadings(container) {
    const headingEls = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const items = [];
    const signatureParts = [];

    headingEls.forEach((el, index) => {
      // Ensure element has unique id
      if (!el.id || el.id.trim() === '') {
        const raw = el.textContent.trim().toLowerCase();
        const slug = raw.replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'heading';
        el.id = 'heading-' + index + '-' + slug;
      }

      const level = parseInt(el.tagName.substring(1), 10) || 1;
      const text = el.textContent.trim();

      items.push({
        id: el.id,
        level,
        text,
        element: el,
        index,
        offsetTop: null,
      });

      // 签名 = 序号 + 级别 + id + 文本；任一变化都意味着大纲需要重建
      signatureParts.push(index + '|' + level + '|' + el.id + '|' + text);
    });

    return {
      items,
      signature: signatureParts.join('\u0001'),
    };
  }

  /**
   * 重建大纲（带结构去重）。
   * @param {HTMLElement|null} containerEl 渲染容器，缺省时按当前模式解析
   * @param {boolean} force 强制重建 DOM（忽略签名去重）
   */
  function refreshToc(containerEl, force) {
    // 过期的 rendered 事件可能带着已被销毁的容器，回退到当前活动容器
    let container = containerEl;
    if (!container || container.isConnected === false) {
      container = getRenderContainer();
    }
    const tocContainer = document.getElementById('toc-tree-container');
    if (!tocContainer) return;

    if (!container) {
      currentHeadings = [];
      activeTocId = null;
      lastStructureSignature = null;
      lastStructureContainer = null;
      offsetContainer = null;
      tocContainer.innerHTML = '<div class="toc-empty">未找到渲染文档</div>';
      return;
    }

    const collected = collectHeadings(container);
    const items = collected.items;
    const signature = collected.signature;

    // 结构签名未变化：跳过整棵树的 DOM 重建，仅刷新引用与 offset 缓存
    const treeHasItems = !!tocContainer.querySelector('.toc-item');
    const sameStructure =
      !force &&
      signature === lastStructureSignature &&
      container === lastStructureContainer &&
      (treeHasItems || items.length === 0);

    if (sameStructure) {
      currentHeadings = items;
      scheduleOffsetRefresh(container);
      return;
    }

    lastStructureSignature = signature;
    lastStructureContainer = container;

    if (items.length === 0) {
      currentHeadings = [];
      activeTocId = null;
      offsetContainer = null;
      tocContainer.innerHTML = '<div class="toc-empty">本文档暂无标题大纲</div>';
      return;
    }

    currentHeadings = items;
    activeTocId = null;

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

    // 重建后立刻缓存 offsetTop（一次性批量读取，后续滚动不再读布局）
    rebuildOffsetCache(container);
    bindScrollerListener();
  }

  /**
   * Render hierarchical TOC node list recursively.
   */
  function renderTocTree(nodes, containerEl) {
    containerEl.innerHTML = '';
    const fragment = document.createDocumentFragment();

    function createNodeEl(node) {
      const itemEl = document.createElement('div');
      itemEl.className = 'toc-item toc-level-' + node.level;
      itemEl.setAttribute('data-id', node.id);
      itemEl.setAttribute('data-level', node.level);

      const rowEl = document.createElement('div');
      rowEl.className = 'toc-item-row';

      // Toggle arrow if has children
      if (node.children && node.children.length > 0) {
        const toggleBtn = document.createElement('span');
        toggleBtn.className = 'toc-toggle-icon expanded';
        toggleBtn.innerHTML = '\u25be';
        toggleBtn.title = '展开/折叠';
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const childrenContainer = itemEl.querySelector(':scope > .toc-children');
          if (childrenContainer) {
            const isCollapsed = childrenContainer.classList.toggle('collapsed');
            toggleBtn.innerHTML = isCollapsed ? '\u25b8' : '\u25be';
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
   * 重建 offsetTop 缓存：一次批量读取布局，滚动阶段零布局读取。
   */
  function rebuildOffsetCache(renderContainer) {
    const container = renderContainer || offsetRenderContainer || getRenderContainer();
    if (!currentHeadings || currentHeadings.length === 0) return;

    const scroller = getScrollContainer(container);
    if (!scroller) return;

    // 内容坐标基准：offsetTop = rect.top - scrollerRect.top + scrollTop
    const scrollerRect = scroller.getBoundingClientRect();
    const base = scroller.scrollTop - scrollerRect.top;

    for (let i = 0; i < currentHeadings.length; i++) {
      const h = currentHeadings[i];
      let el = h.element;
      if (!el || !el.isConnected) {
        el = h.id ? document.getElementById(h.id) : null;
        h.element = el;
      }
      if (!el || !el.isConnected) {
        h.offsetTop = null;
        continue;
      }
      h.offsetTop = el.getBoundingClientRect().top + base;
    }

    offsetContainer = scroller;
    offsetRenderContainer = container;
    offsetScrollHeight = scroller.scrollHeight;

    bindScrollerListener();
  }

  /**
   * rAF 合并的 offset 缓存刷新（resize / 模式切换 / 侧栏折叠）。
   */
  function scheduleOffsetRefresh(renderContainer) {
    if (renderContainer) pendingOffsetContainer = renderContainer;
    if (offsetRefreshPending) return;
    offsetRefreshPending = true;

    const run = () => {
      if (!offsetRefreshPending) return;
      offsetRefreshPending = false;
      const container = pendingOffsetContainer || offsetRenderContainer;
      pendingOffsetContainer = null;
      rebuildOffsetCache(container);
    };

    // rAF 合并，并附带超时兜底（窗口失焦时 rAF 可能被节流）
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }

  /**
   * 给当前滚动容器补一个原生 scroll 兜底监听（含尺寸变化）。
   */
  function bindScrollerListener() {
    const scroller = offsetContainer;
    if (!scroller || scroller === boundScroller) return;

    if (boundScroller) {
      boundScroller.removeEventListener('scroll', onNativeScroll);
    }
    boundScroller = scroller;
    boundScroller.addEventListener('scroll', onNativeScroll, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      if (scrollerResizeObserver) scrollerResizeObserver.disconnect();
      scrollerResizeObserver = new ResizeObserver(() => {
        scheduleOffsetRefresh();
      });
      scrollerResizeObserver.observe(scroller);
    }
  }

  function onNativeScroll(e) {
    handleScrollSpy({ containerEl: e.target });
  }

  /**
   * 移除平滑滚动：仅当活动项不可见时用 behavior:'auto' 做一次瞬时定位。
   */
  function ensureTocItemVisible(tocContainer, itemEl) {
    if (!tocContainer || !itemEl) return;
    const itemRect = itemEl.getBoundingClientRect();
    const boxRect = tocContainer.getBoundingClientRect();
    if (boxRect.height <= 0) return;

    const fullyVisible =
      itemRect.top >= boxRect.top + TOC_VISIBLE_PADDING &&
      itemRect.bottom <= boxRect.bottom - TOC_VISIBLE_PADDING;

    // 已经在可视区：绝不滚动（避免平滑动画风暴）
    if (fullyVisible) return;

    const targetTop = tocContainer.scrollTop + (itemRect.top - boxRect.top) - TOC_VISIBLE_PADDING;
    if (typeof tocContainer.scrollTo === 'function') {
      tocContainer.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
    } else {
      tocContainer.scrollTop = Math.max(0, targetTop);
    }
  }

  /**
   * 点击大纲跳转标题：单次用户操作，允许一次性平滑滚动。
   */
  function scrollToHeading(headingId) {
    const headingEl = document.getElementById(headingId);
    if (!headingEl) return;

    isScrollingFromClick = true;
    if (clickLockTimer) clearTimeout(clickLockTimer);

    const scroller = offsetContainer || getScrollContainer(offsetRenderContainer);
    const heading = currentHeadings.find((h) => h.id === headingId);

    let top = heading && typeof heading.offsetTop === 'number' ? heading.offsetTop - 12 : null;
    if (top === null) {
      const base = scroller ? scroller.scrollTop - scroller.getBoundingClientRect().top : 0;
      top = headingEl.getBoundingClientRect().top + base - 12;
    }

    if (scroller) {
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else {
        scroller.scrollTop = Math.max(0, top);
      }
    } else {
      headingEl.scrollIntoView({ block: 'start' });
    }

    setActiveTocItem(headingId, { force: true });

    // Release click lock after smooth scroll finishes
    clickLockTimer = setTimeout(() => {
      isScrollingFromClick = false;
      clickLockTimer = null;
    }, 600);
  }

  /**
   * Highlight the active item in TOC sidebar.
   * 同一活动项重复命中时不产生任何 DOM 操作。
   */
  function setActiveTocItem(headingId, options) {
    const tocContainer = document.getElementById('toc-tree-container');
    if (!tocContainer) return;

    const nextId = headingId || null;
    const force = !!(options && options.force);

    if (!force && nextId === activeTocId) return;
    activeTocId = nextId;

    const prevActive = tocContainer.querySelectorAll('.toc-item.active, .toc-item-row.active');
    prevActive.forEach((el) => el.classList.remove('active'));

    if (!nextId) return;

    let targetItem = null;
    try {
      targetItem = tocContainer.querySelector('.toc-item[data-id="' + String(nextId).replace(/"/g, '') + '"]');
    } catch (e) {
      targetItem = null;
    }
    if (!targetItem) return;

    targetItem.classList.add('active');
    const row = targetItem.querySelector(':scope > .toc-item-row');
    if (row) row.classList.add('active');

    // 只有不可见时才瞬时定位（behavior: 'auto'）
    ensureTocItemVisible(tocContainer, targetItem);
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
   * ScrollSpy: 80-120ms 节流 + 单次 rAF 合并，只读缓存 offsetTop。
   */
  function handleScrollSpy(scrollPayload) {
    if (isScrollingFromClick) return;
    if (!currentHeadings || currentHeadings.length === 0) return;

    if (scrollPayload && scrollPayload.containerEl) {
      pendingSpyContainer = scrollPayload.containerEl;
    }

    if (spyPending) return;

    const now = Date.now();
    const wait = SCROLL_THROTTLE_MS - (now - lastSpyAt);
    if (wait > 0) {
      // 节流窗口内：只保留一个补算定时器，窗口结束时合并计算一次
      if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          handleScrollSpy(null);
        }, wait);
      }
      return;
    }

    spyPending = true;
    const run = () => {
      if (!spyPending) return;
      spyPending = false;
      lastSpyAt = Date.now();
      const spyContainer = pendingSpyContainer;
      pendingSpyContainer = null;
      computeActiveHeading(spyContainer);
    };

    // 一帧只算一次；超时兜底保证失焦窗口下仍能结算
    requestAnimationFrame(run);
    setTimeout(run, 150);
  }

  function computeActiveHeading(spyContainer) {
    if (!currentHeadings || currentHeadings.length === 0) return;

    let scroller = spyContainer && typeof spyContainer.scrollTop === 'number'
      ? spyContainer
      : offsetContainer;

    if (!scroller) {
      scroller = getScrollContainer(offsetRenderContainer);
    }
    if (!scroller) return;

    // 容器变了（模式切换）或布局高度漂移（图片加载）时重建缓存
    if (
      scroller !== offsetContainer ||
      (offsetScrollHeight >= 0 && Math.abs(scroller.scrollHeight - offsetScrollHeight) > 2)
    ) {
      rebuildOffsetCache(offsetRenderContainer);
    }

    const scrollTop = scroller.scrollTop;
    const threshold = scrollTop + SPY_ANCHOR_OFFSET;

    let activeHeadingId = null;
    for (let i = 0; i < currentHeadings.length; i++) {
      const h = currentHeadings[i];
      if (typeof h.offsetTop !== 'number') continue;
      if (h.offsetTop <= threshold) {
        activeHeadingId = h.id;
      } else {
        break;
      }
    }

    if (!activeHeadingId) {
      activeHeadingId = currentHeadings[0].id;
    }

    if (activeHeadingId) {
      setActiveTocItem(activeHeadingId);
    }
  }

  /**
   * 唯一的大纲重建调度器：新的调度会取消上一个定时器。
   */
  function scheduleTocRebuild(containerEl, delay) {
    pendingRebuildContainer = containerEl || null;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      const container = pendingRebuildContainer;
      pendingRebuildContainer = null;
      refreshToc(container);
    }, typeof delay === 'number' ? delay : TOC_REBUILD_DEBOUNCE_MS);
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
        // 文档渲染：防抖合并 + 结构签名去重
        window.AppBus.on('editor:rendered', (payload) => {
          scheduleTocRebuild(payload && payload.containerEl, TOC_REBUILD_DEBOUNCE_MS);
        });

        // 切换标签：两者共用同一个合并调度器（后到者取消前者）
        window.AppBus.on('tab:switched', () => {
          scheduleTocRebuild(null, TOC_TAB_REFRESH_DELAY_MS);
        });

        window.AppBus.on('tab:activated', () => {
          scheduleTocRebuild(null, TOC_TAB_REFRESH_DELAY_MS);
        });

        // 模式切换：滚动容器会变化，offset 缓存必须失效
        window.AppBus.on('editor:mode-changed', () => {
          offsetContainer = null;
          offsetRenderContainer = null;
          offsetScrollHeight = -1;
          scheduleOffsetRefresh();
        });

        // ScrollSpy listener
        window.AppBus.on('editor:scroll', (payload) => {
          handleScrollSpy(payload);
        });
      }

      // Fallback: 原生 scroll / resize
      const container = getRenderContainer();
      if (container) {
        container.addEventListener('scroll', (e) => {
          handleScrollSpy({ containerEl: e.currentTarget });
        }, { passive: true });
      }
      window.addEventListener('resize', () => {
        scheduleOffsetRefresh();
      }, { passive: true });
    },

    refresh() {
      refreshToc(null, true);
    },

    setActive(headingId) {
      setActiveTocItem(headingId);
    },
  };

  window.TocOutline = TocOutline;
})();
