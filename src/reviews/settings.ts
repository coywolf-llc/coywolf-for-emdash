/**
 * The review box style (accent color + custom CSS), read outside the plugin
 * context (Astro renderer) from D1 in the feature switches' query, sharing
 * their per-isolate cache.
 */
import { invalidateFeatures, readSiteSetting, registerSiteSetting } from "../core/features.js";
import { type ReviewStyle, STYLE_SETTING, normalizeStyle } from "./lib.js";

registerSiteSetting(STYLE_SETTING);

/** The last stored value and its normalized style, so a cache hit doesn't normalize again. */
let memo: { raw: unknown; style: ReviewStyle } | null = null;

export function invalidateReviewStyle(): void {
	invalidateFeatures();
}

export async function siteReviewStyle(database = "DB"): Promise<ReviewStyle> {
	const read = await readSiteSetting(STYLE_SETTING, database);
	if (!read) console.error("coywolf-pack: could not read the review style");
	const raw = read?.value ?? null;
	if (memo && memo.raw === raw) return memo.style;
	const style = normalizeStyle(raw);
	memo = { raw, style };
	return style;
}
