/**
 * Headings & TOC site defaults: one plugin setting ("headings"). Hooks and
 * routes read it through the plugin context; Astro components read the same
 * option row from D1 with a short per-isolate cache (like feature switches).
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { validPrefix } from "./slug.js";

export const SETTINGS_KEY = "headings";
const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${SETTINGS_KEY}`;

export const SEPARATORS = {
	slash: "/",
	chevron: "›",
	guillemet: "»",
	bullet: "•",
	arrow: "→",
	gt: ">",
} as const;
export type SeparatorPreset = keyof typeof SEPARATORS;

export type TocListStyle = "none" | "bulleted" | "numbered";
export type TocDisplay = "open" | "collapsible" | "collapsed";

export interface HeadingsSettings {
	/** Prefix for generated heading ids ("jump-"). */
	prefix: string;
	/** Show a "copy link to section" link on hover/focus. */
	copyLink: boolean;
	/** scroll-margin-top for anchored headings, so a sticky header doesn't cover them. 0 = none. */
	scrollOffset: number;
	scrollUnit: "px" | "rem";
	toc: {
		title: string;
		/** Show the title above the list. A collapsible table always shows it (it's the toggle). */
		showTitle: boolean;
		levels: number[];
		listStyle: TocListStyle;
		display: TocDisplay;
		/** Hide the table when it would list fewer headings than this. */
		minHeadings: number;
		/** Smooth scrolling on TOC pages (always off for visitors who prefer reduced motion). */
		smoothScroll: boolean;
	};
	breadcrumbs: {
		separator: SeparatorPreset;
		/** Overrides the preset when not empty (max 8 characters). */
		customSeparator: string;
		homeLabel: string;
		showHome: boolean;
		showCurrent: boolean;
	};
}

export const DEFAULT_SETTINGS: HeadingsSettings = {
	prefix: "jump-",
	copyLink: false,
	scrollOffset: 0,
	scrollUnit: "px",
	toc: { title: "Table of contents", showTitle: true, levels: [2, 3], listStyle: "none", display: "open", minHeadings: 2, smoothScroll: true },
	breadcrumbs: { separator: "slash", customSeparator: "", homeLabel: "Home", showHome: true, showCurrent: true },
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	allowed.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const int = (value: unknown, min: number, max: number, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const text = (value: unknown, max: number, fallback: string) =>
	typeof value === "string" ? value.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) : fallback;

/** Heading levels from block or setting input (numbers or "2"/"h2" strings), sorted, 2–6. */
export function parseLevels(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	const levels = value
		.map((v) => (typeof v === "number" ? v : Number(String(v).replace(/^h/i, ""))))
		.filter((n) => Number.isInteger(n) && n >= 2 && n <= 6);
	return [...new Set(levels)].sort((a, b) => a - b);
}

/** Fill in and clamp stored settings. Never throws. */
export function normalizeSettings(raw: unknown): HeadingsSettings {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const toc = (r.toc && typeof r.toc === "object" ? r.toc : {}) as Record<string, unknown>;
	const bc = (r.breadcrumbs && typeof r.breadcrumbs === "object" ? r.breadcrumbs : {}) as Record<string, unknown>;
	const d = DEFAULT_SETTINGS;
	const levels = parseLevels(toc.levels);
	return {
		prefix: validPrefix(r.prefix) ? r.prefix : d.prefix,
		copyLink: bool(r.copyLink, d.copyLink),
		scrollOffset: int(r.scrollOffset, 0, 500, d.scrollOffset),
		scrollUnit: pick(r.scrollUnit, ["px", "rem"], d.scrollUnit),
		toc: {
			title: text(toc.title, 100, d.toc.title) || d.toc.title,
			showTitle: bool(toc.showTitle, d.toc.showTitle),
			levels: levels.length ? levels : d.toc.levels,
			listStyle: pick(toc.listStyle, ["none", "bulleted", "numbered"], d.toc.listStyle),
			display: pick(toc.display, ["open", "collapsible", "collapsed"], d.toc.display),
			minHeadings: int(toc.minHeadings, 1, 10, d.toc.minHeadings),
			smoothScroll: bool(toc.smoothScroll, d.toc.smoothScroll),
		},
		breadcrumbs: {
			separator: pick(bc.separator, Object.keys(SEPARATORS) as SeparatorPreset[], d.breadcrumbs.separator),
			customSeparator: [...text(bc.customSeparator, 32, "")].slice(0, 8).join(""),
			homeLabel: text(bc.homeLabel, 60, d.breadcrumbs.homeLabel) || d.breadcrumbs.homeLabel,
			showHome: bool(bc.showHome, d.breadcrumbs.showHome),
			showCurrent: bool(bc.showCurrent, d.breadcrumbs.showCurrent),
		},
	};
}

// ── Outside the plugin context (Astro components) ────────────────

const TTL_MS = 30_000;
let cached: { settings: HeadingsSettings; at: number } | null = null;

export function invalidateHeadingsSettings(): void {
	cached = null;
}

/** Read the settings straight from D1. Falls back to defaults if the database can't be read. */
export async function siteHeadingsSettings(database = "DB"): Promise<HeadingsSettings> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.settings;
	let stored: unknown = null;
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(OPTION_NAME).first<{ value: string }>() : null;
		stored = row?.value ? JSON.parse(row.value) : null;
	} catch (error) {
		console.error("coywolf-pack: could not read heading settings", error);
		return DEFAULT_SETTINGS;
	}
	const settings = normalizeSettings(stored);
	cached = { settings, at: Date.now() };
	return settings;
}
