/**
 * The Coywolf Video figure's site-wide look, shared by the block
 * (src/astro/videos/CoywolfVideo.astro) and the live preview on the Videos
 * settings tab, so the preview is what the site prints: the display settings
 * (with their defaults and validation), the CSS, the custom properties a
 * changed setting adds, the like icons, and the caption and
 * like/views/date markup. Pure (imports only lib.ts and date.ts), so
 * `node --test` can load it.
 */
import { type DateStyle, videoDateText } from "./date.js";
import { SHOW_DEFAULTS, type ShowDefaults, isHex } from "./lib.js";

export type LikeIcon = "heart" | "thumbs" | "star";
export type VideoScheme = "auto" | "light" | "dark" | "off";
export type VideoAlign = "left" | "center" | "right";
export const FONT_WEIGHTS = ["100", "200", "300", "400", "500", "600", "700", "800", "900"] as const;

/** Videos → Settings: Views & likes and Appearance (one stored object, videosDisplay). */
export interface VideoDisplay extends ShowDefaults {
	dateStyle: DateStyle;
	likeIcon: LikeIcon;
	/** auto: follow the visitor's light/dark setting; light/dark: always; off: inherit the theme's text color. */
	scheme: VideoScheme;
	/** The name and description. */
	align: VideoAlign;
	/** The like, views and date row. */
	metaAlign: VideoAlign;
	/** Player corner radius in px. */
	radius: number;
	border: boolean;
	borderWidth: number;
	borderColor: string;
	/** Hex colors; "" keeps the default. */
	titleColor: string;
	/** Name and description size, em. */
	titleSize: number;
	/** "" keeps the default (bold name, normal description). */
	titleWeight: string;
	descWeight: string;
	likeColor: string;
	likeBg: string;
	likeActiveColor: string;
	likeActiveBg: string;
	metaColor: string;
	/** Views and date size, em. */
	metaSize: number;
}

/** The defaults are the block's look before these settings existed, so saving them changes nothing. */
export const DISPLAY_DEFAULTS: VideoDisplay = {
	...SHOW_DEFAULTS,
	dateStyle: "absolute",
	likeIcon: "heart",
	scheme: "auto",
	align: "left",
	metaAlign: "left",
	radius: 8,
	border: false,
	borderWidth: 1,
	borderColor: "#eeeeee",
	titleColor: "",
	titleSize: 0.95,
	titleWeight: "",
	descWeight: "",
	likeColor: "",
	likeBg: "",
	likeActiveColor: "",
	likeActiveBg: "",
	metaColor: "",
	metaSize: 0.875,
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const hex = (value: unknown) => (isHex(value) ? value : "");
const range = (value: unknown, min: number, max: number, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value * 1000) / 1000)) : fallback;

/** A stored (or submitted) display object, with anything missing or invalid at its default. */
export function normalizeDisplay(raw: unknown): VideoDisplay {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const d = DISPLAY_DEFAULTS;
	const align = ["left", "center", "right"] as const;
	return {
		showName: flag(r.showName, d.showName),
		showDescription: flag(r.showDescription, d.showDescription),
		showPlays: flag(r.showPlays, d.showPlays),
		showLikes: flag(r.showLikes, d.showLikes),
		showLikeCount: flag(r.showLikeCount, d.showLikeCount),
		showDate: flag(r.showDate, d.showDate),
		followSiteDefaults: flag(r.followSiteDefaults, d.followSiteDefaults),
		dateStyle: pick(r.dateStyle, ["absolute", "relative"] as const, d.dateStyle),
		likeIcon: pick(r.likeIcon, ["heart", "thumbs", "star"] as const, d.likeIcon),
		scheme: pick(r.scheme, ["auto", "light", "dark", "off"] as const, d.scheme),
		align: pick(r.align, align, d.align),
		metaAlign: pick(r.metaAlign, align, d.metaAlign),
		radius: Math.round(range(r.radius, 0, 48, d.radius)),
		border: flag(r.border, d.border),
		borderWidth: Math.round(range(r.borderWidth, 0, 20, d.borderWidth)),
		borderColor: hex(r.borderColor) || d.borderColor,
		titleColor: hex(r.titleColor),
		titleSize: range(r.titleSize, 0.5, 4, d.titleSize),
		titleWeight: pick(r.titleWeight, ["", ...FONT_WEIGHTS], ""),
		descWeight: pick(r.descWeight, ["", ...FONT_WEIGHTS], ""),
		likeColor: hex(r.likeColor),
		likeBg: hex(r.likeBg),
		likeActiveColor: hex(r.likeActiveColor),
		likeActiveBg: hex(r.likeActiveBg),
		metaColor: hex(r.metaColor),
		metaSize: range(r.metaSize, 0.5, 4, d.metaSize),
	};
}

