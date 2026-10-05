/**
 * Caching for live results and the title index: the search content version,
 * cache keys, and a small per-isolate memory cache. The pure parts (no
 * imports) are unit tested in Node.
 *
 * The content version is a plugin setting ("searchVersion") that the search
 * module's content hooks change whenever published content changes. It's in
 * every cache key and in the page's live results config, so publishing,
 * updating or deleting an entry makes old cached answers unreachable rather
 * than needing a purge (they expire on their own).
 */

/** Bump when the shape of cached responses changes, so old copies are never served. */
export const CACHE_FORMAT = "1";

/** 32-bit FNV-1a, base 36: a short, stable fingerprint (not for security). */
export function fingerprint(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** A new content version: time-ordered and unique enough across isolates. */
export function newContentVersion(now = Date.now(), random = Math.random()): string {
	return `${now.toString(36)}${Math.floor(random * 36 ** 4)
		.toString(36)
		.padStart(4, "0")}`;
}

/**
 * The version pages and cache keys use: the stored content version plus a
 * fingerprint of the configuration that shapes answers (URL patterns, the
 * cache format), so a deploy that changes them doesn't serve old copies.
 */
export function effectiveVersion(stored: string | null | undefined, configFingerprint: string): string {
	const base = typeof stored === "string" && /^[a-z0-9]{1,32}$/.test(stored) ? stored : "0";
	return `${base}.${fingerprint(`${CACHE_FORMAT}|${configFingerprint}`)}`;
}

const OPERATORS = /\b(AND|OR|NOT|NEAR)\b/;

/**
 * The query as cached and searched: trimmed, inner whitespace collapsed, and
 * lower-cased (FTS5 and the highlighting are case-insensitive), except when
 * it has upper-case FTS5 operators, which only work in upper case.
 */
export function normalizeLiveQuery(query: string): string {
	const q = query.replace(/\s+/g, " ").trim();
	return OPERATORS.test(q) ? q : q.toLowerCase();
}

const COLLECTION = /^[a-z][a-z0-9_]*$/;

/** Requested collections as a stable list: valid slugs, de-duplicated, sorted, at most 10. Undefined means all. */
export function normalizeCollections(list: string | null | undefined): string[] | undefined {
	if (!list) return undefined;
	return [...new Set(list.split(",").map((c) => c.trim()))]
		.filter((c) => COLLECTION.test(c))
		.slice(0, 10)
		.sort();
}

const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/;

/** A locale code, lower-cased (matching is case-insensitive), or undefined when missing or malformed. */
export function normalizeLocale(locale: string | null | undefined): string | undefined {
	const l = locale?.trim();
	return l && LOCALE.test(l) ? l.toLowerCase() : undefined;
}

/** Cache API key for a live answer. A synthetic URL on the site's own origin, so it can't collide with a real page. */
export function liveCacheKey(origin: string, parts: { version: string; query: string; limit: number; collections?: string[]; locale?: string }): string {
	const params = new URLSearchParams({ v: parts.version, q: parts.query, limit: String(parts.limit) });
	if (parts.collections) params.set("collections", parts.collections.join(","));
	if (parts.locale) params.set("locale", parts.locale);
	return `${origin}/_coywolf-cache/search/live?${params}`;
}

/** Cache API key for a title index. */
export function indexCacheKey(origin: string, parts: { version: string; collections?: string[]; locale?: string }): string {
	const params = new URLSearchParams({ v: parts.version });
	if (parts.collections) params.set("collections", parts.collections.join(","));
	if (parts.locale) params.set("locale", parts.locale);
	return `${origin}/_coywolf-cache/search/index?${params}`;
}

/** A small least-recently-used map, per isolate. */
export class Lru<V> {
	private readonly map = new Map<string, V>();
	private readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	get(key: string): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	set(key: string, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
	}

	get size(): number {
		return this.map.size;
	}
}
