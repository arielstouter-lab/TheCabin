// Retrieve global theme mapping and applicator from head-loader.js
const THEMES = window.THEMES || {};
const applyTheme = window.applyTheme || (() => {});

// Select all theme radio inputs
const radios = document.querySelectorAll('input[name="theme"]');

// 1. Read the saved theme from persistent memory (defaulting to 'default')
const savedTheme = localStorage.getItem('theme') || 'default';

// 2. Synchronize radio buttons and attach persistence listeners
radios.forEach(radio => {
    // Check the radio matching the stored theme
    if (radio.value === savedTheme) {
        radio.checked = true;
    }

    // Save and apply whenever the user selects a new option
    radio.addEventListener('change', () => {
        const themeName = radio.value;
        if (THEMES[themeName]) {
            applyTheme(THEMES[themeName]);
            localStorage.setItem('theme', themeName);
        }
    });
});