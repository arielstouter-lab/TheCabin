import {
  initAuth,
  initAppPage,
  setupApp,
  setupLogin,
  resolveSession,
  bootstrapAuth,
  readStoredSession,
  getInitial
} from './shared/auth.js';
import { supabase, supabaseClient } from './shared/supabase.js';
import { APP_CONFIG, TABLES, RPC } from './shared/database-config.js';

export {
  initAuth,
  initAppPage,
  setupApp,
  setupLogin,
  resolveSession,
  bootstrapAuth,
  readStoredSession,
  getInitial,
  supabase,
  supabaseClient,
  APP_CONFIG,
  TABLES,
  RPC
};

// Register Service Worker for PWA and offline resilience.
// sw.js lives at the site root so it controls every page.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// Global session store & unified page initialization helper bridge
if (typeof window !== 'undefined') {
  window.initAppPage = initAppPage;
}

// Bootstrap authentication
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initAuth();
  });
} else {
  initAuth();
}

/* -----------------------------
   PWA Install Prompt
----------------------------- */

let deferredInstallPrompt = null;

export function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function getInstallInstructions() {
  const ua = navigator.userAgent.toLowerCase();

  if (/iphone|ipad|ipod/.test(ua)) {
    return 'To install: tap Share, then Add to Home Screen.';
  }

  if (/firefox/.test(ua)) {
    return 'Firefox desktop does not support the install prompt. Use your browser menu or try Chrome/Edge for one-click install.';
  }

  if (/duckduckgo/.test(ua)) {
    return 'Use your browser menu and choose Add to Home screen, if available.';
  }

  if (/android/.test(ua)) {
    return 'Use your browser menu and choose Install app or Add to Home screen.';
  }

  return 'Use your browser menu to install this app, or try Chrome/Edge for one-click install.';
}

export function setupInstallPrompt() {
  const installButton = document.getElementById('installAppBtn');
  if (!installButton) return;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });

  installButton.addEventListener('click', async () => {
    if (isStandaloneApp()) {
      setStatus('The Cabin is already installed.', 'success');
      return;
    }

    if (!deferredInstallPrompt) {
      showToast(getInstallInstructions(), 'info', 6000);
      return;
    }

    deferredInstallPrompt.prompt();

    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      setStatus('Installing The Cabin.', 'success');
    } else {
      setStatus('Install canceled.', 'info');
    }

    deferredInstallPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setStatus('The Cabin was installed.', 'success');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupInstallPrompt);
} else {
  setupInstallPrompt();
}

/* -----------------------------
   Hidden Trigger Navigation
----------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  const trigger = document.getElementById('hidden-icon');
  if (!trigger) return;

  trigger.addEventListener('click', () => {
    window.location.href = 'login.html';
  });
});

/* -----------------------------
   Grocery Key & Matching Helpers
----------------------------- */

export function groceryKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|of|for|with|and)\b/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(word => {
      if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
      if (word.endsWith('es') && word.length > 3) return word.slice(0, -2);
      if (word.endsWith('s') && word.length > 3) return word.slice(0, -1);
      return word;
    })
    .join(' ');
}

export function groceryWords(text) {
  return groceryKey(text).split(' ').filter(Boolean);
}

export function groceryKeysMatch(itemText, memoryKey) {
  const itemKey = groceryKey(itemText);
  const normalizedMemoryKey = groceryKey(memoryKey);

  if (!itemKey || !normalizedMemoryKey) return false;
  if (itemKey === normalizedMemoryKey) return true;
  if (itemKey.includes(normalizedMemoryKey) || normalizedMemoryKey.includes(itemKey)) return true;

  const itemWords = groceryWords(itemKey);
  const memoryWords = groceryWords(normalizedMemoryKey);

  return memoryWords.some(memoryWord => itemWords.includes(memoryWord));
}

if (typeof window !== 'undefined') {
  window.groceryKey = groceryKey;
  window.groceryKeysMatch = groceryKeysMatch;
}

/* -----------------------------
   Date & Seasonal Theme Helpers
----------------------------- */

