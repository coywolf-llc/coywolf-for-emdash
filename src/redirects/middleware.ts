/**
 * Serves Coywolf redirects (through the pack middleware in src/middleware.ts).
 * Each Worker isolate keeps the enabled rules in memory: exact sources in a
 * map (one lookup per request), patterns compiled in source order. They're
 * read again after a redirect edit (in this isolate at once; in others when
 * they see the new settings generation, see src/core/generation.ts), or
 * after `cacheSeconds`. Reading them never writes: the table is created by
 * the first admin write. Hits are counted after the response is sent.
 */
import { isCurrent, settingsEpoch } from "../core/features.js";
import { type CompiledRules, compile, loadMatchRules, match, recordHit } from "./rules.js";

export interface CoywolfRedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Longest time to keep rules per isolate, in seconds. Default 600 (edits reload them sooner). */
	cacheSeconds?: number;
}

let cache: { compiled: CompiledRules; at: number; epoch: number } | null = null;
/** A load in progress: concurrent requests of a cold isolate share it. */
let loading: Promise<CompiledRules> | null = null;

/** Drop the in-memory rules so the next request reloads them (called after admin edits). */
export function invalidateRedirectCache(): void {
	cache = null;
	loading = null;
}

async function rules(db: D1Database, ttl: number): Promise<CompiledRules> {
	if (cache && isCurrent(cache, ttl)) return cache.compiled;
	if (!loading) {
		const epoch = settingsEpoch();
		const load = loadMatchRules(db)
			.then((list) => {
				const compiled = compile(list);
				if (loading === load && epoch === settingsEpoch()) cache = { compiled, at: Date.now(), epoch };
				return compiled;
			})
			.finally(() => {
				if (loading === load) loading = null;
			});
		loading = load;
	}
	return loading;
}

/**
 * Start loading the rules if this isolate doesn't have them, without waiting:
 * the pack middleware calls it before reading the feature switches, so on a
 * cold isolate both reads go to D1 in one batch. Errors surface (logged) when
 * a request needs the rules.
 */
export function prefetchRedirects(env: Record<string, unknown>, options: CoywolfRedirectsOptions = {}): void {
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db || (cache && isCurrent(cache, (options.cacheSeconds ?? 600) * 1000))) return;
	rules(db, (options.cacheSeconds ?? 600) * 1000).catch(() => undefined);
}

const SKIP = /^\/(_emdash|_astro|_image)\//;

/** Answer a request from the redirect rules, or return undefined to pass it on. */
export async function serveRedirect(
	url: URL,
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
	options: CoywolfRedirectsOptions = {},
): Promise<Response | undefined> {
	const ttl = (options.cacheSeconds ?? 600) * 1000;
	const { pathname, search } = url;
	if (SKIP.test(pathname)) return undefined;
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db) return undefined;

	let compiled: CompiledRules;
	try {
		compiled = await rules(db, ttl);
	} catch (error) {
		console.error("coywolf redirects: could not load rules", error);
		return undefined;
	}

	const found = match(compiled, pathname, search);
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
