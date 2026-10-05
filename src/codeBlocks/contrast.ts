/**
 * Readable code block themes (WCAG 1.4.3). Several highlight.js themes color
 * comments, and a few their body text, below 4.5:1 against their own
 * background. Rather than hand-edit the generated themes, each theme's CSS is
 * checked once and any color under the minimum is moved in lightness only
 * (same hue and saturation) until it reaches it, so the theme keeps its look.
 */

export const MIN_CONTRAST = 4.5;
/** Aim a little above the minimum so rounding to hex never lands under it. */
const TARGET = 4.6;

type Rgba = [number, number, number, number];

const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", gold: "#ffd700", gray: "#808080", grey: "#808080", red: "#ff0000", green: "#008000", blue: "#0000ff", navy: "#000080", purple: "#800080", maroon: "#800000", teal: "#008080", olive: "#808000", silver: "#c0c0c0" };

/** A CSS color as RGBA (0–255, alpha 0–1), or null for anything else (url(), gradients, inherit…). */
export function parseColor(value: string): Rgba | null {
	const v = value.trim().toLowerCase().replace(/\s*!important$/, "");
	const hex = NAMED[v] ?? v;
	let m = /^#([0-9a-f]{3,4})$/.exec(hex);
	if (m) {
		const [r, g, b, a = "f"] = m[1].split("");
		return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16), parseInt(a + a, 16) / 255];
	}
	m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(hex);
	if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
	m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
	if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
	return null;
}

/** `top` drawn over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
	const a = top[3];
	return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: Rgba): [number, number, number] {
	const [rr, gg, bb] = [r / 255, g / 255, b / 255];
	const max = Math.max(rr, gg, bb);
	const min = Math.min(rr, gg, bb);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
	return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgba {
	if (s === 0) return [l * 255, l * 255, l * 255, 1];
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const ch = (t: number) => {
		const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
		if (x < 1 / 6) return p + (q - p) * 6 * x;
		if (x < 1 / 2) return q;
		if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
		return p;
	};
	return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255, 1];
}

const toHex = (c: Rgba) => `#${c.slice(0, 3).map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`;

/**
 * `color` (any alpha, drawn over `background`) made readable on `background`:
 * unchanged when it already passes, else the nearest lightness that does
 * (lighter on dark backgrounds, darker on light ones). Returns an opaque hex.
 */
export function readableOn(color: Rgba, background: Rgba): Rgba {
	const solid = over(color, background);
	if (contrastRatio(solid, background) >= MIN_CONTRAST) return solid;
	const [h, s, l] = toHsl(solid);
	const lighter = luminance(background) < 0.18;
	let [lo, hi] = lighter ? [l, 1] : [0, l];
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		const ok = contrastRatio(fromHsl(h, s, mid), background) >= TARGET;
		if (lighter) ok ? (hi = mid) : (lo = mid);
		else ok ? (lo = mid) : (hi = mid);
	}
	const fixed = parseColor(toHex(fromHsl(h, s, lighter ? hi : lo))) as Rgba;
	return contrastRatio(fixed, background) >= MIN_CONTRAST ? fixed : lighter ? [255, 255, 255, 1] : [0, 0, 0, 1];
}

interface Rule {
	selectors: string[];
	body: string;
}

const RULE = /([^{}]+)\{([^{}]*)\}/g;
const DECL = (name: string) => new RegExp(`(^|;)(\\s*${name}\\s*:\\s*)([^;]+)`, "i");

function parseRules(css: string): Rule[] {
	return [...css.matchAll(RULE)].map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()), body: m[2] }));
}

const declared = (body: string, name: string) => DECL(name).exec(body)?.[3] ?? null;
const backgroundOf = (body: string) => parseColor(declared(body, "background-color") ?? declared(body, "background") ?? "");

/** The theme's own background and text color (the rules for `.cw-code` itself). */
export function themeBase(css: string): { background: Rgba; color: Rgba } {
	const rules = parseRules(css).filter((r) => r.selectors.includes(".cw-code"));
	let background: Rgba | null = null;
	let color: Rgba | null = null;
	for (const r of rules) {
		background = backgroundOf(r.body) ?? background;
		color = parseColor(declared(r.body, "color") ?? "") ?? color;
	}
	const bg = background ?? [255, 255, 255, 1];
	return { background: bg, color: color ?? (luminance(bg) < 0.18 ? [255, 255, 255, 1] : [0, 0, 0, 1]) };
}

/** Every text color a theme's rules set, each with the background it's read on. */
export function themeTextColors(css: string): Array<{ selector: string; color: Rgba; background: Rgba }> {
	const base = themeBase(css);
	const out: Array<{ selector: string; color: Rgba; background: Rgba }> = [];
	for (const r of parseRules(css)) {
		const own = backgroundOf(r.body);
		const background = own ? over(own, base.background) : base.background;
		const color = parseColor(declared(r.body, "color") ?? "");
		if (color) out.push({ selector: r.selectors.join(","), color: over(color, background), background });
		else if (own) out.push({ selector: r.selectors.join(","), color: base.color, background });
	}
	return out;
}

/** Opacity line numbers had (now a color per theme, --cw-line). */
export const LINE_OPACITY = 0.5;
/** Opacity the language label had (now a color per theme, --cw-label). */
export const LABEL_OPACITY = 0.75;

/**
 * `color` at `opacity` over `background`, as an opaque hex: exactly what the
 * opacity looked like when that already reaches 4.5:1, else the nearest
 * lightness that does (readableOn).
 */
export function fadedColor(color: Rgba, background: Rgba, opacity: number): string {
	return toHex(readableOn([color[0], color[1], color[2], color[3] * opacity], background));
}

/**
 * A muted text color for a theme (line numbers by default): its text color at
 * `opacity` over its background, as before, raised to 4.5:1 only where that's
 * too faint.
 */
export function mutedColor(css: string, opacity = LINE_OPACITY): string {
	const { color, background } = themeBase(css);
	return fadedColor(color, background, opacity);
}

/** The theme CSS with every text color under 4.5:1 replaced by a readable one of the same hue. */
export function readableThemeCss(css: string): string {
	const base = themeBase(css);
	return css.replace(RULE, (whole, selectors: string, body: string) => {
		const own = backgroundOf(body);
		const background = own ? over(own, base.background) : base.background;
		const value = declared(body, "color");
		const color = value ? parseColor(value) : own ? base.color : null;
		if (!color || contrastRatio(over(color, background), background) >= MIN_CONTRAST) return whole;
		const hex = toHex(readableOn(color, background));
		return value ? `${selectors}{${body.replace(DECL("color"), `$1$2${hex}`)}}` : `${selectors}{${body};color:${hex}}`;
	});
}
