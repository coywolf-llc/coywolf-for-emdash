/**
 * Code block themes: Coywolf's own palette (auto / light / dark), a few
 * light+dark pairs that follow the visitor's system setting, and a curated
 * set of highlight.js themes (themes.generated.ts), with any color under
 * 4.5:1 against its background darkened or lightened to pass (contrast.ts).
 * Only the active theme's CSS is sent, and only on pages that render a code block.
 */
import { mutedColor, readableThemeCss } from "./contrast.js";
import { HLJS_THEMES } from "./themes.generated.js";

export const THEME_SETTING = "codeBlocksTheme";
export const DEFAULT_THEME = "coywolf-auto";

export interface ThemeOption {
	id: string;
	label: string;
	group: string;
}

const DARK = "@media (prefers-color-scheme:dark)";
const LIGHT = "@media not all and (prefers-color-scheme:dark)";

/** Light and dark pairs that switch with the visitor's system setting. */
const AUTO_PAIRS: Record<string, { label: string; light: string; dark: string }> = {
	"github-auto": { label: "GitHub (light/dark by system)", light: "github", dark: "github-dark" },
	"atom-one-auto": { label: "Atom One (light/dark by system)", light: "atom-one-light", dark: "atom-one-dark" },
	"a11y-auto": { label: "A11y (light/dark by system)", light: "a11y-light", dark: "a11y-dark" },
	"tokyo-night-auto": { label: "Tokyo Night (light/dark by system)", light: "tokyo-night-light", dark: "tokyo-night-dark" },
};

// ── Coywolf palette (ported from Code Block Enhancer's default theme) ──

const COYWOLF_LIGHT =
	"--cw-bg:#fff;--cw-fg:#1f2328;--cw-comment:#4b5563;--cw-punct:#374151;--cw-keyword:#7e22ce;--cw-function:#1d4ed8;--cw-string:#166534;--cw-variable:#9a3412;--cw-number:#155e75;--cw-operator:#111827;--cw-del:#b91c1c";
const COYWOLF_DARK =
	"--cw-bg:#050520;--cw-fg:#e6edf3;--cw-comment:#8b949e;--cw-punct:#c9d1d9;--cw-keyword:#c084fc;--cw-function:#60a5fa;--cw-string:#4ade80;--cw-variable:#fb923c;--cw-number:#22d3ee;--cw-operator:#e6edf3;--cw-del:#f87171";

const COYWOLF_TOKENS = [
	".cw-code{background:var(--cw-bg);color:var(--cw-fg);--cw-line:var(--cw-comment)}",
	".cw-code .hljs-comment,.cw-code .hljs-quote,.cw-code .hljs-meta{color:var(--cw-comment)}",
	".cw-code .hljs-comment,.cw-code .hljs-quote{font-style:italic}",
	".cw-code .hljs-punctuation,.cw-code .hljs-tag{color:var(--cw-punct)}",
	".cw-code .hljs-keyword,.cw-code .hljs-built_in,.cw-code .hljs-selector-tag,.cw-code .hljs-doctag,.cw-code .hljs-meta .hljs-keyword,.cw-code .hljs-type{color:var(--cw-keyword)}",
	".cw-code .hljs-title,.cw-code .hljs-section,.cw-code .hljs-name,.cw-code .hljs-selector-id,.cw-code .hljs-selector-class,.cw-code .hljs-selector-pseudo{color:var(--cw-function)}",
	".cw-code .hljs-string,.cw-code .hljs-regexp,.cw-code .hljs-addition,.cw-code .hljs-meta .hljs-string,.cw-code .hljs-char.escape_{color:var(--cw-string)}",
	".cw-code .hljs-variable,.cw-code .hljs-template-variable,.cw-code .hljs-attr,.cw-code .hljs-attribute,.cw-code .hljs-property,.cw-code .hljs-params,.cw-code .hljs-selector-attr{color:var(--cw-variable)}",
	".cw-code .hljs-number,.cw-code .hljs-literal,.cw-code .hljs-symbol,.cw-code .hljs-bullet,.cw-code .hljs-variable.constant_{color:var(--cw-number)}",
	".cw-code .hljs-operator,.cw-code .hljs-link,.cw-code .hljs-subst{color:var(--cw-operator)}",
	".cw-code .hljs-deletion{color:var(--cw-del)}",
	".cw-code .hljs-emphasis{font-style:italic}.cw-code .hljs-strong{font-weight:bold}",
].join("");

function coywolfCss(mode: "auto" | "light" | "dark"): string {
	if (mode === "light") return `.cw-code{${COYWOLF_LIGHT};color-scheme:light}${COYWOLF_TOKENS}`;
	if (mode === "dark") return `.cw-code{${COYWOLF_DARK};color-scheme:dark}${COYWOLF_TOKENS}`;
	return `.cw-code{${COYWOLF_LIGHT};color-scheme:light}${DARK}{.cw-code{${COYWOLF_DARK};color-scheme:dark}}${COYWOLF_TOKENS}`;
}

const COYWOLF: Record<string, { label: string; mode: "auto" | "light" | "dark" }> = {
	"coywolf-auto": { label: "Coywolf Auto (light/dark by system)", mode: "auto" },
	"coywolf-light": { label: "Coywolf — Always light", mode: "light" },
	"coywolf-dark": { label: "Coywolf — Always dark", mode: "dark" },
};

/** Per-isolate: each theme's CSS with its low-contrast colors fixed (see contrast.ts). */
const readable = new Map<string, string>();

function hljsCss(id: string): string {
	const theme = HLJS_THEMES[id];
	if (!theme) return "";
	let css = readable.get(id);
	if (css === undefined) {
		const fixed = readableThemeCss(theme.css);
		// --cw-line: the line-number color (render.ts), muted but still 4.5:1.
		css = `${fixed}.cw-code{--cw-line:${mutedColor(fixed)}}`;
		readable.set(id, css);
	}
	return `.cw-code{color-scheme:${theme.scheme}}${css}`;
}

export function themeOptions(): ThemeOption[] {
	return [
		...Object.entries(COYWOLF).map(([id, t]) => ({ id, label: t.label, group: "Coywolf" })),
		...Object.entries(AUTO_PAIRS).map(([id, t]) => ({ id, label: t.label, group: "Light/dark pairs" })),
		...Object.entries(HLJS_THEMES).map(([id, t]) => ({ id, label: t.label, group: t.scheme === "dark" ? "Dark themes" : "Light themes" })),
	];
}

export function isTheme(id: unknown): id is string {
	return typeof id === "string" && (id in COYWOLF || id in AUTO_PAIRS || id in HLJS_THEMES);
}

/** The CSS for one theme (falls back to the default for unknown ids). */
export function themeCss(id: string | null | undefined): string {
	const key = isTheme(id) ? id : DEFAULT_THEME;
	const coywolf = COYWOLF[key];
	if (coywolf) return coywolfCss(coywolf.mode);
	const pair = AUTO_PAIRS[key];
	if (pair) return `${LIGHT}{${hljsCss(pair.light)}}${DARK}{${hljsCss(pair.dark)}}`;
	return hljsCss(key);
}
