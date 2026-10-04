/**
 * Serves /robots.txt from the saved rules (through the pack middleware), so
 * turning the feature off falls straight back to EmDash's own robots.txt
 * (the saved rules stay for next time).
 *
 * Turning the feature on takes over seamlessly: if nothing is saved yet, the
 * first request (or the first admin page load, whichever comes first) turns
 * the robots.txt EmDash was serving into equivalent rules and saves them
 * with an insert-if-absent, so concurrent first requests can't import twice.
 */
import { PLUGIN_ID } from "../core/features.js";
import { emdashRobots, importRobots } from "./importer.js";
import { type RobotsConfig, generate, normalizeConfig } from "./rules.js";

export const CONFIG_SETTING = "robots.config";
export const CONFIG_OPTION = `plugin:${PLUGIN_ID}:settings:${CONFIG_SETTING}`;
const TTL_MS = 60_000;

let cache: { config: RobotsConfig | null; siteUrl: string | null; at: number } | null = null;
let importing: Promise<RobotsConfig | null> | null = null;

/** Drop the cached rules so the next request reloads them (called after saving). */
export function invalidateRobotsCache(): void {
	cache = null;
}

async function readOption<T>(db: D1Database, name: string): Promise<T | null> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(name).first<{ value: string }>();
	return row?.value ? (JSON.parse(row.value) as T) : null;
}

/** EmDash's custom robots.txt (SEO settings), or null when it serves its default. */
export async function readEmdashCustomRobots(db: D1Database): Promise<string | null> {
	try {
		const seo = await readOption<{ robotsTxt?: string }>(db, "site:seo");
		return seo?.robotsTxt?.trim() ? seo.robotsTxt : null;
	} catch {
		return null;
	}
}

/** Site origin the way EmDash's robots.txt computes it: the Site URL setting, else the request origin. */
export function siteOrigin(settingUrl: string | null | undefined, requestUrl: URL): string {
	return (settingUrl?.trim() || requestUrl.origin).replace(/\/+$/, "");
}

/** Insert the config only if no row exists yet; returns whatever is stored afterwards. */
async function insertIfAbsent(db: D1Database, config: RobotsConfig): Promise<RobotsConfig> {
	const value = JSON.stringify(config);
	try {
		await db.prepare("INSERT INTO options (name, value, revision) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING").bind(CONFIG_OPTION, value, crypto.randomUUID()).run();
	} catch {
		// Databases from before EmDash's revision column.
		await db.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING").bind(CONFIG_OPTION, value).run();
	}
	const stored = await readOption<Partial<RobotsConfig>>(db, CONFIG_OPTION);
	return stored ? normalizeConfig(stored) : config;
}

/** Import EmDash's robots.txt once (per isolate, and atomically in D1). */
async function importOnce(db: D1Database, siteUrl: string): Promise<RobotsConfig | null> {
	if (!importing) {
		importing = (async () => {
			const custom = await readEmdashCustomRobots(db);
			const { config } = importRobots(emdashRobots(custom, siteUrl), siteUrl);
			try {
				return await insertIfAbsent(db, config);
			} catch (error) {
				console.error("coywolf robots: could not save the imported rules", error);
				return config;
			}
		})().finally(() => {
			importing = null;
		});
	}
	return importing;
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
			const site = typeof siteUrl === "string" ? siteUrl : null;
			const config = stored ? normalizeConfig(stored) : await importOnce(db, siteOrigin(site, url));
			cache = { config, siteUrl: site, at: Date.now() };
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
