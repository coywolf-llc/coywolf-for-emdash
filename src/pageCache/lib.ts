/**
 * Page cache: keeps Cloudflare's Workers Cache (the edge HTML cache in front of
 * the Worker, turned on by Astro's cacheCloudflare() provider) in step with the
 * site. EmDash already purges the pages it tagged when content, menus or site
 * settings change. This covers what EmDash can't know about: a new deploy (theme
 * or code changes) and Coywolf Pack settings, which change page output (schema,
 * blocks, reviews, videos…).
 *
 * Purging runs inside the Worker with cache.purge() from cloudflare:workers, so
 * it needs no API token. Outside Workers Cache it does nothing.
 */

/** Option row holding the Worker version whose pages are in the cache. */
export const VERSION_OPTION = "plugin:coywolf-pack:pageCache:version";

/**
 * Pack routes anyone can call (search, discovery files, video player actions).
 * Everything else under the pack's API is an admin action, so a successful POST
 * there purges the cache. The Stream webhook isn't listed: it changes video
 * details that pages show.
 */
const PUBLIC_ROUTE = /^\/_emdash\/api\/plugins\/coywolf-pack\/(search\/|discovery\/public\/|videos\/(like|play|caption|embed|sitemap)(\/|$))/;
const PACK_API = "/_emdash/api/plugins/coywolf-pack/";

/** True when a request is a pack admin write whose success should purge the cache. */
export function purgesAfter(method: string, pathname: string): boolean {
	return method === "POST" && pathname.startsWith(PACK_API) && !PUBLIC_ROUTE.test(pathname);
}

/** Purge every cached page. Returns false when there's no Workers Cache to purge. */
export async function purgePageCache(): Promise<boolean> {
	try {
		const workers = (await import("cloudflare:workers")) as unknown as { cache?: { purge(options: { purgeEverything: true }): Promise<unknown> } };
		if (!workers.cache?.purge) return false;
		await workers.cache.purge({ purgeEverything: true });
		return true;
	} catch (error) {
		console.error("coywolf-pack: page cache purge failed", error);
		return false;
	}
}

/** The deployed Worker version (CF_VERSION_METADATA binding), if bound. */
export function versionId(env: Record<string, unknown>): string | undefined {
	const metadata = env.CF_VERSION_METADATA as { id?: unknown } | undefined;
	return typeof metadata?.id === "string" && metadata.id ? metadata.id : undefined;
}

/**
 * Purge once per deploy: the first isolate of a new version that sees a request
 * compares its version with the stored one, purges, and records it. Other
 * isolates of the same version find it recorded. Racing isolates may both purge,
 * which is harmless.
 */
export async function purgeIfNewVersion(db: D1Database, id: string): Promise<boolean> {
	const row = await db.prepare("SELECT value FROM options WHERE name = ?").bind(VERSION_OPTION).first<{ value: string }>();
	if (row && JSON.parse(row.value) === id) return false;
	if (!(await purgePageCache())) return false;
	await db
		.prepare("INSERT INTO options (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
		.bind(VERSION_OPTION, JSON.stringify(id))
		.run();
	return true;
}

/** Astro's per-request cache controls (route caching), as far as the pack uses them. */
interface RouteCache {
	enabled?: boolean;
	options?: { maxAge?: number };
	set(options: { maxAge?: number; swr?: number }): void;
}

/**
 * Apply the Page cache lifetimes to a request whose route the site made
 * cacheable (a routeRules entry gave it a maxAge). Other routes are left alone,
 * so this never turns caching on for anything the site didn't.
 */
export function applyPageLifetime(cache: RouteCache | undefined, maxAgeDays: number, refreshDays: number): boolean {
	if (!cache?.enabled || cache.options?.maxAge === undefined) return false;
	cache.set({ maxAge: Math.round(maxAgeDays * 86400), swr: Math.round(refreshDays * 86400) });
	return true;
}
