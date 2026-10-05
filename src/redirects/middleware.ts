/**
 * Serves Coywolf redirects (through the pack middleware in src/middleware.ts).
 * Rules are read from D1 at most once a minute per Worker isolate; hits are
 * counted after the response is sent.
 */
import { type CompiledRules, compile, listRules, match, recordHit } from "./rules.js";

export interface CoywolfRedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Seconds to cache rules per isolate. Default 60. */
	cacheSeconds?: number;
}

let cache: { compiled: CompiledRules; loadedAt: number } | null = null;

/** Drop the in-memory rules so the next request reloads them (called after admin edits). */
export function invalidateRedirectCache(): void {
	cache = null;
}

const SKIP = /^\/(_emdash|_astro|_image)\//;

/** Answer a request from the redirect rules, or return undefined to pass it on. */
export async function serveRedirect(
	url: URL,
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
	options: CoywolfRedirectsOptions = {},
): Promise<Response | undefined> {
	const ttl = (options.cacheSeconds ?? 60) * 1000;
	const { pathname, search } = url;
	if (SKIP.test(pathname)) return undefined;
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db) return undefined;

	if (!cache || Date.now() - cache.loadedAt > ttl) {
		try {
			cache = { compiled: compile(await listRules(db)), loadedAt: Date.now() };
		} catch (error) {
			console.error("coywolf redirects: could not load rules", error);
			return undefined;
		}
	}

	const found = match(cache.compiled, pathname, search);
	if (!found) return undefined;

	waitUntil(recordHit(db, found.rule.id).catch(() => undefined));

	// Browsers may keep a redirect for an hour, but an edge cache in front of the
	// Worker (Workers Cache) must not, or hits would stop being counted. "private"
	// is what makes shared caches skip it (Cloudflare-CDN-Cache-Control: no-store
	// didn't stop Workers Cache from storing redirects).
	const caching = { "Cache-Control": "private, max-age=3600" };
	if (found.rule.type === 410) return new Response("Gone", { status: 410, headers: caching });
	let location = found.location;
	if (location.startsWith("/")) {
		// match() already collapses leading slashes from capture groups; this is a
		// second check that a site-relative destination never resolves off-site.
		const resolved = new URL(location, url);
		if (resolved.origin !== url.origin) return undefined;
		location = resolved.href;
	}
	return new Response(null, { status: found.rule.type, headers: { Location: location, ...caching } });
}
