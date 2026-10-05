/**
 * Breadcrumb Nav site defaults: one plugin setting ("breadcrumbs"). Before
 * 0.6.0 they lived inside the Headings & TOC setting ("headings", under
 * `breadcrumbs`), so reads fall back to that sub-object until the Breadcrumb
 * Nav page saves its own. Hooks and routes read through the plugin context;
 * Astro components read the option rows from D1 in the feature switches'
 * query and per-isolate cache.
 */
import { invalidateFeatures, readSiteSetting, registerSiteSetting } from "../core/features.js";

export const SETTINGS_KEY = "breadcrumbs";
/** The setting that held these values before Breadcrumb Nav was its own module. */
export const LEGACY_SETTINGS_KEY = "headings";

export const SEPARATORS = {
	slash: "/",
	chevron: "›",
	guillemet: "»",
	bullet: "•",
	arrow: "→",
	gt: ">",
} as const;
export type SeparatorPreset = keyof typeof SEPARATORS;

export interface BreadcrumbsSettings {
	separator: SeparatorPreset;
	/** Overrides the preset when not empty (max 8 characters). */
	customSeparator: string;
	homeLabel: string;
	showHome: boolean;
	showCurrent: boolean;
}

export const DEFAULT_SETTINGS: BreadcrumbsSettings = {
	separator: "slash",
	customSeparator: "",
	homeLabel: "Home",
	showHome: true,
	showCurrent: true,
};

const asObject = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const text = (value: unknown, max: number, fallback: string) =>
	typeof value === "string" ? value.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max) : fallback;

/** Fill in and clamp stored settings. Never throws. */
export function normalizeSettings(raw: unknown): BreadcrumbsSettings {
	const r = asObject(raw) ?? {};
	const d = DEFAULT_SETTINGS;
	return {
		separator: Object.hasOwn(SEPARATORS, r.separator as string) ? (r.separator as SeparatorPreset) : d.separator,
		customSeparator: [...text(r.customSeparator, 32, "")].slice(0, 8).join(""),
		homeLabel: text(r.homeLabel, 60, d.homeLabel) || d.homeLabel,
		showHome: bool(r.showHome, d.showHome),
		showCurrent: bool(r.showCurrent, d.showCurrent),
	};
}

/**
 * The effective settings from the stored "breadcrumbs" setting, else the
 * `breadcrumbs` sub-object of the legacy "headings" setting, else defaults.
 */
export function resolveSettings(stored: unknown, legacyHeadings: unknown): BreadcrumbsSettings {
	return normalizeSettings(asObject(stored) ?? asObject(asObject(legacyHeadings)?.breadcrumbs));
}

interface SettingsCtx {
	settings: { get<T>(key: string): Promise<T | null | undefined> };
}

/** Settings inside the plugin context (hooks, routes). */
export async function ctxBreadcrumbsSettings(ctx: SettingsCtx): Promise<BreadcrumbsSettings> {
	const stored = await ctx.settings.get<unknown>(SETTINGS_KEY);
	if (asObject(stored)) return normalizeSettings(stored);
	return resolveSettings(null, await ctx.settings.get<unknown>(LEGACY_SETTINGS_KEY));
}

// ── Outside the plugin context (Astro components) ────────────────

registerSiteSetting(SETTINGS_KEY);
registerSiteSetting(LEGACY_SETTINGS_KEY);

/** The last stored values and their resolved settings, so a cache hit doesn't resolve again. */
let memo: { stored: unknown; legacy: unknown; settings: BreadcrumbsSettings } | null = null;

export function invalidateBreadcrumbsSettings(): void {
	invalidateFeatures();
}

/** The settings from D1 (both rows, in the feature switches' query and cache). Falls back to defaults if the database can't be read. */
export async function siteBreadcrumbsSettings(database = "DB"): Promise<BreadcrumbsSettings> {
	const [stored, legacy] = await Promise.all([readSiteSetting(SETTINGS_KEY, database), readSiteSetting(LEGACY_SETTINGS_KEY, database)]);
	if (!stored || !legacy) {
		console.error("coywolf-pack: could not read breadcrumb settings");
		return DEFAULT_SETTINGS;
	}
	if (memo && memo.stored === stored.value && memo.legacy === legacy.value) return memo.settings;
	const settings = resolveSettings(stored.value, legacy.value);
	memo = { stored: stored.value, legacy: legacy.value, settings };
	return settings;
}
