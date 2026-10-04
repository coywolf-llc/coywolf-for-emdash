/**
 * Content Blocks settings (the affiliate disclosure wording), read outside the
 * plugin context (Astro renderer) straight from D1, with a short per-isolate
 * cache like the feature switches.
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { DEFAULT_DISCLOSURE, type DisclosureSettings, normalizeDisclosureSettings } from "./render.js";

export const SETTINGS_KEY = "contentBlocks";
const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${SETTINGS_KEY}`;
const TTL_MS = 30_000;
let cached: { settings: DisclosureSettings; at: number } | null = null;

export function invalidateContentBlockSettings(): void {
	cached = null;
}

export async function siteDisclosureSettings(database = "DB"): Promise<DisclosureSettings> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.settings;
	let settings: DisclosureSettings = DEFAULT_DISCLOSURE;
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(OPTION_NAME).first<{ value: string }>() : null;
		settings = normalizeDisclosureSettings(row?.value ? JSON.parse(row.value) : null);
	} catch (error) {
		console.error("coywolf-pack: could not read the content block settings", error);
		return settings;
	}
	cached = { settings, at: Date.now() };
	return settings;
}
