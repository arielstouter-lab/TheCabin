// Retrieve global theme mapping and applicator from head-loader.js
function initSettings() {
    const THEMES = window.THEMES || {};
    const applyTheme = window.applyTheme || (() => {});

    const radios = document.querySelectorAll('input[name="theme"]');
    const savedTheme = localStorage.getItem('theme') || 'default';

    radios.forEach(radio => {
        if (radio.value === savedTheme) {
            radio.checked = true;
        }

        radio.addEventListener('change', () => {
            const themeName = radio.value;
            if (THEMES[themeName] !== undefined) {
                applyTheme(THEMES[themeName]);
                localStorage.setItem('theme', themeName);
            }
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettings);
} else {
    initSettings();
}
