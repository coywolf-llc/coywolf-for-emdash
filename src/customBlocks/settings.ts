/**
 * Custom Blocks settings (the affiliate disclosure wording and the podcast
 * links), read outside the plugin context (Astro renderer) from D1 in the
 * feature switches' query, sharing their per-isolate cache.
 *
 * The disclosure wording keeps the storage key it had when the module was
 * called Content Blocks ("contentBlocks"), so saved wording carries over.
 */
import { invalidateFeatures, readSiteSetting, registerSiteSetting } from "../core/features.js";
import { DEFAULT_DISCLOSURE, DEFAULT_PODCAST, type DisclosureSettings, type PodcastSettings, normalizeDisclosureSettings, normalizePodcastSettings } from "./render.js";

/** Disclosure wording. Unchanged since 0.11.0 (Content Blocks): don't rename. */
export const SETTINGS_KEY = "contentBlocks";
/** Podcast links (0.12.0). */
export const PODCAST_SETTINGS_KEY = "customBlocksPodcast";

registerSiteSetting(SETTINGS_KEY);
registerSiteSetting(PODCAST_SETTINGS_KEY);

/** Per key: the last stored value and its normalized settings, so a cache hit doesn't normalize again. */
const memo = new Map<string, { raw: unknown; value: unknown }>();

export function invalidateCustomBlockSettings(): void {
	invalidateFeatures();
}

async function readSetting<T>(key: string, normalize: (raw: unknown) => T, fallback: T, database: string): Promise<T> {
	const read = await readSiteSetting(key, database);
	if (!read) {
		console.error("coywolf-pack: could not read the custom block settings");
		return fallback;
	}
	const hit = memo.get(key);
	if (hit && hit.raw === read.value) return hit.value as T;
	const value = normalize(read.value);
	memo.set(key, { raw: read.value, value });
	return value;
}

export function siteDisclosureSettings(database = "DB"): Promise<DisclosureSettings> {
	return readSetting(SETTINGS_KEY, normalizeDisclosureSettings, DEFAULT_DISCLOSURE, database);
}

export function sitePodcastSettings(database = "DB"): Promise<PodcastSettings> {
	return readSetting(PODCAST_SETTINGS_KEY, normalizePodcastSettings, DEFAULT_PODCAST, database);
}
