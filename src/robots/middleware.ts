/**
 * Serves /robots.txt from the saved rules (through the pack middleware), so
 * turning the feature off falls straight back to EmDash's own robots.txt.
 * Until rules are first saved, requests pass through to EmDash too.
 */
import { PLUGIN_ID } from "../core/features.js";
import { type RobotsConfig, generate, normalizeConfig } from "./rules.js";

export const CONFIG_SETTING = "robots.config";
const CONFIG_OPTION = `plugin:${PLUGIN_ID}:settings:${CONFIG_SETTING}`;
const TTL_MS = 60_000;

let cache: { config: RobotsConfig | null; siteUrl: string | null; at: number } | null = null;

/** Drop the cached rules so the next request reloads them (called after saving). */
export function invalidateRobotsCache(): void {
	cache = null;
}

async function readOption<T>(db: D1Database, name: string): Promise<T | null> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(name).first<{ value: string }>();
	return row?.value ? (JSON.parse(row.value) as T) : null;
}

/** Site origin the way EmDash's robots.txt computes it: the Site URL setting, else the request origin. */
export function siteOrigin(settingUrl: string | null | undefined, requestUrl: URL): string {
	return (settingUrl?.trim() || requestUrl.origin).replace(/\/+$/, "");
}

export async function serveRobots(url: URL, method: string, env: Record<string, unknown>, database = "DB"): Promise<Response | undefined> {
	if (url.pathname !== "/robots.txt" || (method !== "GET" && method !== "HEAD")) return undefined;
	const db = env[database] as D1Database | undefined;
	if (!db) return undefined;

	if (!cache || Date.now() - cache.at > TTL_MS) {
		try {
			const [stored, siteUrl] = await Promise.all([
				readOption<Partial<RobotsConfig>>(db, CONFIG_OPTION),
				readOption<string>(db, "site:url").catch(() => null),
			]);
			cache = { config: stored ? normalizeConfig(stored) : null, siteUrl: typeof siteUrl === "string" ? siteUrl : null, at: Date.now() };
		} catch (error) {
			console.error("coywolf robots: could not load rules", error);
			return undefined;
		}
	}
	if (!cache.config) return undefined;

	const body = generate(cache.config, { siteUrl: siteOrigin(cache.siteUrl, url) });
	return new Response(method === "HEAD" ? null : body, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Robots-Tag": "noindex",
		},
	});
}