export function todayStr(d) {
  const t = d ? new Date(d) : new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

export function getSeason(date) {
  const d = date ? new Date(date) : new Date();
  const m = d.getMonth() + 1; // 1-12
  const day = d.getDate();

  if ((m === 3 && day >= 20) || m === 4 || m === 5 || (m === 6 && day < 21)) return 'spring';
  if ((m === 6 && day >= 21) || m === 7 || m === 8 || (m === 9 && day < 22)) return 'summer';
  if ((m === 9 && day >= 22) || m === 10 || m === 11 || (m === 12 && day < 21)) return 'fall';
  return 'winter';
}

const SEASON_IMAGES = {
  spring: 'Images/spring.jpg',
  summer: 'Images/summer.jpg',
  fall: 'Images/fall.jpg',
  winter: 'Images/winter.jpg'
};

let currentSeason = null;
let seasonLoadToken = 0;

export function updateSeason(date) {
  if (!document.body || !document.body.classList.contains('cal-page')) return;

  const season = getSeason(date);
  if (season === currentSeason && document.body.classList.contains('img-loaded')) return;
  currentSeason = season;

  const myToken = ++seasonLoadToken;
  const el = document.body;

  const swapImage = () => {
    const img = new Image();
    img.onload = () => {
      if (myToken !== seasonLoadToken) return;
      el.style.setProperty('--season-img', `url(${SEASON_IMAGES[season]})`);
      void el.offsetHeight;
      el.classList.add('img-loaded');
    };
    img.src = SEASON_IMAGES[season];
  };

  if (el.classList.contains('img-loaded')) {
    el.addEventListener('transitionend', swapImage, { once: true });
    el.classList.remove('img-loaded');
  } else {
    el.dataset.season = season;
    swapImage();
  }
}

export function initSeasonalBackground() {
  if (!document.body || !document.body.classList.contains('cal-page')) return;
  updateSeason(new Date());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSeasonalBackground);
} else {
  initSeasonalBackground();
}

if (typeof window !== 'undefined') {
  window.todayStr = todayStr;
  window.getSeason = getSeason;
  window.updateSeason = updateSeason;
  window.initSeasonalBackground = initSeasonalBackground;
}

/* -----------------------------
   Shared UI Helpers
----------------------------- */

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

export function escapeAttr(str) {
  return escapeHtml(str);
}

/* -----------------------------
   Unified Toast & Status System
----------------------------- */

