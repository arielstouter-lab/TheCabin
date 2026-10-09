(function() {
const THEMES = {
    default: {},

    dark: {
        primary: "#37533F",
        primaryHover: "#7ea594",
        danger: "#D26A56",
        dangerBg: "#3A201A",
        card: "#22251F",
        ink: "#F3F1E8",
        inkSoft: "#B8B5A8",
        ochre: "#D2A14A",
        line: "#44483D",
        successBg: "#233128",
        gradientShade: "#0d1420",

        wxClear: "#3C8A8C",
        wxPartly: "#4D8F92",
        wxOvercast: "#5A6F73",
        wxFog: "#708488",
        wxDrizzle: "#43757C",
        wxRain: "#35666D",
        wxHeavyRain: "#274C53",
        wxLightSnow: "#7D969B",
        wxSnow: "#7D969B",
        wxShowers: "#43757C",
        wxViolentShowers: "#274C53",
        wxThunderstorm: "#292f45",
        wxSevereThunderstorm: "#292f45",

        /*Special one off colors*/
        navLabel: "#B8B5A8",

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
        gradientShade: "#768796",

        wxClear: "#D89A2B",
        wxPartly: "#C87B32",
        wxOvercast: "#8A684C",
        wxFog: "#A08B79",
        wxDrizzle: "#A15C38",
        wxRain: "#8B4F2D",
        wxHeavyRain: "#55372a",
        wxLightSnow: "#D7C8B1",
        wxSnow: "#BFB0A0",
        wxShowers: "#A85A2F",
        wxViolentShowers: "#7A3F27",
        wxThunderstorm: "#5C3E63",
        wxSevereThunderstorm: "#402847",
        wxUnsettled: "#7A5A80",

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
        gradientShade: "#0d1420",

        wxClear: "#E0A83A",
        wxPartly: "#CA7D3C",
        wxOvercast: "#7B6354",
        wxFog: "#96897B",
        wxDrizzle: "#98583C",
        wxRain: "#7B432E",
        wxHeavyRain: "#5F3224",
        wxLightSnow: "#D9CEBF",
        wxSnow: "#C8B8A8",
        wxShowers: "#9F562D",
        wxViolentShowers: "#713626",
        wxThunderstorm: "#56385F",
        wxSevereThunderstorm: "#38203F",
        wxUnsettled: "#6A4B74",

        navLabel: "#88778A"
    }
};

// head-loader.js
    function applyTheme(theme) {
        const root = document.documentElement;
        const activeTheme = theme || {};

        const allProps = {
            // Base tokens
            "--primary": activeTheme.primary,
            "--primary-hover": activeTheme.primaryHover,
            "--danger": activeTheme.danger,
            "--danger-bg": activeTheme.dangerBg,
            "--card": activeTheme.card,
            "--ink": activeTheme.ink,
            "--ink-soft": activeTheme.inkSoft,
            "--ochre": activeTheme.ochre,
            "--line": activeTheme.line,
            "--success-bg": activeTheme.successBg,
            "--white": activeTheme.white,
            "--gradient-shade": activeTheme.gradientShade,

            // Weather tokens
            "--wx-clear": activeTheme.wxClear,
            "--wx-partly": activeTheme.wxPartly,
            "--wx-overcast": activeTheme.wxOvercast,
            "--wx-fog": activeTheme.wxFog,
            "--wx-drizzle": activeTheme.wxDrizzle,
            "--wx-rain": activeTheme.wxRain,
            "--wx-heavy-rain": activeTheme.wxHeavyRain,
            "--wx-light-snow": activeTheme.wxLightSnow,
            "--wx-snow": activeTheme.wxSnow,
            "--wx-showers": activeTheme.wxShowers,
            "--wx-violent-showers": activeTheme.wxViolentShowers,
            "--wx-thunderstorm": activeTheme.wxThunderstorm,
            "--wx-severe-storm": activeTheme.wxSevereThunderstorm,
            "--wx-unsettled": activeTheme.wxUnsettled,

            // One offs
            "--nav-label": activeTheme.navLabel,
        };

        // Apply defined overrides; remove undefined ones so styles.css defaults take over
        Object.entries(allProps).forEach(([prop, val]) => {
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
    const scriptUrl = new URL(document.currentScript.src);
    const appBase = scriptUrl.pathname.replace(/SharedJS\/head-loader\.js$/, '');

    const commonTags = `
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#37533F" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="${appBase}manifest.json" />
        <link rel="apple-touch-icon" href="${appBase}Images/pinecone.png" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏠</text></svg>">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    `;
    document.head.insertAdjacentHTML('afterbegin', commonTags);
})();