/**
 * The site's display settings with one block's own look applied: alignment,
 * corner radius and border. Anything empty or invalid keeps the site's value
 * (values are checked strictly, since they become CSS).
 */
export function blockDisplay(d: VideoDisplay, block: Record<string, unknown> | null | undefined): VideoDisplay {
	if (!block) return d;
	const out = { ...d };
	const align = ["left", "center", "right"] as const;
	if (align.includes(block.contentAlign as VideoAlign)) out.align = block.contentAlign as VideoAlign;
	if (align.includes(block.metaAlign as VideoAlign)) out.metaAlign = block.metaAlign as VideoAlign;
	const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null);
	const radius = int(block.radius, 0, 48);
	if (radius !== null) out.radius = radius;
	const border = block.showBorder;
	if (border === "show" || border === true) out.border = true;
	else if (border === "hide" || border === false) out.border = false;
	const width = int(block.borderWidth, 0, 20);
	if (width !== null) out.borderWidth = width;
	if (isHex(block.borderColor)) out.borderColor = block.borderColor;
	return out;
}

const JUSTIFY: Record<VideoAlign, string> = { left: "flex-start", center: "center", right: "flex-end" };

/**
 * Custom properties for the settings that differ from the defaults (nothing
 * for a site that hasn't changed them, so its pages look as they did and
 * theme CSS keeps working). `background` is the Player background color.
 */
export function displayVars(d: VideoDisplay, background?: string | null): string[] {
	const D = DISPLAY_DEFAULTS;
	const vars: string[] = [];
	const add = (name: string, value: string) => vars.push(`--cw-video-${name}:${value}`);
	if (isHex(background)) add("bg", background);
	if (d.radius !== D.radius) add("radius", `${d.radius}px`);
	if (d.border) add("border", `${d.borderWidth}px solid ${hex(d.borderColor) || D.borderColor}`);
	if (d.titleColor) add("title-color", d.titleColor);
	if (d.titleSize !== D.titleSize) add("title-size", `${d.titleSize}em`);
	if (d.titleWeight) add("title-weight", d.titleWeight);
	if (d.descWeight) add("desc-weight", d.descWeight);
	if (d.align !== D.align) add("align", d.align);
	if (d.metaAlign !== D.metaAlign) add("meta-justify", JUSTIFY[d.metaAlign]);
	if (d.metaColor) add("muted", d.metaColor);
	if (d.metaSize !== D.metaSize) add("meta-size", `${d.metaSize}em`);
	if (d.likeColor) add("like-color", d.likeColor);
	if (d.likeBg) add("like-bg", d.likeBg);
	if (d.likeActiveColor) add("like-active", d.likeActiveColor);
	if (d.likeActiveBg) add("like-active-bg", d.likeActiveBg);
	return vars;
}

/** The figure's color-scheme class ("" for auto, the default). */
export const schemeClass = (scheme: VideoScheme) => (scheme === "auto" ? "" : `cw-video--${scheme}`);

// ── Markup ───────────────────────────────────────────────────────

export const escapeHtml = (text: string) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Video Manager's like icons (Lucide), outlined; filled when liked. */
export const LIKE_ICON_PATHS: Record<LikeIcon, string[]> = {
	heart: ["M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"],
	thumbs: ["M7 10v12", "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"],
	star: [
		"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
	],
};

