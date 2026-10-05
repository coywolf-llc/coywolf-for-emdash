/**
 * The active theme, read outside the plugin context (Astro block renderer)
 * from D1 in the feature switches' query, sharing their per-isolate cache.
 */
import { invalidateFeatures, readSiteSetting, registerSiteSetting } from "../core/features.js";
import { DEFAULT_THEME, THEME_SETTING, isTheme } from "./themes.js";

registerSiteSetting(THEME_SETTING);

export function invalidateTheme(): void {
	invalidateFeatures();
}

export async function siteTheme(database = "DB"): Promise<string> {
	const read = await readSiteSetting(THEME_SETTING, database);
	if (!read) console.error("coywolf-pack: could not read code block theme");
	return read && isTheme(read.value) ? read.value : DEFAULT_THEME;
}
