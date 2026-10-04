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

/** Stored choices over catalog defaults. A sub-feature ("a.b") is on only when its parent ("a") is on too. */
export function resolveFeatures(stored: FeatureMap | null | undefined): FeatureMap {
	const out: FeatureMap = {};
	for (const def of catalog.values()) out[def.id] = stored?.[def.id] ?? def.default ?? false;
	for (const id of Object.keys(out)) {
		const parent = id.includes(".") ? id.slice(0, id.indexOf(".")) : null;
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
	const features = await ctxFeatures(ctx);
	cached = { features, at: Date.now() };
	return features;
}

// ── Outside the plugin context (middleware, Astro components) ────

const TTL_MS = 30_000;
let cached: { features: FeatureMap; at: number } | null = null;

/** Forget cached switches (call after saving them). */
export function invalidateFeatures(): void {
	cached = null;
}

/** Read the switches straight from D1. Fails closed (all off) if the database can't be read. */
export async function siteFeatures(database = "DB"): Promise<FeatureMap> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.features;
	let stored: FeatureMap | null = null;
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(OPTION_NAME).first<{ value: string }>() : null;
		stored = row?.value ? (JSON.parse(row.value) as FeatureMap) : null;
	} catch (error) {
		console.error("coywolf-pack: could not read feature switches", error);
		return resolveFeatures({});
	}
	const features = remember(resolveFeatures(stored));
	cached = { features, at: Date.now() };
	return features;
}

export async function siteFeatureOn(id: string, database?: string): Promise<boolean> {
	return isOn(await siteFeatures(database), id);
}

/** For routes: answer 404 when the feature is off, so a disabled module looks absent. */
export async function requireFeature(ctx: SettingsCtx, id: string): Promise<void> {
	if (!isOn(await ctxFeatures(ctx), id)) {
		const { PluginRouteError } = await import("emdash");
		throw PluginRouteError.notFound("This feature is turned off (Coywolf Pack → Features).");
	}
}
