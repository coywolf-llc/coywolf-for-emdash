/**
 * Breadcrumb Nav site defaults: one plugin setting ("breadcrumbs"). Before
 * 0.6.0 they lived inside the Headings & TOC setting ("headings", under
 * `breadcrumbs`), so reads fall back to that sub-object until the Breadcrumb
 * Nav page saves its own. Hooks and routes read through the plugin context;
 * Astro components read the option rows from D1 with a short per-isolate
 * cache (like feature switches).
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";

export const SETTINGS_KEY = "breadcrumbs";
/** The setting that held these values before Breadcrumb Nav was its own module. */
export const LEGACY_SETTINGS_KEY = "headings";
const optionName = (key: string) => `plugin:${PLUGIN_ID}:settings:${key}`;

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

const TTL_MS = 30_000;
let cached: { settings: BreadcrumbsSettings; at: number } | null = null;

export function invalidateBreadcrumbsSettings(): void {
	cached = null;
}

/** Read the settings straight from D1 (one query for both rows). Falls back to defaults if the database can't be read. */
export async function siteBreadcrumbsSettings(database = "DB"): Promise<BreadcrumbsSettings> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.settings;
	const rows: Record<string, unknown> = {};
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const result = db
			? await db
					.prepare("SELECT name, value FROM options WHERE name IN (?, ?)")
					.bind(optionName(SETTINGS_KEY), optionName(LEGACY_SETTINGS_KEY))
					.all<{ name: string; value: string }>()
			: null;
		for (const row of result?.results ?? []) rows[row.name] = row.value ? JSON.parse(row.value) : null;
	} catch (error) {
		console.error("coywolf-pack: could not read breadcrumb settings", error);
		return DEFAULT_SETTINGS;
	}
	const settings = resolveSettings(rows[optionName(SETTINGS_KEY)], rows[optionName(LEGACY_SETTINGS_KEY)]);
	cached = { settings, at: Date.now() };
	return settings;
}
