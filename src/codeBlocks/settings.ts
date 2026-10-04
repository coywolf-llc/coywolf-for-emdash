/**
 * The active theme, read outside the plugin context (Astro block renderer)
 * straight from D1, with a short per-isolate cache like the feature switches.
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { DEFAULT_THEME, THEME_SETTING, isTheme } from "./themes.js";

const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${THEME_SETTING}`;
const TTL_MS = 30_000;
let cached: { theme: string; at: number } | null = null;

export function invalidateTheme(): void {
	cached = null;
}

export async function siteTheme(database = "DB"): Promise<string> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.theme;
	let theme = DEFAULT_THEME;
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(OPTION_NAME).first<{ value: string }>() : null;
		const stored = row?.value ? JSON.parse(row.value) : null;
		if (isTheme(stored)) theme = stored;
	} catch (error) {
		console.error("coywolf-pack: could not read code block theme", error);
		return theme;
	}
	cached = { theme, at: Date.now() };
	return theme;
}
