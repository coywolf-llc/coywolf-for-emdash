/**
 * Feature switches. Every Coywolf Pack feature can be turned off on the
 * Features admin page; the choices are one plugin setting ("features", an
 * object of id → boolean). Hooks and routes read it through the plugin
 * context; middleware and Astro block renderers, which run outside it, read
 * the same option row from D1 with a short per-isolate cache.
 */
import type { FeatureDef } from "./module.js";
import { workerEnv } from "../shared.js";

export const PLUGIN_ID = "coywolf-pack";
export const FEATURES_SETTING = "features";
const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${FEATURES_SETTING}`;

export type FeatureMap = Record<string, boolean>;

/** Every feature the pack knows about. Modules register theirs at import time. */
const catalog = new Map<string, FeatureDef>();

export function registerFeatures(defs: FeatureDef[]): void {
	for (const def of defs) catalog.set(def.id, def);
}

export function featureCatalog(): FeatureDef[] {
	return [...catalog.values()];
}

const parentOf = (id: string) => (id.includes(".") ? id.slice(0, id.indexOf(".")) : null);

/**
 * The stored choice of a feature's legacy ids (FeatureDef.replaces): the
 * first one present in the map wins. A legacy sub-feature ("a.b") counted
 * only while its parent was on, so its parent's state (stored, else the
 * parent's default) is applied too. Undefined when none is stored.
 */
export function legacyChoice(stored: FeatureMap | null | undefined, def: FeatureDef): boolean | undefined {
	if (!stored || !def.replaces) return undefined;
	for (const legacy of def.replaces) {
		if (typeof stored[legacy] !== "boolean") continue;
		const parent = parentOf(legacy);
		// A parent that's no longer in the catalog (and wasn't stored) doesn't hold the choice back.
		const parentOn = !parent || (stored[parent] ?? (catalog.has(parent) ? (catalog.get(parent)?.default ?? false) : true));
		return stored[legacy] && parentOn;
	}
	return undefined;
}

/**
 * Stored choices over catalog defaults. A feature with no stored choice
 * takes its legacy ids' choice (FeatureDef.replaces), then its default. A
 * sub-feature ("a.b") is on only when its parent ("a") is on too.
 */
export function resolveFeatures(stored: FeatureMap | null | undefined): FeatureMap {
	const out: FeatureMap = {};
	for (const def of catalog.values()) out[def.id] = stored?.[def.id] ?? legacyChoice(stored, def) ?? def.default ?? false;
	for (const id of Object.keys(out)) {
		const parent = parentOf(id);
		if (parent && parent in out && !out[parent]) out[id] = false;
	}
	return out;
}

export function isOn(features: FeatureMap, id: string): boolean {
	return features[id] ?? false;
}

// ── Plugin context (hooks, routes) ───────────────────────────────

interface SettingsCtx {
	settings: { get<T>(key: string): Promise<T | null | undefined> };
}

export async function ctxFeatures(ctx: SettingsCtx): Promise<FeatureMap> {
	return remember(resolveFeatures(await ctx.settings.get<FeatureMap>(FEATURES_SETTING)));
}

/** The switches most recently read in this isolate (null before the first read). */
let lastKnown: FeatureMap | null = null;
function remember(features: FeatureMap): FeatureMap {
	lastKnown = features;
	return features;
}

/**
 * Synchronous view of the switches, for EmDash's admin manifest (sidebar
 * pages and dashboard widgets), which reads the plugin's page list on every
 * admin request. The pack middleware reads the switches before EmDash's
 * routes run, so this is current; before any read it returns null.
 */
export function knownFeatures(): FeatureMap | null {
	return lastKnown;
}

/**
 * Like ctxFeatures, but shares the per-isolate cache with siteFeatures so
 * hooks that run on every page view (page:metadata, page:fragments) don't
 * add a settings read to each render.
 */
export async function cachedCtxFeatures(ctx: SettingsCtx): Promise<FeatureMap> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.features;
	const started = generation;
	const features = await ctxFeatures(ctx);
	// Same guard as queryOptions: a save in this isolate while this read ran (invalidateFeatures) makes it stale.
	if (generation === started) cached = { features, at: Date.now() };
	return features;
}

/** For public routes: like requireFeature, but from the per-isolate cache (no settings read on most requests). */
export async function requireCachedFeature(ctx: SettingsCtx, id: string): Promise<void> {
	if (!isOn(await cachedCtxFeatures(ctx), id)) {
		const { PluginRouteError } = await import("emdash");
		throw PluginRouteError.notFound("This feature is turned off (Plugins → Coywolf Pack).");
	}
}

// ── Outside the plugin context (middleware, Astro components) ────

const TTL_MS = 30_000;
/**
 * `settings` is set when the read came from D1 (siteFeatures), which also
 * reads the registered settings; `keys` are the settings that read asked for.
 */
let cached: { features: FeatureMap; at: number; settings?: Map<string, unknown>; keys?: Set<string> } | null = null;
/** A D1 read in progress: concurrent cache misses in this isolate share it. */
let reading: Promise<SiteOptions> | null = null;
/** Bumped by invalidateFeatures, so a read that started before a save isn't cached. */
let generation = 0;

/**
 * Other plugin settings read in the same query as the switches, sharing
 * their per-isolate cache, so middleware, page hooks and Astro renderers that
 * need them on every request add no query (e.g. the search content version,
 * the code block theme, the review style).
 */
const siteSettingKeys = new Set<string>();
export function registerSiteSetting(key: string): void {
	siteSettingKeys.add(key);
}

const settingOption = (key: string) => `plugin:${PLUGIN_ID}:settings:${key}`;

/** Forget cached switches and registered settings (call after saving them). */
export function invalidateFeatures(): void {
	cached = null;
	reading = null;
	generation++;
}

/** Read the switches straight from D1. Fails closed (all off) if the database can't be read. */
export async function siteFeatures(database = "DB"): Promise<FeatureMap> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.features;
	return (await readSiteOptions(database)).features;
}

/** A D1 binding name, or the binding itself (for callers that already have it). */
type Database = string | D1Database;

interface SiteOptions {
	features: FeatureMap;
	settings: Map<string, unknown>;
	/** The registered settings this read asked for. */
	keys: Set<string>;
	/** False when D1 couldn't be read (features are then all off and settings empty). */
	ok: boolean;
}

function readSiteOptions(database: Database): Promise<SiteOptions> {
	if (!reading) {
		const read = queryOptions(database).finally(() => {
			if (reading === read) reading = null;
		});
		reading = read;
	}
	return reading;
}

async function queryOptions(database: Database): Promise<SiteOptions> {
	let stored: FeatureMap | null = null;
	const settings = new Map<string, unknown>();
	const keys = new Set(siteSettingKeys);
	const started = generation;
	try {
		const db = typeof database === "string" ? ((await workerEnv())[database] as D1Database | undefined) : database;
		const names = [OPTION_NAME, ...[...keys].map(settingOption)];
		const rows = db
			? (
					await db
						.prepare(`SELECT name, value FROM options WHERE name IN (${names.map(() => "?").join(",")})`)
						.bind(...names)
						.all<{ name: string; value: string }>()
				).results
			: [];
		for (const row of rows) {
			if (!row.value) continue;
			if (row.name === OPTION_NAME) stored = JSON.parse(row.value) as FeatureMap;
			else {
				try {
					settings.set(row.name.slice(settingOption("").length), JSON.parse(row.value));
				} catch {
					// An unreadable setting reads as unset.
				}
			}
		}
	} catch (error) {
		console.error("coywolf-pack: could not read feature switches", error);
		return { features: resolveFeatures({}), settings, keys, ok: false };
	}
	const features = remember(resolveFeatures(stored));
	// A save in this isolate while the query ran (invalidateFeatures) makes this read stale: don't cache it.
	if (generation === started) cached = { features, at: Date.now(), settings, keys };
	return { features, settings, keys, ok: true };
}

/**
 * The registered settings from the per-isolate cache, or a fresh read when
 * the cache is old or was read before `key` was registered (a module imported
 * after the first read of this isolate). Null when D1 can't be read.
 */
async function siteSettings(key: string, database: Database): Promise<Map<string, unknown> | null> {
	registerSiteSetting(key);
	if (cached?.settings && cached.keys?.has(key) && Date.now() - cached.at < TTL_MS) return cached.settings;
	let read = await readSiteOptions(database);
	// A read that was already in flight may have been started before `key` was registered.
	if (read.ok && !read.keys.has(key)) read = await readSiteOptions(database);
	return read.ok ? read.settings : null;
}

/** A setting registered with registerSiteSetting, from the switches' per-isolate cache (null when unset). */
export async function siteSetting<T>(key: string, database = "DB"): Promise<T | null> {
	return (((await siteSettings(key, database))?.get(key) as T | undefined) ?? null);
}

/**
 * Like siteSetting, but tells an unset setting (`{ value: null }`) from one
 * that couldn't be read (null), for callers that keep their last value or
 * skip caching a default when D1 is unavailable.
 */
export async function readSiteSetting<T = unknown>(key: string, database: Database = "DB"): Promise<{ value: T | null } | null> {
	const settings = await siteSettings(key, database);
	return settings ? { value: (settings.get(key) as T | undefined) ?? null } : null;
}

/** Update a registered setting in this isolate's cache after writing it (other isolates see it within 30 seconds). */
export function rememberSiteSetting(key: string, value: unknown): void {
	cached?.settings?.set(key, value);
}

export async function siteFeatureOn(id: string, database?: string): Promise<boolean> {
	return isOn(await siteFeatures(database), id);
}

/** For routes: answer 404 when the feature is off, so a disabled module looks absent. */
export async function requireFeature(ctx: SettingsCtx, id: string): Promise<void> {
	if (!isOn(await ctxFeatures(ctx), id)) {
		const { PluginRouteError } = await import("emdash");
		throw PluginRouteError.notFound("This feature is turned off (Plugins → Coywolf Pack).");
	}
}
