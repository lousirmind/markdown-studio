/**
 * Lightbox Module
 * Responsible for displaying high-resolution image preview modal, image zooming
 * (button, mouse wheel, keyboard, double click), panning (mouse drag), thumbnail
 * list, next/prev navigation, keyboard controls, and smooth closing.
 *
 * Zoom model:
 *   - fitScale: the natural fit ratio of the current image (large image < 1, small = 1).
 *     The stage has an explicit size, so CSS max-width/max-height handle the fit.
 *   - scale: user zoom multiplier relative to that fit (1 = fit, 0.2 - 5).
 *   - The reset button always shows the effective size relative to the original
 *     pixels (fitScale * scale), e.g. "42%" for a large image at fit, "125%" after
 *     one zoom-in step on an image that fits 1:1.
 *
 * Fully decoupled: communicates strictly through window.AppBus.
 */
(function () {
  'use strict';

  // Image list state
  let images = [];
  let currentIndex = 0;
  let isOpen = false;

  // Zoom & Pan state
  let scale = 1;
  let fitScale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  const MIN_SCALE = 0.2;
  const MAX_SCALE = 5.0;
  const ZOOM_FACTOR = 1.25;

  /**
   * Content box of .lightbox-stage (its padding is reserved for toolbar/caption).
   */
  function getStageContentBox() {
    const stageEl = document.querySelector('.lightbox-stage');
    if (!stageEl) return { width: 0, height: 0 };

    const cs = window.getComputedStyle(stageEl);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);

    return {
      width: Math.max(0, stageEl.clientWidth - padX),
      height: Math.max(0, stageEl.clientHeight - padY),
    };
  }

  /**
   * Ratio between the CSS "fit" rendering and the image's intrinsic pixels.
   * Small images are never upscaled, so the result is capped at 1.
   */
  function computeFitScale() {
    const imgEl = document.getElementById('lightbox-img');
    if (!imgEl) return 1;

    const naturalW = imgEl.naturalWidth || 0;
    const naturalH = imgEl.naturalHeight || 0;
    if (!naturalW || !naturalH) return 1;

    const box = getStageContentBox();
    if (!box.width || !box.height) return 1;

    return Math.min(1, box.width / naturalW, box.height / naturalH);
  }

  /**
   * Reset button doubles as the live zoom percentage readout.
   */
  function updateZoomLabel() {
    const btnReset = document.getElementById('lightbox-reset');
    if (!btnReset) return;

    const percent = Math.round(fitScale * scale * 100);
    btnReset.textContent = percent + '%';
  }

  /**
   * Apply pan/zoom transform and refresh the percentage readout.
   */
  function applyTransform() {
    const imgEl = document.getElementById('lightbox-img');
    if (!imgEl) return;

    imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    imgEl.style.cursor = isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'default';
    updateZoomLabel();
  }

  /**
   * Single entry point for every zoom gesture.
   */
  function setScale(nextScale) {
    const rounded = Math.round(nextScale * 1000) / 1000;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rounded));
    scale = clamped;

    // 平移只在放大后有意义；回到 fit（或更小）时归位，避免图片跑出视野
    if (scale <= 1) {
      translateX = 0;
      translateY = 0;
    }

    applyTransform();
  }

  /**
   * Reset zoom and pan to the fit state for the current image.
   */
  function resetTransform() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    fitScale = computeFitScale();
    applyTransform();
  }

  /**
   * Load and display image at currentIndex
   */
  function showImage(index) {
    if (!images || images.length === 0) return;

    if (index < 0) {
      currentIndex = images.length - 1;
    } else if (index >= images.length) {
      currentIndex = 0;
    } else {
      currentIndex = index;
    }

    const currentImg = images[currentIndex];
    const imgEl = document.getElementById('lightbox-img');
    const captionEl = document.getElementById('lightbox-caption');

    // 切图后回到 fit：缩放与平移都归零
    scale = 1;
    translateX = 0;
    translateY = 0;

    if (imgEl && currentImg) {
      imgEl.src = currentImg.src;
      imgEl.alt = currentImg.alt || '';
      // 缓存图片可能同步可用；未加载完时由 load 事件重算
      fitScale =
        imgEl.complete && imgEl.naturalWidth > 0 ? computeFitScale() : 1;
    }

    if (captionEl) {
      const captionText = currentImg ? (currentImg.alt || currentImg.title || '') : '';
      const counter = images.length > 1 ? ` (${currentIndex + 1} / ${images.length})` : '';
      captionEl.textContent = `${captionText}${counter}`;
    }

    applyTransform();
    updateThumbnailsActiveState();
  }

  /**
   * Render thumbnail strip in #lightbox-thumbs
   */
  function renderThumbnails() {
    const thumbsContainer = document.getElementById('lightbox-thumbs');
    if (!thumbsContainer) return;

    if (!images || images.length <= 1) {
      thumbsContainer.innerHTML = '';
      thumbsContainer.style.display = 'none';
      thumbsContainer.classList.add('hidden');
      return;
    }

    // 多图时才显示底部缩略图条（打开时移除 .hidden 的兜底处理也在此）
    thumbsContainer.classList.remove('hidden');
    thumbsContainer.style.display = 'flex';
    thumbsContainer.innerHTML = '';
    const fragment = document.createDocumentFragment();

    images.forEach((img, idx) => {
      const thumb = document.createElement('div');
      thumb.className = `lightbox-thumb ${idx === currentIndex ? 'active' : ''}`;
      thumb.setAttribute('data-index', idx);

      const thumbImg = document.createElement('img');
      thumbImg.src = img.src;
      thumbImg.alt = img.alt || '';
      thumb.appendChild(thumbImg);

      thumb.addEventListener('click', (e) => {
        e.stopPropagation();
        showImage(idx);
      });

      fragment.appendChild(thumb);
    });

    thumbsContainer.appendChild(fragment);
  }

  /**
   * Update active class on thumbnails without recreating elements
   */
  function updateThumbnailsActiveState() {
    const thumbsContainer = document.getElementById('lightbox-thumbs');
    if (!thumbsContainer) return;

    const allThumbs = thumbsContainer.querySelectorAll('.lightbox-thumb');
    allThumbs.forEach((thumb, idx) => {
      thumb.classList.toggle('active', idx === currentIndex);
    });

    const activeThumb = thumbsContainer.querySelector('.lightbox-thumb.active');
    if (activeThumb) {
      activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }

  /**
   * Open lightbox modal with provided images and initial index
   */
  function openLightbox(payload) {
    const modal = document.getElementById('lightbox-modal');
    if (!modal) return;

    const src = payload && payload.src;
    const alt = (payload && payload.alt) || '';
    const allImages = (payload && payload.allImages) || [];
    const index = (payload && payload.index) || 0;

    if (Array.isArray(allImages) && allImages.length > 0) {
      images = allImages;
      currentIndex = index >= 0 && index < allImages.length ? index : 0;
    } else if (src) {
      images = [{ src, alt }];
      currentIndex = 0;
    } else {
      return;
    }

    isOpen = true;
    modal.classList.remove('hidden');
    modal.classList.add('active');
    modal.style.display = 'flex';

    // 缩略图条初始带 .hidden（display:none !important），打开时必须显式移除
    const thumbsEl = document.getElementById('lightbox-thumbs');
    if (thumbsEl) thumbsEl.classList.remove('hidden');

    renderThumbnails();
    showImage(currentIndex);
  }

  /**
   * Close lightbox modal
   */
  function closeLightbox() {
    const modal = document.getElementById('lightbox-modal');
    if (!modal) return;

    isOpen = false;
    modal.classList.remove('active');
    modal.classList.add('hidden');
    modal.style.display = 'none';

    // 关闭时恢复缩略图条的初始隐藏状态，避免下次打开出现空条
    const thumbsEl = document.getElementById('lightbox-thumbs');
    if (thumbsEl) {
      thumbsEl.classList.add('hidden');
      thumbsEl.style.display = 'none';
      thumbsEl.innerHTML = '';
    }

    scale = 1;
    translateX = 0;
    translateY = 0;
    fitScale = 1;
    applyTransform();
    images = [];
  }

  /**
   * Zoom controls
   */
  function zoomIn() {
    setScale(scale * ZOOM_FACTOR);
  }

  function zoomOut() {
    setScale(scale / ZOOM_FACTOR);
  }

  /**
   * Bind event listeners for buttons, mouse gestures, and keyboard navigation
   */
  function bindLightboxEvents() {
    const modal = document.getElementById('lightbox-modal');
    const imgEl = document.getElementById('lightbox-img');
    const btnClose = document.getElementById('lightbox-close');
    const btnZoomIn = document.getElementById('lightbox-zoom-in');
    const btnZoomOut = document.getElementById('lightbox-zoom-out');
    const btnReset = document.getElementById('lightbox-reset');
    const btnPrev = document.getElementById('lightbox-prev');
    const btnNext = document.getElementById('lightbox-next');

    if (btnReset) {
      btnReset.title = '适应窗口并复位 (0)';
    }

    // 图片加载完成后再测量 fit 比例（naturalWidth 此时才可靠）
    if (imgEl) {
      imgEl.addEventListener('load', () => {
        if (!isOpen) return;
        fitScale = computeFitScale();
        applyTransform();
      });

      imgEl.addEventListener('error', () => {
        if (!isOpen) return;
        fitScale = 1;
        applyTransform();
      });
    }

    // Close button
    if (btnClose) {
      btnClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeLightbox();
      });
    }

    // Backdrop click to close
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (
          e.target === modal ||
          e.target.classList.contains('lightbox-backdrop') ||
          e.target.classList.contains('lightbox-viewport') ||
          e.target.classList.contains('lightbox-stage')
        ) {
          closeLightbox();
        }
      });
    }

    // Zoom buttons
    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomIn();
      });
    }

    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomOut();
      });
    }

    if (btnReset) {
      btnReset.addEventListener('click', (e) => {
        e.stopPropagation();
        resetTransform();
      });
    }

    // Prev / Next buttons
    if (btnPrev) {
      btnPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        showImage(currentIndex - 1);
      });
    }

    if (btnNext) {
      btnNext.addEventListener('click', (e) => {
        e.stopPropagation();
        showImage(currentIndex + 1);
      });
    }

    // Mouse wheel zoom on modal / image
    if (modal) {
      modal.addEventListener(
        'wheel',
        (e) => {
          if (!isOpen) return;
          e.preventDefault();

          setScale(e.deltaY < 0 ? scale * ZOOM_FACTOR : scale / ZOOM_FACTOR);
        },
        { passive: false }
      );
    }

    // Mouse drag pan on image (only meaningful after zooming in)
    if (imgEl) {
      imgEl.addEventListener('mousedown', (e) => {
        if (!isOpen || scale <= 1) return;
        e.preventDefault();
        isDragging = true;
        dragStartX = e.clientX - translateX;
        dragStartY = e.clientY - translateY;
        applyTransform();
      });

      // Double click toggles fit <-> 2x（快捷放大，不影响按钮/滚轮路径）
      imgEl.addEventListener('dblclick', (e) => {
        if (!isOpen) return;
        e.preventDefault();
        e.stopPropagation();
        setScale(scale === 1 ? 2 : 1);
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (!isDragging || !isOpen) return;
      translateX = e.clientX - dragStartX;
      translateY = e.clientY - dragStartY;
      applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        applyTransform();
      }
    });

    // 窗口尺寸变化后 fit 比例会变，重新同步百分比
    window.addEventListener('resize', () => {
      if (!isOpen) return;
      fitScale = computeFitScale();
      applyTransform();
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        showImage(currentIndex - 1);
      } else if (e.key === 'ArrowRight') {
        showImage(currentIndex + 1);
      } else if (e.key === '+' || e.key === '=') {
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        zoomOut();
      } else if (e.key === '0') {
        resetTransform();
      }
    });
  }

  const Lightbox = {
    init() {
      // 1. Bind UI buttons and gestures
      bindLightboxEvents();

      // 2. Listen to AppBus event
      if (window.AppBus) {
        window.AppBus.on('lightbox:open', (payload) => {
          openLightbox(payload);
        });
      }
    },

    open(payload) {
      openLightbox(payload);
    },

    close() {
      closeLightbox();
    },
  };

  window.Lightbox = Lightbox;
})();
