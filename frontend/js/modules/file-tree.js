/**
 * FileTree Module
 * Responsible for displaying and interacting with the local workspace folder tree,
 * searching/filtering files, expanding/collapsing directories, file sorting,
 * hidden file toggles, new file/folder creation, rename/delete actions,
 * and opening files via AppBus.
 *
 * Fully decoupled: communicates strictly through window.AppBus, window.AppStore,
 * and window.BridgeClient.
 */
(function () {
  'use strict';

  // State
  let currentWorkspace = null;
  let rawTree = [];
  let expandedDirs = new Set();
  let searchQuery = '';
  let sortBy = 'name'; // 'name' | 'mtime' | 'size'
  let sortAsc = true;
  let showHidden = false;
  let activeFilePath = null;

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
   * Format file size for tooltip
   */
  function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * Format mtime for tooltip
   */
  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString();
  }

  /**
   * Load directory from bridge and re-render tree.
   */
  async function loadWorkspaceDir(dirPath) {
    if (!dirPath || !window.BridgeClient) return;

    currentWorkspace = dirPath;
    if (window.AppStore && typeof window.AppStore.setState === 'function') {
      window.AppStore.setState({ workspaceDir: dirPath });
    }

    const container = document.getElementById('file-tree-container');
    if (container && (!rawTree || rawTree.length === 0)) {
      container.innerHTML = '<div class="file-tree-loading">正在加载工作区目录...</div>';
    }

    try {
      const res = await window.BridgeClient.listDir(dirPath, showHidden, sortBy, sortAsc);
      const isOk = res && (res.ok || res.success);

      if (isOk) {
        // Backend returns { root, tree } or mock returns { root, items }
        let treeData = res.tree || (res.data && res.data.tree) || [];
        if (!treeData.length && (res.items || (res.data && res.data.items))) {
          // Convert flat items to tree if in mock mode
          treeData = convertFlatToTree(res.items || res.data.items, dirPath);
        }

        rawTree = treeData;
        renderFileTree();
      } else {
        const errorMsg = (res && res.error) || '读取工作区目录失败';
        if (container) {
          container.innerHTML = `<div class="file-tree-error">${escapeHtml(errorMsg)}</div>`;
        }
      }
    } catch (err) {
      console.error('[FileTree] Error loading directory:', err);
      if (container) {
        container.innerHTML = `<div class="file-tree-error">加载目录发生异常: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  /**
   * Helper for mock mode flat-list conversion to tree
   */
  function convertFlatToTree(items, rootDir) {
    if (!items || !items.length) return [];
    return items.map((it) => ({
      name: it.name,
      path: it.path,
      is_dir: !!it.isDir || !!it.is_dir,
      size: it.size || 0,
      mtime: it.mtime || Date.now() / 1000,
      children: it.children || null,
    }));
  }

  /**
   * Render file tree according to current search, sort, and expansion state.
   */
  function renderFileTree() {
    const container = document.getElementById('file-tree-container');
    if (!container) return;

    if (!currentWorkspace) {
      container.innerHTML = `
        <div class="file-tree-empty">
          <p>暂未打开工作区目录</p>
          <button id="btn-open-folder-empty" class="btn-primary-subtle">打开文件夹</button>
        </div>
      `;
      const emptyBtn = document.getElementById('btn-open-folder-empty');
      if (emptyBtn) {
        emptyBtn.addEventListener('click', handleOpenFolder);
      }
      return;
    }

    if (!rawTree || rawTree.length === 0) {
      container.innerHTML = `
        <div class="file-tree-empty">
          <p>文件夹为空</p>
          <span class="file-tree-subtext">${escapeHtml(currentWorkspace)}</span>
        </div>
      `;
      return;
    }

    container.innerHTML = '';
    const rootFragment = document.createDocumentFragment();

    // Render tree nodes recursively
    function buildNodeElement(node, depth) {
      const isDir = !!(node.is_dir !== undefined ? node.is_dir : node.isDir);
      const isExpanded = expandedDirs.has(node.path);

      // Check search match
      const query = (searchQuery || '').trim().toLowerCase();
      let isSelfMatch = true;
      let hasMatchingDescendant = false;

      if (query) {
        isSelfMatch = node.name.toLowerCase().includes(query);
        if (isDir && node.children && node.children.length > 0) {
          hasMatchingDescendant = checkHasMatchingChild(node.children, query);
        }
      }

      if (query && !isSelfMatch && !hasMatchingDescendant) {
        return null;
      }

      // If search matched a descendant, auto-expand folder
      const effectivelyExpanded = query ? true : isExpanded;

      const nodeEl = document.createElement('div');
      nodeEl.className = `file-tree-node ${isDir ? 'is-folder' : 'is-file'}`;
      nodeEl.setAttribute('data-path', node.path);

      const rowEl = document.createElement('div');
      rowEl.className = 'tree-node file-tree-row';
      if (!isDir && node.path === activeFilePath) {
        rowEl.classList.add('active');
      }
      rowEl.style.paddingLeft = `${12 + depth * 14}px`;

      // Icon & Arrow
      if (isDir) {
        const arrow = document.createElement('span');
        arrow.className = `folder-arrow ${effectivelyExpanded ? 'expanded' : ''}`;
        arrow.textContent = effectivelyExpanded ? '▾' : '▸';
        rowEl.appendChild(arrow);

        const folderIcon = document.createElement('span');
        folderIcon.className = 'node-icon folder-icon';
        folderIcon.textContent = effectivelyExpanded ? '📂' : '📁';
        rowEl.appendChild(folderIcon);
      } else {
        const fileIcon = document.createElement('span');
        fileIcon.className = 'node-icon file-icon';
        const isMd = /\.(md|markdown|mdown|txt)$/i.test(node.name);
        fileIcon.textContent = isMd ? '📝' : '📄';
        rowEl.appendChild(fileIcon);
      }

      // Name label
      const nameEl = document.createElement('span');
      nameEl.className = 'node-label node-name';
      nameEl.textContent = node.name;
      const tooltip = `${node.name}\n路径: ${node.path}${node.size ? '\n大小: ' + formatSize(node.size) : ''}${node.mtime ? '\n修改: ' + formatDate(node.mtime) : ''}`;
      nameEl.title = tooltip;
      rowEl.appendChild(nameEl);

      // Hover actions (Rename / Delete)
      const actionsEl = document.createElement('span');
      actionsEl.className = 'node-actions';

      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn-node-action';
      renameBtn.innerHTML = '✎';
      renameBtn.title = '重命名';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleRenameItem(node);
      });
      actionsEl.appendChild(renameBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-node-action btn-node-delete';
      deleteBtn.innerHTML = '🗑';
      deleteBtn.title = '删除';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDeleteItem(node);
      });
      actionsEl.appendChild(deleteBtn);

      rowEl.appendChild(actionsEl);

      // Row click handler
      rowEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isDir) {
          if (expandedDirs.has(node.path)) {
            expandedDirs.delete(node.path);
          } else {
            expandedDirs.add(node.path);
          }
          renderFileTree();
        } else {
          // Open file
          if (window.AppBus) {
            window.AppBus.emit('file:open-request', { path: node.path });
          }
          activeFilePath = node.path;
          updateActiveHighlight();
        }
      });

      nodeEl.appendChild(rowEl);

      // Render children for expanded folders
      if (isDir && node.children && node.children.length > 0 && effectivelyExpanded) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'folder-children';

        node.children.forEach((child) => {
          const childNodeEl = buildNodeElement(child, depth + 1);
          if (childNodeEl) {
            childrenEl.appendChild(childNodeEl);
          }
        });

        nodeEl.appendChild(childrenEl);
      }

      return nodeEl;
    }

    rawTree.forEach((rootNode) => {
      const el = buildNodeElement(rootNode, 0);
      if (el) rootFragment.appendChild(el);
    });

    container.appendChild(rootFragment);
  }

  /**
   * Recursive check if any child matches search query
   */
  function checkHasMatchingChild(children, query) {
    if (!children || !children.length) return false;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.name.toLowerCase().includes(query)) return true;
      if (child.is_dir && child.children && checkHasMatchingChild(child.children, query)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update active highlight in DOM without re-rendering entire tree
   */
  function updateActiveHighlight() {
    const container = document.getElementById('file-tree-container');
    if (!container) return;

    const rows = container.querySelectorAll('.file-tree-row, .tree-node');
    rows.forEach((r) => r.classList.remove('active'));

    if (!activeFilePath) return;

    const targetNode = container.querySelector(`.file-tree-node.is-file[data-path="${CSS.escape(activeFilePath)}"] > .file-tree-row`);
    if (targetNode) {
      targetNode.classList.add('active');
    }
  }

  /**
   * Handle Open Folder Dialog
   */
  async function handleOpenFolder() {
    if (!window.BridgeClient) return;

    try {
      const res = await window.BridgeClient.selectFolderDialog();
      const folderPath = res && (res.path || (res.data && res.data.path));
      if (folderPath) {
        if (window.AppBus) {
          window.AppBus.emit('folder:open-request', { path: folderPath });
        } else {
          loadWorkspaceDir(folderPath);
        }
      }
    } catch (err) {
      console.error('[FileTree] selectFolderDialog error:', err);
    }
  }

  /**
   * Handle Create New File in current workspace or selected folder
   */
  async function handleNewFile() {
    if (!currentWorkspace || !window.BridgeClient) {
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', { message: '请先打开一个工作区文件夹', type: 'warning' });
      }
      return;
    }

    const filename = window.prompt('请输入新建 Markdown 文件名 (例如 notes.md):', 'untitled.md');
    if (!filename || !filename.trim()) return;

    try {
      const res = await window.BridgeClient.createItem(currentWorkspace, filename.trim(), false);
      const isOk = res && (res.ok || res.success);
      if (isOk) {
        const newPath = res.path || (res.data && res.data.path);
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: '文件创建成功', type: 'success' });
          if (newPath) {
            window.AppBus.emit('file:open-request', { path: newPath });
          }
        }
        await loadWorkspaceDir(currentWorkspace);
      } else {
        const errorMsg = (res && res.error) || '创建文件失败';
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: errorMsg, type: 'error' });
        }
      }
    } catch (err) {
      console.error('[FileTree] Error creating file:', err);
    }
  }

  /**
   * Handle Create New Folder
   */
  async function handleNewFolder() {
    if (!currentWorkspace || !window.BridgeClient) {
      if (window.AppBus) {
        window.AppBus.emit('notify:toast', { message: '请先打开一个工作区文件夹', type: 'warning' });
      }
      return;
    }

    const folderName = window.prompt('请输入新建文件夹名称:');
    if (!folderName || !folderName.trim()) return;

    try {
      const res = await window.BridgeClient.createItem(currentWorkspace, folderName.trim(), true);
      const isOk = res && (res.ok || res.success);
      if (isOk) {
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: '文件夹创建成功', type: 'success' });
        }
        await loadWorkspaceDir(currentWorkspace);
      } else {
        const errorMsg = (res && res.error) || '创建文件夹失败';
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: errorMsg, type: 'error' });
        }
      }
    } catch (err) {
      console.error('[FileTree] Error creating folder:', err);
    }
  }

  /**
   * Handle Rename File or Folder
   */
  async function handleRenameItem(node) {
    if (!node || !window.BridgeClient) return;

    const newName = window.prompt(`重命名 "${node.name}" 为:`, node.name);
    if (!newName || !newName.trim() || newName.trim() === node.name) return;

    try {
      const res = await window.BridgeClient.renameItem(node.path, newName.trim());
      const isOk = res && (res.ok || res.success);
      if (isOk) {
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: '重命名成功', type: 'success' });
        }
        await loadWorkspaceDir(currentWorkspace);
      } else {
        const errorMsg = (res && res.error) || '重命名失败';
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: errorMsg, type: 'error' });
        }
      }
    } catch (err) {
      console.error('[FileTree] Error renaming item:', err);
    }
  }

  /**
   * Handle Delete File or Folder
   */
  async function handleDeleteItem(node) {
    if (!node || !window.BridgeClient) return;

    const isDir = !!(node.is_dir !== undefined ? node.is_dir : node.isDir);
    const confirmed = window.confirm(`确定要删除${isDir ? '文件夹' : '文件'} "${node.name}" 吗？此操作无法撤销。`);
    if (!confirmed) return;

    try {
      const res = await window.BridgeClient.deleteItem(node.path);
      const isOk = res && (res.ok || res.success);
      if (isOk) {
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: '删除成功', type: 'info' });
        }
        await loadWorkspaceDir(currentWorkspace);
      } else {
        const errorMsg = (res && res.error) || '删除失败';
        if (window.AppBus) {
          window.AppBus.emit('notify:toast', { message: errorMsg, type: 'error' });
        }
      }
    } catch (err) {
      console.error('[FileTree] Error deleting item:', err);
    }
  }

  /**
   * Bind all toolbar buttons and controls
   */
  function bindToolbarControls() {
    // Open folder button
    const btnOpenFolder = document.getElementById('btn-open-folder');
    if (btnOpenFolder) {
      btnOpenFolder.addEventListener('click', handleOpenFolder);
    }

    // Refresh files
    const btnRefresh = document.getElementById('btn-refresh-files');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        if (currentWorkspace) {
          loadWorkspaceDir(currentWorkspace);
        }
      });
    }

    // New file
    const btnNewFile = document.getElementById('btn-new-file');
    if (btnNewFile) {
      btnNewFile.addEventListener('click', handleNewFile);
    }

    // New folder
    const btnNewFolder = document.getElementById('btn-new-folder');
    if (btnNewFolder) {
      btnNewFolder.addEventListener('click', handleNewFolder);
    }

    // Toggle hidden files
    const btnToggleHidden = document.getElementById('btn-toggle-hidden');
    if (btnToggleHidden) {
      btnToggleHidden.addEventListener('click', () => {
        showHidden = !showHidden;
        btnToggleHidden.classList.toggle('active', showHidden);
        btnToggleHidden.title = showHidden ? '隐藏隐藏文件' : '显示隐藏文件';
        if (currentWorkspace) {
          loadWorkspaceDir(currentWorkspace);
        }
      });
    }

    // Sort select
    const sortSelect = document.getElementById('files-sort-select');
    if (sortSelect) {
      sortSelect.value = sortBy;
      sortSelect.addEventListener('change', (e) => {
        sortBy = e.target.value;
        if (currentWorkspace) {
          loadWorkspaceDir(currentWorkspace);
        }
      });
    }

    // Sort order button
    const btnSortOrder = document.getElementById('btn-sort-order');
    if (btnSortOrder) {
      btnSortOrder.addEventListener('click', () => {
        sortAsc = !sortAsc;
        btnSortOrder.innerHTML = sortAsc ? '↑' : '↓';
        btnSortOrder.title = sortAsc ? '升序排列' : '降序排列';
        if (currentWorkspace) {
          loadWorkspaceDir(currentWorkspace);
        }
      });
    }

    // Search filter input
    const searchInput = document.getElementById('files-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        renderFileTree();
      });
    }
  }

  const FileTree = {
    init() {
      // 1. Bind toolbar controls
      bindToolbarControls();

      // 2. Setup AppBus event listeners
      if (window.AppBus) {
        window.AppBus.on('folder:open-request', (payload) => {
          if (payload && payload.path) {
            loadWorkspaceDir(payload.path);
          }
        });

        window.AppBus.on('tab:switched', (payload) => {
          const tab = payload && payload.tab;
          activeFilePath = tab ? tab.path : null;
          updateActiveHighlight();
        });

        window.AppBus.on('tab:activated', (payload) => {
          const tab = payload && payload.tab;
          activeFilePath = tab ? tab.path : null;
          updateActiveHighlight();
        });

        window.AppBus.on('file:saved', () => {
          // Optional subtle refresh or keep tree updated
        });
      }

      // Check if store already has workspaceDir
      if (window.AppStore && typeof window.AppStore.getState === 'function') {
        const storeState = window.AppStore.getState();
        if (storeState.workspaceDir) {
          loadWorkspaceDir(storeState.workspaceDir);
        }
        const activeTab = window.AppStore.getActiveTab();
        if (activeTab) {
          activeFilePath = activeTab.path;
        }
      }
    },

    refresh() {
      if (currentWorkspace) {
        loadWorkspaceDir(currentWorkspace);
      }
    },
  };

  window.FileTree = FileTree;
})();
