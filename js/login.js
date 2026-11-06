// login.js
// Handles the password form on login.html.
// Sends the password to a Supabase Edge Function for verification —
// never check the password directly in this file, since this JS is
// publicly visible to anyone who views source.
import { supabase as sb } from './shared/supabase.js';

function setupSecretLogin() {
    const form = document.getElementById('secret-form');
    const input = document.getElementById('secret-password');
    const errorEl = document.getElementById('secret-error');
    const submitBtn = document.getElementById('secret-submit');

    if (!form || !input) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError();
        setLoading(true);

        try {
            const client = sb || window.supabaseClient;
            const { data, error } = await client.functions.invoke('verify-secret', {
                body: { password: input.value }
            });

            if (error || !data?.ok) {
                showError('Incorrect password. Try again.');
                setLoading(false);
                return;
            }

            // Success — the edge function has set the unlock flag server-side.
            // Redirect to the page/section that fetches the gated content.
            window.location.href = 'secret-content.html';
        } catch (err) {
            console.error(err);
            showError('Something went wrong. Please try again.');
            setLoading(false);
        }
    });

    function showError(message) {
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
        }
    }

    function hideError() {
        if (errorEl) {
            errorEl.textContent = '';
            errorEl.classList.add('hidden');
        }
    }

    function setLoading(isLoading) {
        if (submitBtn) {
            submitBtn.disabled = isLoading;
            submitBtn.textContent = isLoading ? 'Checking...' : 'Unlock';
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupSecretLogin);
} else {
    setupSecretLogin();
}
