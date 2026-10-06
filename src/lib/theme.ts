export type Theme = "dark" | "light";
export const THEME_KEY = "openlounge:theme";
/** Pre-rename keys (Lounge, Clubroom) still honoured so the chosen theme survives the rename. */
export const LEGACY_THEME_KEYS = ["lounge:theme", "clubroom:theme"];
export const THEME_COLORS: Record<Theme, string> = { dark: "#0b0b0d", light: "#f4f3ee" };

/** Inline script run before first paint so there's no flash of the wrong theme. */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${THEME_KEY}")||localStorage.getItem("${LEGACY_THEME_KEYS[0]}")||localStorage.getItem("${LEGACY_THEME_KEYS[1]}");if(t!=="light"&&t!=="dark")t="dark";var d=document.documentElement;d.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"${THEME_COLORS.light}":"${THEME_COLORS.dark}");}catch(e){}})();`;
