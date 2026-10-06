/**
 * Serves Coywolf redirects (through the pack middleware in src/middleware.ts).
 * Each request reads its exact rule, if any, from D1: one row through the
 * (source, is_regex) index. Pattern rules (few) are kept in memory per
 * Worker isolate, compiled in source order, and read again after a redirect
 * edit (in this isolate at once; in others when they see the new settings
 * generation, see src/core/generation.ts), or after `cacheSeconds`. Reading
 * never writes: the table is created by the first admin write. Hits are
 * counted after the response is sent.
 */
import { isCurrent, settingsEpoch } from "../core/features.js";
import { type CompiledRules, compile, findExactRule, loadPatternRules, match, recordHit } from "./rules.js";

export interface CoywolfRedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Longest time to keep pattern rules per isolate, in seconds. Default 600 (edits reload them sooner). */
	cacheSeconds?: number;
}

type Patterns = CompiledRules["patterns"];

let cache: { patterns: Patterns; at: number; epoch: number } | null = null;
/** A load in progress: concurrent requests of a cold isolate share it. */
let loading: Promise<Patterns> | null = null;

/** Drop the in-memory pattern rules so the next request reloads them (called after admin edits). */
export function invalidateRedirectCache(): void {
	cache = null;
	loading = null;
}

function patterns(db: D1Database, ttl: number): Promise<Patterns> {
	if (cache && isCurrent(cache, ttl)) return Promise.resolve(cache.patterns);
	if (!loading) {
		const epoch = settingsEpoch();
		const load = loadPatternRules(db)
			.then((list) => {
				const compiled = compile(list).patterns;
				if (loading === load && epoch === settingsEpoch()) cache = { patterns: compiled, at: Date.now(), epoch };
				return compiled;
			})
			.finally(() => {
				if (loading === load) loading = null;
			});
		loading = load;
	}
	return loading;
}

/** The rules that can match a request (its exact rule and the patterns), read once per request URL. */
const lookups = new WeakMap<URL, Promise<CompiledRules>>();

function rulesFor(url: URL, db: D1Database, ttl: number): Promise<CompiledRules> {
	let found = lookups.get(url);
	if (!found) {
		// Issued in the same tick, so both reads go to D1 in one batch.
		found = Promise.all([findExactRule(db, url.pathname), patterns(db, ttl)]).then(([exact, list]) => ({
			exact: new Map(exact ? [[exact.source, exact]] : []),
			patterns: list,
		}));
		lookups.set(url, found);
	}
	return found;
}

const SKIP = /^\/(_emdash|_astro|_image)\//;
const ttlOf = (options: CoywolfRedirectsOptions) => (options.cacheSeconds ?? 600) * 1000;

/**
 * Start this request's lookup without waiting: the pack middleware calls it
 * before reading the feature switches, so when those aren't cached all the
 * reads go to D1 in one batch. Errors surface (logged) in serveRedirect.
 */
export function prefetchRedirects(url: URL, env: Record<string, unknown>, options: CoywolfRedirectsOptions = {}): void {
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db || SKIP.test(url.pathname)) return;
	rulesFor(url, db, ttlOf(options)).catch(() => undefined);
}

/** Answer a request from the redirect rules, or return undefined to pass it on. */
export async function serveRedirect(
	url: URL,
	env: Record<string, unknown>,
	waitUntil: (p: Promise<unknown>) => void,
	options: CoywolfRedirectsOptions = {},
): Promise<Response | undefined> {
	const { pathname, search } = url;
	if (SKIP.test(pathname)) return undefined;
	const db = env[options.database ?? "DB"] as D1Database | undefined;
	if (!db) return undefined;

	let compiled: CompiledRules;
	try {
		compiled = await rulesFor(url, db, ttlOf(options));
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
