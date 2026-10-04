/**
 * The review box style (accent color + custom CSS), read outside the plugin
 * context (Astro renderer) straight from D1, with a short per-isolate cache
 * like the feature switches.
 */
import { PLUGIN_ID } from "../core/features.js";
import { workerEnv } from "../shared.js";
import { DEFAULT_ACCENT, type ReviewStyle, STYLE_SETTING, normalizeStyle } from "./lib.js";

const OPTION_NAME = `plugin:${PLUGIN_ID}:settings:${STYLE_SETTING}`;
const TTL_MS = 30_000;
let cached: { style: ReviewStyle; at: number } | null = null;

export function invalidateReviewStyle(): void {
	cached = null;
}

export async function siteReviewStyle(database = "DB"): Promise<ReviewStyle> {
	if (cached && Date.now() - cached.at < TTL_MS) return cached.style;
	let style: ReviewStyle = { accent: DEFAULT_ACCENT, css: "" };
	try {
		const env = await workerEnv();
		const db = env[database] as D1Database | undefined;
		const row = db ? await db.prepare("SELECT value FROM options WHERE name = ?").bind(OPTION_NAME).first<{ value: string }>() : null;
		style = normalizeStyle(row?.value ? JSON.parse(row.value) : null);
	} catch (error) {
		console.error("coywolf-pack: could not read the review style", error);
		return style;
	}
	cached = { style, at: Date.now() };
	return style;
}
