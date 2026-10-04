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

import { COLLECTION_SLUG, type CollectionInfo, createEntryUrlResolver, interpolateUrlPattern, readCollections } from "../core/content-url.js";
import { workerEnv } from "../shared.js";
import { buildOrQuery, rankByCoverage } from "./fallback.js";
import { buildSnippet, highlightHtml, highlightWords } from "./snippet.js";

export interface PackSearchResult extends SearchResult {
	/** Public path of the entry: the site's `urls` override for the collection, or its URL pattern. */
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
	/** D1 binding of the site database, for URL patterns and terms. Default "DB". */
	database?: string;
}

/** How many OR results to rank in one go (the fallback isn't paginated). */
const FALLBACK_POOL = 50;

export async function searchWithFallback(query: string, options: PackSearchOptions = {}): Promise<PackSearchResponse> {
	const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
	const base = {
		collections: options.collections ? [...new Set(options.collections)].filter((c) => COLLECTION_SLUG.test(c)).slice(0, 10) : undefined,
		locale: options.locale,
	};

	// EmDash treats an empty list as "every collection"; a list with nothing valid in it should find nothing.
	if (base.collections && base.collections.length === 0) return { items: [], fallback: false };

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

/** One live result (feature "search.live"): everything the dropdown shows, already escaped where it's HTML. */
export interface LiveSearchResult {
	id: string;
	collection: string;
	title: string;
	/** The title, escaped, with the visitor's words in <mark> (the only tag). */
	titleHtml: string;
	url: string;
	type: string;
	/** An excerpt around the first match, escaped, with matches in <mark> and "…" where it was cut. */
	snippet: string;
}

export interface LiveSearchResponse {
	items: LiveSearchResult[];
	/** True when nothing matched every word, so these results match any word. */
	fallback: boolean;
}

/**
 * Live results (as-you-type dropdown): title matches first, then full-text
 * matches (with the OR fallback) to fill the list, each with an excerpt from
 * the entry's indexed text. Built on searchWithFallback, so ranking, the
 * fallback and URLs are the same as the search page's. Published entries
 * only (EmDash's search default).
 */
export async function liveSearch(query: string, options: Omit<PackSearchOptions, "cursor" | "mode"> = {}): Promise<LiveSearchResponse> {
	const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
	const collections = options.collections ? [...new Set(options.collections)].filter((c) => COLLECTION_SLUG.test(c)).slice(0, 10) : undefined;
	if (collections && collections.length === 0) return { items: [], fallback: false };

	const titles = await search(query, { collections, locale: options.locale, limit, scope: "title" });
	const merged: PackSearchResult[] = await withUrls(titles.items, options.database);
	let fallback = false;
	if (merged.length < limit) {
		const seen = new Set(merged.map((i) => `${i.collection}:${i.id}`));
		const rest = await searchWithFallback(query, { collections, locale: options.locale, limit, database: options.database });
		for (const item of rest.items) {
			if (merged.length >= limit) break;
			if (seen.has(`${item.collection}:${item.id}`)) continue;
			merged.push(item);
		}
		fallback = rest.fallback && titles.items.length === 0;
	}

	const words = highlightWords(query);
	const texts = await snippetTexts(merged, options.database);
	return {
		fallback,
		items: merged.map((item) => {
			const title = item.title || item.slug || item.id;
			return {
				id: item.id,
				collection: item.collection,
				title,
				titleHtml: highlightHtml(title, words),
				url: item.url,
				type: item.type,
				snippet: buildSnippet(texts.get(`${item.collection}:${item.id}`) ?? "", words),
			};
		}),
	};
}

/** Characters of indexed text read per entry for its excerpt (a match past this shows the start instead). */
const SNIPPET_SOURCE_CHARS = 20_000;
/** Field slugs are SQL identifiers here; EmDash validates them the same way. */
const FIELD_SLUG = /^[a-z][a-z0-9_]*$/;

/**
 * Each result's indexed plain text, without the title: the searchable fields
 * as EmDash stored them in the collection's FTS5 table (Portable Text already
 * reduced to prose). Rows are found by rowid, which the FTS table shares with
 * the content table, so this never scans the index. Best effort: any failure
 * just means results without excerpts.
 */
async function snippetTexts(items: PackSearchResult[], database = "DB"): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!items.length) return out;
	let db: D1Database | undefined;
	try {
		db = (await workerEnv())[database] as D1Database | undefined;
	} catch {
		db = undefined;
	}
	if (!db) return out;
	const slugs = [...new Set(items.map((i) => i.collection))].filter((s) => COLLECTION_SLUG.test(s));
	try {
		const [collections, fields] = await Promise.all([
			readCollections(db, slugs),
			db
				.prepare(
					`SELECT c.slug AS collection, f.slug AS field FROM _emdash_fields f JOIN _emdash_collections c ON c.id = f.collection_id WHERE f.searchable = 1 AND c.slug IN (${slugs.map(() => "?").join(",")}) ORDER BY f.sort_order`,
				)
				.bind(...slugs)
				.all<{ collection: string; field: string }>(),
		]);
		await Promise.all(
			slugs.map(async (slug) => {
				const titleField = collections.get(slug)?.titleField || "title";
				const columns = fields.results.filter((f) => f.collection === slug && f.field !== titleField && FIELD_SLUG.test(f.field)).map((f) => f.field);
				if (!columns.length) return;
				const ids = items.filter((i) => i.collection === slug).map((i) => i.id);
				const text = columns.map((c) => `COALESCE(substr(f."${c}", 1, ${SNIPPET_SOURCE_CHARS}), '')`).join(" || ' ' || ");
				const { results } = await db
					.prepare(
						`SELECT c.id AS id, ${text} AS text FROM "ec_${slug}" c JOIN "_emdash_fts_${slug}" f ON f.rowid = c.rowid WHERE c.id IN (${ids.map(() => "?").join(",")})`,
					)
					.bind(...ids)
					.all<{ id: string; text: string | null }>();
				for (const row of results) if (row.text) out.set(`${slug}:${row.id}`, row.text);
			}),
		);
	} catch {
		// Results without excerpts rather than no results.
	}
	return out;
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
	const collections = db ? await readCollections(db, slugs).catch(() => new Map<string, CollectionInfo>()) : new Map<string, CollectionInfo>();

	// Paths from the pack-wide resolver: the site's `urls` overrides (terms read in one batch per
	// collection) or the collection's url_pattern (publish dates read only when it has date tokens).
	const urls = new Map<string, string | null>();
	if (db) {
		const resolver = createEntryUrlResolver(db);
		for (const slug of slugs) {
			const entries = items.filter((i) => i.collection === slug).map((i) => ({ id: i.id, slug: i.slug ?? i.id, locale: i.locale }));
			try {
				for (const [id, url] of await resolver.urls(slug, entries)) urls.set(`${slug}:${id}`, url);
			} catch {
				// Fall back to the default route below rather than fail the search.
			}
		}
	}

	return items.map((item) => {
		const info = collections.get(item.collection);
		return {
			...item,
			url: urls.get(`${item.collection}:${item.id}`) ?? interpolateUrlPattern({ pattern: null, collection: item.collection, slug: item.slug ?? item.id, id: item.id }),
			type: info?.labelSingular || info?.label || item.collection,
		};
	});
}
