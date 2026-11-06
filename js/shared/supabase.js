import { APP_CONFIG } from './database-config.js';

// Cap every direct Supabase request so a weak connection fails fast instead of
// hanging the page. Honors an abort signal passed in by the caller (sync.js
// uses one per queued write).
const REQUEST_TIMEOUT_MS = 20000;
export function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

let createClientFn = (typeof window !== 'undefined' && window.supabase && window.supabase.createClient)
  ? window.supabase.createClient
  : null;

if (!createClientFn) {
  try {
    const sbModule = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    createClientFn = sbModule.createClient;
  } catch (e) {
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) {
      createClientFn = window.supabase.createClient;
    } else {
      console.error('Failed to load Supabase client:', e);
    }
  }
}

export const supabase = createClientFn ? createClientFn(
  APP_CONFIG.supabaseUrl,
  APP_CONFIG.supabaseKey,
  {
    global: { fetch: fetchWithTimeout },
    auth: { persistSession: true, autoRefreshToken: true }
  }
) : null;

export const supabaseClient = supabase;

if (typeof window !== 'undefined') {
  window.supabaseClient = supabase;
}
