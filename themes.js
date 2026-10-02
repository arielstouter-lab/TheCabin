export const THEMES = {
    default: {
        primary: "#37533F",
        primaryHover: "#5C7A67",
        danger: "#A6432F",
        dangerBg: "#fef3f2",
        card: "#FBF8EF",
        ink: "#24261F",
        inkSoft: "#5B5B4E",
        ochre: "#B8862E",
        line: "#C9C2A8",
        successBg: "#f0f4f0",
        white: "#ffffff"
    },

    dark: {
        primary: "#6F9A7A",
        primaryHover: "#88B092",
        danger: "#D26A56",
        dangerBg: "#fef3f2",
        card: "#22251F",
        ink: "#F3F1E8",
        inkSoft: "#B8B5A8",
        ochre: "#D2A14A",
        line: "#44483D",
        successBg: "#233128",
        white: "#161914"
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
        card: "#F8F1E4",
        ink: "#2E241C",
        inkSoft: "#705E4E",
        ochre: "#D39A32",
        line: "#D2C1A9",
        successBg: "#EEF1E8",
        white: "#FFFCF8",
    }
};

function applyTheme(theme) {
    const root = document.documentElement;

    root.style.setProperty("--primary", theme.primary);
    root.style.setProperty("--primary-hover", theme.primaryHover);
    root.style.setProperty("--danger", theme.danger);
    root.style.setProperty("--danger-bg", theme.dangerBg);
    root.style.setProperty("--card", theme.card);
    root.style.setProperty("--ink", theme.ink);
    root.style.setProperty("--ink-soft", theme.inkSoft);
    root.style.setProperty("--ochre", theme.ochre);
    root.style.setProperty("--line", theme.line);
    root.style.setProperty("--success-bg", theme.successBg);
    root.style.setProperty("--white", theme.white);
}