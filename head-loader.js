(function() {
const THEMES = {
    dark: {
        primary: "#37533F",
        primaryHover: "#88B092",
        danger: "#D26A56",
        dangerBg: "#3A201A",
        card: "#22251F",
        ink: "#F3F1E8",
        inkSoft: "#B8B5A8",
        ochre: "#D2A14A",
        line: "#44483D",
        successBg: "#233128",
        white: "#161914",
        wxClear: "#3C8A8C",
        wxPartly: "#4D8F92",
        wxOvercast: "#5A6F73",
        wxFog: "#708488",
        wxDrizzle: "#43757C",
        wxRain: "#35666D",
        wxHeavyRain: "#274C53",
        wxSnow: "#7D969B",

    },

    autumn: {
        primary: "#7A4B2D",
        primaryHover: "#986445",
        danger: "#B04A34",
        dangerBg: "#FFF2EE",
        card: "#FCF5EA",
        ink: "#2F261F",
        inkSoft: "#6C5B4B",
        ochre: "#C98A2A",
        line: "#D8C8B2",
        successBg: "#F2F0E1",
        white: "#FFFFFF"
    },

    autumn_evening: {
        primary: "#8B4F2D",
        primaryHover: "#A96742",
        danger: "#B64630",
        dangerBg: "#FFF0EC",
        card: "#f3e9d3",
        ink: "#2E241C",
        inkSoft: "#705E4E",
        ochre: "#D39A32",
        line: "#6B4A6E",
        successBg: "#EEF1E8",
        white: "#FFFCF8",
    }
};

// head-loader.js
    function applyTheme(theme) {
        if (!theme) return;
        const root = document.documentElement;

        const baseProps = {
            "--primary": theme.primary,
            "--primary-hover": theme.primaryHover,
            "--danger": theme.danger,
            "--danger-bg": theme.dangerBg,
            "--card": theme.card,
            "--ink": theme.ink,
            "--ink-soft": theme.inkSoft,
            "--ochre": theme.ochre,
            "--line": theme.line,
            "--success-bg": theme.successBg,
            "--white": theme.white
        };

        const weatherProps = {
            "--wx-clear": theme.wxClear,
            "--wx-partly": theme.wxPartly,
            "--wx-overcast": theme.wxOvercast,
            "--wx-fog": theme.wxFog,
            "--wx-drizzle": theme.wxDrizzle,
            "--wx-rain": theme.wxRain,
            "--wx-heavy-rain": theme.wxHeavyRain,
            "--wx-light-snow": theme.wxLightSnow,
            "--wx-snow": theme.wxSnow,
            "--wx-showers": theme.wxShowers,
            "--wx-violent-showers": theme.wxViolentShowers,
            "--wx-thunderstorm": theme.wxThunderstorm,
            "--wx-severe-storm": theme.wxSevereStorm,
            "--wx-unsettled": theme.wxUnsettled
        };

        // Apply base theme tokens
        Object.entries(baseProps).forEach(([prop, val]) => {
            if (val !== undefined) root.style.setProperty(prop, val);
        });

        // Apply weather tokens or clean up inline overrides so styles.css defaults take over
        Object.entries(weatherProps).forEach(([prop, val]) => {
            if (val !== undefined) {
                root.style.setProperty(prop, val);
            } else {
                root.style.removeProperty(prop);
            }
        });
    }

// Expose for settings.js and other scripts
window.THEMES = THEMES;
window.applyTheme = applyTheme;

// Apply saved theme immediately
const savedTheme = localStorage.getItem('theme');
if (savedTheme && THEMES[savedTheme]) {
    applyTheme(THEMES[savedTheme]);
}
})();

(function() {
    const commonTags = `
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#37533F" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="manifest.json" />
        <link rel="apple-touch-icon" href="pinecone.png" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏠</text></svg>">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    `;
    document.head.insertAdjacentHTML('afterbegin', commonTags);
})();
