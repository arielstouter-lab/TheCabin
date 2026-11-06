import { supabase } from './supabase.js';
import { APP_CONFIG, RPC } from './database-config.js';

let appSession = null;

export const AUTH_TIMEOUT_MS = 4000;

export function raceTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The session supabase-js keeps in localStorage. getSession() returns null
// when the access token has expired and the refresh request can't reach the
// network — but in that case the stored session is still there (supabase only
// deletes it when the server actually rejects the refresh token). That lets
// the app keep working offline instead of bouncing to the login page.
export function readStoredSession() {
  try {
    const ref = new URL(APP_CONFIG.supabaseUrl).hostname.split('.')[0];
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return (s && s.access_token && s.refresh_token && s.user) ? s : null;
  } catch (e) {
    return null;
  }
}

export async function resolveSession() {
  if (!supabase) return readStoredSession();
  // No connection: don't wait on a refresh that can't happen.
  if (!navigator.onLine) return readStoredSession();

  try {
    const { data: { session } } = await raceTimeout(supabase.auth.getSession(), AUTH_TIMEOUT_MS);
    if (session) return session;
  } catch (e) {
    // timed out (weak signal) — fall through to the stored session
  }
  return readStoredSession();
}

export async function bootstrapAuth() {
  if (!supabase) return null;
  try {
    const { data, error } = await raceTimeout(
      supabase.functions.invoke('ip-login'),
      AUTH_TIMEOUT_MS * 2
    );
    if (error || !data?.token_hash) return null;

    const { data: verified } = await supabase.auth.verifyOtp({
      type: 'magiclink',
      token_hash: data.token_hash,
    });
    return verified?.session ?? null;
  } catch (e) {
    return null;
  }
}

export function initAppPage(callback) {
  if (typeof callback !== 'function') return;
  if (appSession || (typeof window !== 'undefined' && window.__appSession)) {
    callback(appSession || window.__appSession);
  } else {
    document.addEventListener('app:ready', (e) => {
      callback(e.detail.session);
    }, { once: true });
  }
}

export function getInitial(email) {
  if (!email) return "U";
  return email
    .trim()
    .charAt(0)
    .toUpperCase();
}

export function setupLogin() {
  const form = document.getElementById("login-form");
  if (!form) return;
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");
  const errorElement = document.getElementById("login-error");
  const button = document.getElementById("login-button");
  const buttonText = document.getElementById("login-button-text");
  const spinner = document.getElementById("login-spinner");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (errorElement) {
      errorElement.hidden = true;
      errorElement.textContent = "";
    }

    const username = usernameInput ? usernameInput.value.trim() : "";
    const password = passwordInput ? passwordInput.value : "";

    if (!username || !password) {
      showLoginError("Please enter your email and password.");
      return;
    }

    if (button) button.disabled = true;
    if (buttonText) buttonText.textContent = "Signing in...";
    if (spinner) spinner.hidden = false;

    // Look up the email associated with the username
    const {
      data: email,
      error: lookupError
    } = await supabase.rpc(RPC.GET_EMAIL_FOR_USERNAME, {
      input_username: username
    });

    if (lookupError || !email) {
      showLoginError("Invalid username or password.");
      if (button) button.disabled = false;
      if (buttonText) buttonText.textContent = "Sign in";
      if (spinner) spinner.hidden = true;
      return;
    }

    // Authenticate through Supabase Auth
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (loginError) {
      showLoginError("Invalid username or password.");
      if (button) button.disabled = false;
      if (buttonText) buttonText.textContent = "Sign in";
      if (spinner) spinner.hidden = true;
      return;
    }

    window.location.href = "app.html";

    function showLoginError(message) {
      if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = false;
      }
    }
  });
}

export function setupApp(session) {
  appSession = session;
  if (typeof window !== 'undefined') {
    window.__appSession = session;
  }
  const user = session?.user;

  const emailElement = document.getElementById("user-email");
  const avatarElement = document.getElementById("user-avatar");
  const logoutButton = document.getElementById("logout-button");

  if (emailElement && user) {
    emailElement.textContent = user.email || "User";
  }

  if (avatarElement && user) {
    avatarElement.textContent = getInitial(user.email);
  }

  logoutButton?.addEventListener("click", async () => {
    logoutButton.disabled = true;

    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Logout failed:", error);
      logoutButton.disabled = false;
      return;
    }

    window.location.href = "index.html";
  });

  // Keep the UI in sync if the auth state changes elsewhere.
  // Only an actual sign-out leaves the page: supabase also fires
  // INITIAL_SESSION with a null session when it is offline with an expired
  // token, and that must not kick the user to the login page.
  if (supabase) {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        window.location.href = "index.html";
      }
    });
  }

  document.dispatchEvent(new CustomEvent('app:ready', { detail: { session } }));
}

// Global password toggle handler for any .password-toggle button inside .password-input
document.addEventListener("click", (e) => {
  const toggleBtn = e.target.closest(".password-toggle");
  if (!toggleBtn) return;

  const container = toggleBtn.closest(".password-input");
  const input = container?.querySelector("input");
  if (!input) return;

  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  toggleBtn.textContent = isPassword ? "Hide" : "Show";
  toggleBtn.setAttribute(
    "aria-label",
    isPassword ? "Hide password" : "Show password"
  );
});

export async function initAuth() {
  const currentPage = typeof window !== 'undefined' && window.location && window.location.pathname
    ? (window.location.pathname.split("/").pop() || "index.html")
    : "index.html";
  const PUBLIC_PAGES = ["index.html", ""];

  try {
    let session = await resolveSession();

    // IP-based auto login needs the network; skip it when offline.
    if (!session && navigator.onLine) {
      session = await bootstrapAuth();
    }

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
    const stored = readStoredSession();
    if (stored && !PUBLIC_PAGES.includes(currentPage)) {
      setupApp(stored);
    } else if (!PUBLIC_PAGES.includes(currentPage)) {
      window.location.href = "index.html";
    } else {
      setupLogin();
    }
  }
}

// Global bindings for backward compatibility
if (typeof window !== 'undefined') {
  window.initAppPage = initAppPage;
  window.__appSession = appSession;
}
