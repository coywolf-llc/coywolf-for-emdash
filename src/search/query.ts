/**
 * EmDash search with an OR fallback, plus resolved public URLs and type
 * labels for each result. Used by the pack's public search route (and so by
 * the SearchBox typeahead), and exported for site search pages:
 *
 * ```astro
 * ---
 * import { searchWithFallback } from "@coywolf/emdash/astro";
 * const q = Astro.url.searchParams.get("q") ?? "";
 * const { items, fallback } = q ? await searchWithFallback(q) : { items: [], fallback: false };
 * ---
 * ```
 */
import { type SearchResult, search } from "emdash";

import { COLLECTION_SLUG, interpolateUrlPattern, patternUsesDate, readCollections } from "../core/content-url.js";
import { workerEnv } from "../shared.js";
import { buildOrQuery, rankByCoverage } from "./fallback.js";

export interface PackSearchResult extends SearchResult {
	/** Public path of the entry, from the collection's URL pattern. */
	url: string;
	/** The collection's (singular) label, e.g. "Post". */
	type: string;
}

export interface PackSearchResponse {
	items: PackSearchResult[];
	nextCursor?: string;
	/** True when nothing matched every word, so these results match any word. */
	fallback: boolean;
}

export interface PackSearchOptions {
	collections?: string[];
	locale?: string;
	/** Default 10. */
	limit?: number;
	cursor?: string;
	/** "suggest" matches titles first (typeahead), then full text. Default "search". */
	mode?: "search" | "suggest";
	/** D1 binding of the site database, for URL patterns. Default "DB". */
	database?: string;
}

/** How many OR results to rank in one go (the fallback isn't paginated). */
const FALLBACK_POOL = 50;

export async function searchWithFallback(query: string, options: PackSearchOptions = {}): Promise<PackSearchResponse> {
	const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
	const base = {
		collections: options.collections?.filter((c) => COLLECTION_SLUG.test(c)),
		locale: options.locale,
	};

	if (options.mode === "suggest" && !options.cursor) {
		const titles = await search(query, { ...base, limit, scope: "title" });
		if (titles.items.length) return { items: await withUrls(titles.items, options.database), fallback: false };
	}

	const all = await search(query, { ...base, limit, cursor: options.cursor });
	if (all.items.length || options.cursor) {
		return { items: await withUrls(all.items, options.database), nextCursor: all.nextCursor, fallback: false };
	}

	const orQuery = buildOrQuery(query);
	if (!orQuery) return { items: [], fallback: false };
	const any = await search(orQuery, { ...base, limit: FALLBACK_POOL });
	const ranked = rankByCoverage(any.items, query).slice(0, limit);
	return { items: await withUrls(ranked, options.database), fallback: ranked.length > 0 };
}

async function withUrls(items: SearchResult[], database = "DB"): Promise<PackSearchResult[]> {
	if (!items.length) return [];
	const slugs = [...new Set(items.map((i) => i.collection))];
	let db: D1Database | undefined;
	try {
		db = (await workerEnv())[database] as D1Database | undefined;
	} catch {
		db = undefined;
	}
	const collections = db ? await readCollections(db, slugs).catch(() => new Map()) : new Map();

	// Publish dates, only for collections whose URL pattern has date tokens.
	const dates = new Map<string, string | null>();
	if (db) {
		for (const slug of slugs) {
			const info = collections.get(slug);
			if (!info || !patternUsesDate(info.urlPattern) || !COLLECTION_SLUG.test(slug)) continue;
			const ids = items.filter((i) => i.collection === slug).map((i) => i.id);
			try {
				const { results } = await db
					.prepare(`SELECT id, published_at FROM "ec_${slug}" WHERE id IN (${ids.map(() => "?").join(",")})`)
					.bind(...ids)
					.all<{ id: string; published_at: string | null }>();
				for (const r of results) dates.set(`${slug}:${r.id}`, r.published_at);
			} catch {
				// Leave date tokens unresolved rather than fail the search.
			}
		}
	}

	return items.map((item) => {
		const info = collections.get(item.collection);
		return {
			...item,
			url: interpolateUrlPattern({
				pattern: info?.urlPattern ?? null,
				collection: item.collection,
				slug: item.slug ?? item.id,
				id: item.id,
				date: dates.get(`${item.collection}:${item.id}`),
			}),
			type: info?.labelSingular || info?.label || item.collection,
		};
	});
}