export function likeIconSvg(icon: LikeIcon): string {
	const paths = (LIKE_ICON_PATHS[icon] ?? LIKE_ICON_PATHS.heart).map((d) => `<path d="${d}" />`).join("");
	return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const number = new Intl.NumberFormat("en-US");
export const viewsText = (plays: number) => (plays > 0 ? `${number.format(plays)} ${plays === 1 ? "view" : "views"}` : "");

/** The name and description under the video ("" when neither shows). */
export function captionHtml(name: string, description: string, show: { name: boolean; description: boolean }): string {
	const named = show.name && name !== "Video";
	const described = show.description && Boolean(description);
	if (!named && !described) return "";
	const parts: string[] = [];
	if (show.name) parts.push(`<strong class="cw-video__name">${escapeHtml(name)}</strong>`);
	if (show.name && described) parts.push(" — ");
	if (described) parts.push(`<span class="cw-video__desc">${escapeHtml(description)}</span>`);
	return `<figcaption class="cw-video__caption">${parts.join("")}</figcaption>`;
}

export interface MetaRow {
	uid: string;
	/** null: no like button. */
	likes: number | null;
	showLikeCount: boolean;
	likeIcon: LikeIcon;
	/** Render the button as liked (the settings preview; on the site the script sets it). */
	liked?: boolean;
	/** null: no views. */
	plays: number | null;
	/** The upload date (ISO), or null for none. */
	date: string | null;
	dateStyle: DateStyle;
	now?: number;
}

/** The like, views and date row ("" when there's nothing to show). */
export function metaHtml(m: MetaRow): string {
	const parts: string[] = [];
	if (m.likes !== null) {
		const count = m.showLikeCount ? `<span class="cw-video__likes" data-cw-likes>${m.likes > 0 ? number.format(m.likes) : ""}</span>` : "";
		parts.push(
			`<button type="button" class="cw-video__like" data-cw-like="${escapeHtml(m.uid)}" aria-pressed="${m.liked ? "true" : "false"}">${likeIconSvg(m.likeIcon)}<span class="cw-video__sr">Like this video</span>${count}</button>`,
		);
	}
	if (m.plays !== null) parts.push(`<span class="cw-video__plays" data-cw-plays>${viewsText(m.plays)}</span>`);
	const dateText = videoDateText(m.date, m.dateStyle, m.now);
	if (dateText) {
		const relative = m.dateStyle === "relative" ? " data-cw-relative" : "";
		parts.push(`<time class="cw-video__date" datetime="${escapeHtml(m.date as string)}"${relative}>${escapeHtml(dateText)}</time>`);
	}
	if (!parts.length) return "";
	return `<div class="cw-video__meta">${parts.join("")}</div>`;
}

// ── CSS ──────────────────────────────────────────────────────────

/**
 * Printed once per page. Settings arrive as custom properties on the figure
 * (displayVars); a property that isn't set falls back to the look the block
 * always had (and declarations without a fallback inherit, as before).
 */
export const VIDEO_CSS = `
.cw-video{--cw-video-bg:transparent;--cw-video-muted:#57606a;--cw-video-accent:#d1242f;margin-inline:auto;margin-block:1.5em}
@media (prefers-color-scheme:dark){.cw-video:not(.cw-video--light):not(.cw-video--off){--cw-video-muted:#9198a1;--cw-video-accent:#ff7b72}}
.cw-video.cw-video--dark{--cw-video-muted:#9198a1;--cw-video-accent:#ff7b72}
.cw-video.cw-video--off{--cw-video-muted:currentColor;--cw-video-accent:currentColor}
.cw-video .cw-video__frame{position:relative;aspect-ratio:var(--cw-video-ratio,16 / 9);background-color:var(--cw-video-bg);border:var(--cw-video-border,0);border-radius:var(--cw-video-radius,0.5rem);overflow:hidden}
.cw-video .cw-video__frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.cw-video .cw-video__poster{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.cw-video .cw-video__play{position:absolute;inset:50% auto auto 50%;translate:-50% -50%;display:grid;place-items:center;width:4rem;height:4rem;padding:0;padding-left:0.2rem;border:0;border-radius:50%;background:rgb(0 0 0 / 0.65);color:#fff;cursor:pointer;transition:background 0.15s}
.cw-video .cw-video__play:hover{background:var(--cw-video-accent)}
.cw-video .cw-video__play:focus-visible{outline:3px solid #fff;outline-offset:2px}
.cw-video .cw-video__play[hidden]{display:none}
.cw-video .cw-video__toggle{position:absolute;inset:auto auto 0.5rem 0.5rem;z-index:1;display:grid;place-items:center;width:2.75rem;height:2.75rem;padding:0;border:0;border-radius:50%;background:rgb(0 0 0 / 0.65);color:#fff;cursor:pointer;transition:background 0.15s}
.cw-video .cw-video__toggle:hover{background:var(--cw-video-accent)}
.cw-video .cw-video__toggle:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #000}
.cw-video .cw-video__toggle[data-paused] .cw-video__pause,.cw-video .cw-video__toggle:not([data-paused]) .cw-video__resume{display:none}
.cw-video.cw-video--gif .cw-video__frame{border-radius:var(--cw-video-radius,0)}
.cw-video .cw-video__caption{margin-top:0.5em;font-size:var(--cw-video-title-size,0.95em);color:var(--cw-video-title-color);text-align:var(--cw-video-align)}
.cw-video .cw-video__name{font-weight:var(--cw-video-title-weight,bolder)}
.cw-video .cw-video__desc{font-weight:var(--cw-video-desc-weight)}
.cw-video .cw-video__meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:var(--cw-video-meta-justify);gap:0.75em;margin-top:0.5em;font-size:var(--cw-video-meta-size,0.875em);color:var(--cw-video-muted)}
.cw-video .cw-video__plays:empty,.cw-video .cw-video__likes:empty{display:none}
.cw-video .cw-video__like{display:inline-flex;align-items:center;gap:0.35em;min-height:2rem;padding:0.25em 0.75em;border:1px solid currentColor;border-radius:999px;background:var(--cw-video-like-bg,transparent);color:var(--cw-video-like-color);font:inherit;cursor:pointer;transition:color 0.15s,background-color 0.15s}
.cw-video .cw-video__like svg{transition:fill 0.15s}
.cw-video .cw-video__like[aria-pressed="true"]{color:var(--cw-video-like-active,var(--cw-video-accent));background:var(--cw-video-like-active-bg,var(--cw-video-like-bg,transparent))}
.cw-video .cw-video__like[aria-pressed="true"] svg{fill:currentColor}
@media (hover:hover){
.cw-video .cw-video__like:not([data-held]):hover{color:var(--cw-video-like-color);background:var(--cw-video-like-bg,transparent)}
.cw-video .cw-video__like:not([data-held]):hover svg{fill:currentColor}
}
.cw-video .cw-video__like[data-pop] svg{animation:cw-video-pop 0.35s ease}
@keyframes cw-video-pop{0%{transform:scale(1)}40%{transform:scale(1.35) rotate(-8deg)}100%{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.cw-video .cw-video__like[data-pop] svg{animation:none}.cw-video .cw-video__like,.cw-video .cw-video__like svg{transition:none}}
.cw-video .cw-video__like:focus-visible{outline:2px solid var(--cw-video-accent);outline-offset:2px}
.cw-video .cw-video__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`.trim();

// ── Settings preview ─────────────────────────────────────────────

/** The preview's own frame: a checkerboard when the background is transparent, and a stage for the light/dark schemes. */
export const VIDEO_PREVIEW_CSS = `
.cw-video-stage{padding:4px 0}
.cw-video-stage--light{background:#fff;color:#1f2328;margin:-16px;padding:16px}
.cw-video-stage--dark{background:#0f0f0f;color:#f0f6fc;margin:-16px;padding:16px}
.cw-video-stage .cw-video{margin-block:0}
.cw-video .cw-video__frame--checker{background-image:conic-gradient(#e5e5e5 90deg,#fafafa 90deg 180deg,#e5e5e5 180deg 270deg,#fafafa 270deg);background-size:16px 16px}
.cw-video .cw-video__frame span.cw-video__play{cursor:default}
.cw-video-stage__label{margin:1.25em 0 0;font-size:0.75em;opacity:0.7}
`.trim();

const SAMPLE_UID = "0".repeat(32);
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>';

/**
 * A sample video with every part the settings can show: the frame (16:9),
 * name and description, like button (175), "23 views", an upload date seven
 * months back, . The preview frame runs no scripts, so a
 * second like button shows the clicked state; hover works as on the site.
 */
export function renderVideoPreviewHtml(d: VideoDisplay, background: string | null = null, now = Date.now()): string {
	const vars = displayVars(d, background);
	const cls = ["cw-video", schemeClass(d.scheme)].filter(Boolean).join(" ");
	const style = ["--cw-video-ratio:16 / 9", ...vars].join(";");
	const checker = isHex(background) ? "" : " cw-video__frame--checker";
	const date = new Date(now - 213 * 86_400_000).toISOString();
	const row = (liked: boolean) =>
		metaHtml({
			uid: SAMPLE_UID,
			likes: d.showLikes ? 175 : null,
			showLikeCount: d.showLikeCount,
			likeIcon: d.likeIcon,
			liked,
			plays: d.showPlays && !liked ? 23 : null,
			date: d.showDate && !liked ? date : null,
			dateStyle: d.dateStyle,
			now,
		});
	const figure = `<figure class="${cls}" style="${escapeHtml(style)}"><div class="cw-video__frame${checker}"><span class="cw-video__play" aria-hidden="true">${PLAY_ICON}</span></div>${captionHtml(
		"Your video name",
		"A short video description.",
		{ name: d.showName, description: d.showDescription },
	)}${row(false)}</figure>`;
	const liked = d.showLikes
		? `<p class="cw-video-stage__label">After clicking like:</p><div class="${cls}" style="${escapeHtml(vars.join(";"))}">${row(true)}</div>`
		: "";
	const stage = d.scheme === "light" || d.scheme === "dark" ? ` cw-video-stage--${d.scheme}` : "";
	return `<div class="cw-video-stage${stage}">${figure}${liked}</div>`;
}

/** Re-exported for the Astro component and the admin page. */
export type { DateStyle } from "./date.js";
export type { ShowDefaults } from "./lib.js";
