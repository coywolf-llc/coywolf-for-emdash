/**
 * Custom Blocks settings (the affiliate disclosure wording and the podcast
 * links), read outside the plugin context (Astro renderer) straight from D1,
 * with a short per-isolate cache like the feature switches.
 *
 * The disclosure wording keeps the storage key it had when the module was
 * called Content Blocks ("contentBlocks"), so saved wording carries over.
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { DEFAULT_DISCLOSURE, DEFAULT_PODCAST, type DisclosureSettings, type PodcastSettings, normalizeDisclosureSettings, normalizePodcastSettings } from "./render.js";

/** Disclosure wording. Unchanged since 0.11.0 (Content Blocks): don't rename. */
export const SETTINGS_KEY = "contentBlocks";
/** Podcast links (0.12.0). */
export const PODCAST_SETTINGS_KEY = "customBlocksPodcast";

const optionName = (key: string) => `plugin:${PLUGIN_ID}:settings:${key}`;
const TTL_MS = 30_000;

interface Cached<T> {
	value: T;
	at: number;
}
const cache = new Map<string, Cached<unknown>>();

export function invalidateCustomBlockSettings(): void {
	cache.clear();
}

async function readSetting<T>(key: string, normalize: (raw: unknown) => T, fallback: T, database: string): Promise<T> {
	const hit = cache.get(key) as Cached<T> | undefined;
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
	let value = fallback;
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(optionName(key)).first<{ value: string }>() : null;
		value = normalize(row?.value ? JSON.parse(row.value) : null);
	} catch (error) {
		console.error("coywolf-pack: could not read the custom block settings", error);
		return value;
	}
	cache.set(key, { value, at: Date.now() });
	return value;
}

export function siteDisclosureSettings(database = "DB"): Promise<DisclosureSettings> {
	return readSetting(SETTINGS_KEY, normalizeDisclosureSettings, DEFAULT_DISCLOSURE, database);
}

export function sitePodcastSettings(database = "DB"): Promise<PodcastSettings> {
	return readSetting(PODCAST_SETTINGS_KEY, normalizePodcastSettings, DEFAULT_PODCAST, database);
}
