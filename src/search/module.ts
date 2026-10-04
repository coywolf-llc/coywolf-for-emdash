/**
 * Search module routes.
 *
 * - search/query (public): EmDash search with an OR fallback, title-first
 *   suggestions, and resolved URLs.
 * - search/live (public): live results for the as-you-type dropdown
 *   (feature "search.live"): title matches, then full text, each with a
 *   highlighted excerpt. Backs the live results script (injected on every
 *   page by the page:fragments hook below) and the SearchBox.
 * - search/config (admin): each collection's search configuration and
 *   fields, read-only, for the Search admin page. The page changes settings
 *   through EmDash's own /_emdash/api/search/{enable,rebuild,stats}
 *   endpoints, so EmDash's permission checks (search:manage) apply.
 */
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { requireFeature } from "../core/features.js";
import { COLLECTION_SLUG, readCollections } from "../core/content-url.js";
import { parseInput, workerEnv } from "../shared.js";
import { liveScript } from "./live-client.js";
import { liveSearch, searchWithFallback } from "./query.js";

export const LIVE_ENDPOINT = "/_emdash/api/plugins/coywolf-pack/search/live";

export interface SearchOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Requests per minute per visitor for search.rateLimit's in-memory fallback. Default 120; 0 turns it off. */
	requestsPerMinute?: number;
	/** Workers Rate Limiting binding name for search.rateLimit. Default none (per-isolate memory only). */
	rateLimiter?: string;
	/** Live results dropdown (feature "search.live") on the site's search forms. */
	live?: LiveOptions;
}

export interface LiveOptions {
	/** Results in the dropdown. Default 8 (1–20). */
	limit?: number;
	/** Characters typed before results show. Default 2. */
	minChars?: number;
	/** Milliseconds to wait after the last keystroke. Default 200. */
	debounce?: number;
	/** Select the first result as results appear, so Enter opens it (Enter otherwise submits the form). Default true. */
	enterOpensTop?: boolean;
}

const clampInt = (value: number | undefined, min: number, max: number, fallback: number) =>
	typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Most collections one search may name. */
const MAX_COLLECTIONS = 10;

const liveInput = z.object({
	q: z.string().trim().min(1, "Enter a search.").max(200, "That search is too long."),
	collections: z.string().max(500).optional(),
	locale: z.string().max(35).optional(),
	limit: z.coerce.number().int().min(1).max(20).optional(),
});

const queryInput = z.object({
	q: z.string().trim().min(1, "Enter a search.").max(200, "That search is too long."),
	mode: z.enum(["search", "suggest"]).optional(),
	collections: z.string().max(500).optional(),
	locale: z.string().max(35).optional(),
	limit: z.coerce.number().int().min(1).max(20).optional(),
	cursor: z.string().max(500).optional(),
});

interface CollectionRow {
	id: string;
	slug: string;
	label: string;
	search_config: string | null;
	title_field: string | null;
}

interface FieldRow {
	collection_id: string;
	slug: string;
	label: string;
	type: string;
	searchable: number;
}

export function searchModule(options: SearchOptions) {
	const database = options.database ?? "DB";
	const live = {
		endpoint: LIVE_ENDPOINT,
		limit: clampInt(options.live?.limit, 1, 20, 8),
		minChars: clampInt(options.live?.minChars, 1, 20, 2),
		debounce: clampInt(options.live?.debounce, 0, 2000, 200),
		enterOpensTop: options.live?.enterOpensTop ?? true,
	};

	/** Only collections that exist; asking for nothing real finds nothing rather than everything. Undefined means all. */
	async function knownCollections(list: string | undefined): Promise<string[] | undefined> {
		if (!list) return undefined;
		const requested = [...new Set(list.split(",").map((c) => c.trim()))].filter((c) => COLLECTION_SLUG.test(c)).slice(0, MAX_COLLECTIONS);
		const known = requested.length ? await readCollections(await db(), requested) : new Map();
		return requested.filter((c) => known.has(c));
	}

	async function db() {
		const env = await workerEnv();
		const d1 = env[database] as D1Database | undefined;
		if (!d1) throw PluginRouteError.badRequest("Search: missing database binding.");
		return d1;
	}

	const routes = {
		"search/query": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "public, max-age=60",
			handler: async (ctx) => {
				await requireFeature(ctx, "search.box");
				const input = parseInput(queryInput, ctx.input);
				const collections = await knownCollections(input.collections);
				if (collections && !collections.length) return { items: [], fallback: false };
				return searchWithFallback(input.q, {
					mode: input.mode,
					collections,
					locale: input.locale,
					limit: input.limit ?? 8,
					cursor: input.cursor,
					database,
				});
			},
		}),

		"search/live": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			// Published content only, the same for every visitor; a minute keeps a burst of identical keystrokes cheap.
			cacheControl: "public, max-age=60",
			handler: async (ctx) => {
				await requireFeature(ctx, "search.live");
				const input = parseInput(liveInput, ctx.input);
				const collections = await knownCollections(input.collections);
				if (collections && !collections.length) return { items: [], fallback: false };
				return liveSearch(input.q, { collections, locale: input.locale, limit: input.limit ?? live.limit, database });
			},
		}),

		"search/config": {
			permission: "search:manage" as const,
			handler: async (ctx: Parameters<typeof requireFeature>[0]) => {
				await requireFeature(ctx, "search.settings");
				const d1 = await db();
				const [collections, fields] = await Promise.all([
					d1.prepare("SELECT id, slug, label, search_config, title_field FROM _emdash_collections ORDER BY label").all<CollectionRow>(),
					d1.prepare("SELECT collection_id, slug, label, type, searchable FROM _emdash_fields ORDER BY sort_order").all<FieldRow>(),
				]);
				return {
					collections: collections.results.map((c) => {
						let config: { enabled?: boolean; weights?: Record<string, number>; tokenize?: string } = {};
						try {
							config = c.search_config ? JSON.parse(c.search_config) : {};
						} catch {
							config = {};
						}
						return {
							slug: c.slug,
							label: c.label,
							enabled: config.enabled === true,
							weights: config.weights ?? {},
							tokenize: config.tokenize ?? "porter unicode61",
							titleField: c.title_field,
							fields: fields.results
								.filter((f) => f.collection_id === c.id)
								.map((f) => ({ slug: f.slug, label: f.label, type: f.type, searchable: f.searchable === 1 })),
						};
					}),
				};
			},
		},
	};

	const hooks = {
		/** The live results script, on every public page (it attaches only where there's a search form). */
		"page:fragments": (event: { page: { locale: string | null } }) => ({
			kind: "inline-script" as const,
			placement: "body:end" as const,
			key: "search-live",
			code: liveScript({ ...live, locale: event.page.locale ?? null }),
		}),
	};

	return { routes, hooks };
}
