/**
 * Lightbox Module
 * Responsible for displaying high-resolution image preview modal, image zooming
 * (button, mouse wheel), panning (mouse drag), thumbnail list, next/prev navigation,
 * keyboard controls, and smooth closing.
 *
 * Fully decoupled: communicates strictly through window.AppBus.
 */
(function () {
  'use strict';

  // State
  let images = [];
  let currentIndex = 0;
  let isOpen = false;

  // Zoom & Pan state
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  const MIN_SCALE = 0.2;
  const MAX_SCALE = 5.0;
  const SCALE_STEP = 0.25;

  /**
   * Update transform on the lightbox image
   */
  function updateImageTransform() {
    const imgEl = document.getElementById('lightbox-img');
    if (!imgEl) return;

    imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    imgEl.style.cursor = isDragging ? 'grabbing' : scale > 1 ? 'grab' : 'default';
  }

  /**
   * Reset zoom and pan coordinates
   */
  function resetTransform() {
    scale = 1;
    translateX = 0;
    translateY = 0;
    updateImageTransform();
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

    if (imgEl && currentImg) {
      imgEl.src = currentImg.src;
      imgEl.alt = currentImg.alt || '';
    }

    if (captionEl) {
      const captionText = currentImg ? (currentImg.alt || currentImg.title || '') : '';
      const counter = images.length > 1 ? ` (${currentIndex + 1} / ${images.length})` : '';
      captionEl.textContent = `${captionText}${counter}`;
    }

    resetTransform();
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

    resetTransform();
    images = [];
  }

  /**
   * Zoom controls
   */
  function zoomIn() {
    scale = Math.min(MAX_SCALE, Math.round((scale + SCALE_STEP) * 100) / 100);
    updateImageTransform();
  }

  function zoomOut() {
    scale = Math.max(MIN_SCALE, Math.round((scale - SCALE_STEP) * 100) / 100);
    updateImageTransform();
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
          e.target.classList.contains('lightbox-viewport')
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

          if (e.deltaY < 0) {
            zoomIn();
          } else {
            zoomOut();
          }
        },
        { passive: false }
      );
    }

    // Mouse drag pan on image
    if (imgEl) {
      imgEl.addEventListener('mousedown', (e) => {
        if (!isOpen) return;
        e.preventDefault();
        isDragging = true;
        dragStartX = e.clientX - translateX;
        dragStartY = e.clientY - translateY;
        updateImageTransform();
      });
    }

    window.addEventListener('mousemove', (e) => {
      if (!isDragging || !isOpen) return;
      translateX = e.clientX - dragStartX;
      translateY = e.clientY - dragStartY;
      updateImageTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        updateImageTransform();
      }
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