export function showToast(options, optionalType, optionalDuration) {
  let message = '';
  let type = 'info';
  let duration = 3000;

  if (typeof options === 'string') {
    message = options;
    if (typeof optionalType === 'string') type = optionalType;
    if (typeof optionalDuration === 'number') duration = optionalDuration;
  } else if (options && typeof options === 'object') {
    message = options.message || '';
    type = options.type || 'info';
    duration = options.duration ?? 3000;
  }

  if (!message) return null;

  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  const icons = {
    success: '✓',
    error: '⚠',
    warning: '!',
    info: 'ℹ'
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || 'ℹ'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button type="button" class="toast-close" aria-label="Close">✕</button>
  `;

  const removeToast = () => {
    if (toast.classList.contains('toast-hiding')) return;
    toast.classList.remove('toast-visible');
    toast.classList.add('toast-hiding');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  };

  toast.querySelector('.toast-close').addEventListener('click', removeToast);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-visible');
  });

  if (duration > 0) {
    setTimeout(removeToast, duration);
  }

  return toast;
}

export function setStatus(msg, targetIdOrType, maybeType) {
  if (!msg) return;
  let type = 'info';
  let targetId = null;

  if (typeof targetIdOrType === 'string') {
    if (['info', 'success', 'error', 'warning'].includes(targetIdOrType)) {
      type = targetIdOrType;
    } else {
      targetId = targetIdOrType;
    }
  }
  if (typeof maybeType === 'string') {
    type = maybeType;
  }

  if (type === 'info' && /could not|failed|error|invalid|unable/i.test(msg)) {
    type = 'error';
  } else if (type === 'info' && /saved|updated|added|copied|success|reordered|balanced/i.test(msg)) {
    type = 'success';
  }

  const el = (targetId && document.getElementById(targetId)) ||
      document.querySelector('.note') ||
      document.getElementById('status-line') ||
      document.getElementById('lst-status');
  if (el) {
    el.textContent = msg;
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 2400);
  }

  showToast(msg, type, 3000);
}

if (typeof window !== 'undefined') {
  window.showToast = showToast;
  window.setStatus = setStatus;
}

/* -----------------------------
   Shared Drag & Drop
----------------------------- */

/**
 * Generic Drag and Drop Reordering Helper (Desktop + Mobile Touch)
 * @param {HTMLElement} container - The list/panel container element
 * @param {Object} options
 * @param {string} [options.itemSelector='.draggable-item'] - Selector for draggable rows
 * @param {string} [options.handleSelector='.drag-handle'] - Selector for the drag handle
 * @param {Function} options.onReorder - Callback (fromIndex, toIndex) => void
 * @param {Function} [options.canDrag] - Optional validator (itemEl) => boolean
 */
export function initDragAndDrop(container, {
  itemSelector = '.draggable-item',
  handleSelector = '.drag-handle',
  onReorder,
  canDrag = () => true
}) {
  if (!container) return;

  // --- Desktop HTML5 Drag & Drop ---
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !canDrag(item)) return;
    item.classList.add('is-dragging');
    e.dataTransfer.setData('text/plain', item.dataset.index);
  });

  container.addEventListener('dragend', (e) => {
    const item = e.target.closest(itemSelector);
    if (item) item.classList.remove('is-dragging');
    container.querySelectorAll(itemSelector).forEach(el => el.classList.remove('is-drag-over'));
  });

  container.addEventListener('dragover', (e) => {
    const overItem = e.target.closest(itemSelector);
    if (!overItem || !canDrag(overItem)) return;
    e.preventDefault();
    container.querySelectorAll(itemSelector).forEach(el => {
      if (el === overItem && !el.classList.contains('is-dragging')) {
        el.classList.add('is-drag-over');
      } else {
        el.classList.remove('is-drag-over');
      }
    });
  });

  container.addEventListener('dragleave', (e) => {
    const overItem = e.target.closest(itemSelector);
    if (overItem) overItem.classList.remove('is-drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.querySelectorAll(itemSelector).forEach(el => {
      el.classList.remove('is-dragging', 'is-drag-over');
    });
    const fromIndexStr = e.dataTransfer.getData('text/plain');
    if (!fromIndexStr) return;
    const fromIndex = Number(fromIndexStr);
    const targetItem = e.target.closest(itemSelector);
    if (!targetItem || !canDrag(targetItem)) return;
    const toIndex = Number(targetItem.dataset.index);

    if (!isNaN(fromIndex) && !isNaN(toIndex) && fromIndex !== toIndex) {
      onReorder(fromIndex, toIndex);
    }
  });

  // --- Mobile Touch Drag & Drop ---
  let touchDragItem = null;
  let touchFromIndex = null;
  let touchCurrentOverItem = null;

  function clearTouchDragState() {
    if (touchDragItem) {
      touchDragItem.classList.remove('is-dragging');
    }

    if (touchCurrentOverItem) {
      touchCurrentOverItem.classList.remove('is-drag-over');
    }

    container.querySelectorAll(itemSelector).forEach(el => {
      el.classList.remove('is-dragging', 'is-drag-over');
    });

    touchDragItem = null;
    touchFromIndex = null;
    touchCurrentOverItem = null;
  }

  function handleTouchEnd() {
    if (!touchDragItem) return;

    const fromIndex = touchFromIndex;
    const toIndex = touchCurrentOverItem
        ? Number(touchCurrentOverItem.dataset.index)
        : null;

    clearTouchDragState();

    if (!isNaN(fromIndex) && !isNaN(toIndex) && fromIndex !== toIndex) {
      onReorder(fromIndex, toIndex);
    }
  }

  function handleTouchCancel() {
    clearTouchDragState();
  }

  container.addEventListener('touchstart', (e) => {
    if (e.target.closest('button, input, select, textarea, .icon-delete')) return;
    const handle = e.target.closest(handleSelector);
    if (!handle) return;
    const item = handle.closest(itemSelector);
    if (!item || !canDrag(item)) return;

    clearTouchDragState();

    touchDragItem = item;
    touchFromIndex = Number(item.dataset.index);
    touchCurrentOverItem = null;
    item.classList.add('is-dragging');
  }, {passive: true});

  container.addEventListener('touchmove', (e) => {
    if (!touchDragItem) return;

    const touch = e.touches[0];
    if (!touch) {
      clearTouchDragState();
      return;
    }

    const target = document.elementFromPoint(touch.clientX, touch.clientY);
    const overItem = target ? target.closest(itemSelector) : null;

    if (overItem && overItem !== touchDragItem && container.contains(overItem) && canDrag(overItem)) {
      if (touchCurrentOverItem && touchCurrentOverItem !== overItem) {
        touchCurrentOverItem.classList.remove('is-drag-over');
      }

      touchCurrentOverItem = overItem;
      overItem.classList.add('is-drag-over');
    } else {
      if (touchCurrentOverItem) {
        touchCurrentOverItem.classList.remove('is-drag-over');
      }

      touchCurrentOverItem = null;
    }

    if (e.cancelable) e.preventDefault();
  }, {passive: false});

  document.addEventListener('touchend', handleTouchEnd);
  document.addEventListener('touchcancel', handleTouchCancel);
  window.addEventListener('blur', handleTouchCancel);
}
