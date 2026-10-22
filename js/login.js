// login.js
// Handles the password form on login.html.
// Sends the password to a Supabase Edge Function for verification —
// never check the password directly in this file, since this JS is
// publicly visible to anyone who views source.
const sb = window.supabaseClient;

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('secret-form');
    const input = document.getElementById('secret-password');
    const errorEl = document.getElementById('secret-error');
    const submitBtn = document.getElementById('secret-submit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideError();
        setLoading(true);

        try {
            const { data, error } = await window.supabaseClient.functions.invoke('verify-secret', {
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
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }

    function hideError() {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }

    function setLoading(isLoading) {
        submitBtn.disabled = isLoading;
        submitBtn.textContent = isLoading ? 'Checking...' : 'Unlock';
    }
});