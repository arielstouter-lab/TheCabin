const { createClient } = window.supabase;

const supabaseClient = createClient(
  window.APP_CONFIG.supabaseUrl,
  window.APP_CONFIG.supabaseKey
);
window.supabaseClient = supabaseClient;

document.addEventListener("DOMContentLoaded", async () => {
  const currentPage = window.location.pathname.split("/").pop() || "index.html";

  try {
    let {
      data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session) {
      session = await bootstrapAuth();
    }

    const PUBLIC_PAGES = ["index.html", ""];

    if (PUBLIC_PAGES.includes(currentPage)) {
      if (session) {
        window.location.href = "app.html";
        return;
      }
      setupLogin();
      return;
    }

    if (!session) {
      window.location.href = "index.html";
      return;
    }
    setupApp(session);

  } catch (err) {
    console.error("Auth bootstrap failed:", err);
    if (currentPage !== "index.html" && currentPage !== "") {
      window.location.href = "index.html";
    } else {
      setupLogin();
    }
  }
});

/* -----------------------------
   Login
----------------------------- */

async function bootstrapAuth() {
  const { data: { session } } = await supabaseClient.auth.getSession()
  if (session) return session

  const { data, error } = await supabaseClient.functions.invoke('ip-login')
  if (error || !data?.token_hash) return null

  const { data: verified } = await supabaseClient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: data.token_hash,
  })
  return verified?.session ?? null
}

function setupLogin() {
  const form = document.getElementById("login-form");
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");
  const togglePassword = document.getElementById("toggle-password");
  const errorElement = document.getElementById("login-error");
  const button = document.getElementById("login-button");
  const buttonText = document.getElementById("login-button-text");
  const spinner = document.getElementById("login-spinner");

  togglePassword.addEventListener("click", () => {
    const isPassword = passwordInput.type === "password";

    passwordInput.type = isPassword ? "text" : "password";
    togglePassword.textContent = isPassword ? "Hide" : "Show";
    togglePassword.setAttribute(
      "aria-label",
      isPassword ? "Hide password" : "Show password"
    );
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    errorElement.hidden = true;
    errorElement.textContent = "";

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showLoginError("Please enter your email and password.");
      return;
    }

    button.disabled = true;
    buttonText.textContent = "Signing in...";
    spinner.hidden = false;

    // Look up the email associated with the username
    const {
      data: email,
      error: lookupError
    } = await supabaseClient.rpc("get_email_for_username", {
      input_username: username
    });

    if (lookupError || !email) {
      showLoginError("Invalid username or password.");

      button.disabled = false;
      buttonText.textContent = "Sign in";
      spinner.hidden = true;

      return;
    }

    // Authenticate through Supabase Auth
    const { error: loginError } =
      await supabaseClient.auth.signInWithPassword({
        email,
        password
      });

    if (loginError) {
      showLoginError("Invalid username or password.");

      button.disabled = false;
      buttonText.textContent = "Sign in";
      spinner.hidden = true;

      return;
    }

    window.location.href = "app.html";

      function showLoginError(message) {
        errorElement.textContent = message;
        errorElement.hidden = false;
      }
    });
}

/* -----------------------------
   App
----------------------------- */

function setupApp(session) {
  const user = session.user;

  const emailElement = document.getElementById("user-email");
  const avatarElement = document.getElementById("user-avatar");
  const logoutButton = document.getElementById("logout-button");

  if (emailElement) {
    emailElement.textContent = user.email || "User";
  }

  if (avatarElement) {
    avatarElement.textContent = getInitial(user.email);
  }

  logoutButton?.addEventListener("click", async () => {
    logoutButton.disabled = true;

    const { error } = await supabaseClient.auth.signOut();

    if (error) {
      console.error("Logout failed:", error);
      logoutButton.disabled = false;
      return;
    }

    window.location.href = "index.html";
  });

  // Keep the UI in sync if the auth state changes elsewhere.
  supabaseClient.auth.onAuthStateChange((event, newSession) => {
    if (event === "SIGNED_OUT" || !newSession) {
      window.location.href = "index.html";
    }
  });
  document.dispatchEvent(new CustomEvent('app:ready', { detail: { session } }));
}


/* -----------------------------
   Helpers
----------------------------- */
function groceryKey(text) {
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

function groceryWords(text) {
  return groceryKey(text).split(' ').filter(Boolean);
}

function groceryKeysMatch(itemText, memoryKey) {
  const itemKey = groceryKey(itemText);
  const normalizedMemoryKey = groceryKey(memoryKey);

  if (!itemKey || !normalizedMemoryKey) return false;
  if (itemKey === normalizedMemoryKey) return true;

  const itemWords = groceryWords(itemKey);
  const memoryWords = groceryWords(normalizedMemoryKey);

  return memoryWords.some(memoryWord => itemWords.includes(memoryWord));
}

window.groceryKey = groceryKey;
window.groceryKeysMatch = groceryKeysMatch;


function getInitial(email) {
  if (!email) return "U";

  return email
    .trim()
    .charAt(0)
    .toUpperCase();
}


function getFriendlyAuthError(error) {
  if (!error) {
    return "Something went wrong. Please try again.";
  }

  switch (error.message) {
    case "Invalid login credentials":
      return "Incorrect email or password.";

    case "Email not confirmed":
      return "Your account has not been confirmed.";

    default:
      return error.message || "Unable to sign in.";
  }
}

/* -----------------------------
   Shared UI Helpers
----------------------------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function setStatus(msg, targetId) {
  const el = (targetId && document.getElementById(targetId)) ||
             document.querySelector('.status-line') ||
             document.getElementById('status-line') ||
             document.getElementById('lst-status');
  if (!el) return;
  el.textContent = msg || '';
  if (msg) {
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 2200);
  }
}

window.escapeHtml = escapeHtml;
window.escapeAttr = escapeAttr;
window.setStatus = setStatus;

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
function initDragAndDrop(container, {
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