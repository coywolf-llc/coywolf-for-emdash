/**
 * Public URLs of content entries, pack-wide.
 *
 * EmDash resolves an entry's URL from its collection's `url_pattern`
 * ({slug}, {id} and WordPress-style date tokens; emdash/src/i18n/resolve.ts
 * interpolateUrlPattern, which isn't exported), falling back to
 * /<collection>/<slug>. Themes can route entries any way they like, though,
 * e.g. WordPress-style /{category}/{slug}/. The site tells the pack about
 * such routes with coywolfPlugin({ urls }):
 *
 * ```js
 * coywolfPlugin({ urls: { posts: "/{term:category|uncategorized}/{slug}/" } })
 * ```
 *
 * Override patterns take EmDash's tokens plus `{term:<taxonomy>}` (the slug
 * of the entry's first term in that taxonomy, ordered the way EmDash's
 * getTermsForEntries orders them: by label) with an optional fallback after
 * a pipe, `{term:category|uncategorized}`. `{category}` is shorthand for
 * exactly that. Collections without an override resolve the way EmDash
 * does (getPublicUrl inside the plugin context, url_pattern otherwise).
 *
 * Configuration: coywolfPlugin() options reach createPlugin(), which
 * EmDash's generated plugins module (virtual:emdash/plugins) calls when the
 * Worker isolate starts, so configureContentUrls() runs before any request
 * reaches the middleware or an Astro component. Same pattern as the search
 * module's rate limit options.
 *
 * Sources: every resolver takes either the plugin context (hooks and
 * routes) or the site's D1 database (middleware, Astro components). With a
 * context, terms come from EmDash's getTermsForEntries and non-overridden
 * collections from getPublicUrl (published entries only). With D1, terms are
 * read with the same SQL EmDash uses and url_pattern is interpolated
 * locally. No locale prefix is applied to override patterns.
 */
import type { PluginContext } from "emdash";

// ── Pattern interpolation (pure) ─────────────────────────────────

const REPEATED_SLASHES = /\/{2,}/g;
const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;
const DATE_TOKEN_TEST = /\{(year|month|day|hour|minute|second)\}/;
const TERM_TOKEN = /\{term:([A-Za-z0-9_-]+)(?:\|([^{}/]*))?\}/g;
const UNRESOLVED_TERM = /\{term:[^}]*\}/;
const OFFSETLESS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

export type TrailingSlash = "always" | "never" | "ignore";

function parseUtcDate(date: string | Date): Date {
	if (date instanceof Date) return date;
	const offsetless = OFFSETLESS_DATETIME.exec(date);
	return new Date(offsetless ? `${offsetless[1]}T${offsetless[2]}Z` : date);
}

function applyDateTokens(path: string, date: string | Date | null | undefined): string {
	const d = date == null ? null : parseUtcDate(date);
	if (!d || Number.isNaN(d.getTime())) return path;
	const parts: Record<string, string> = {
		year: String(d.getUTCFullYear()),
		month: pad2(d.getUTCMonth() + 1),
		day: pad2(d.getUTCDate()),
		hour: pad2(d.getUTCHours()),
		minute: pad2(d.getUTCMinutes()),
		second: pad2(d.getUTCSeconds()),
	};
	return path.replace(DATE_TOKEN, (match, key: string) => parts[key] ?? match);
}

/** Expand pack shorthands: `{category}` → `{term:category|uncategorized}`. */
export function expandPattern(pattern: string): string {
	return pattern.replaceAll("{category}", "{term:category|uncategorized}");
}

/** Taxonomies named by `{term:…}` tokens. */
export function patternTaxonomies(pattern: string | null): string[] {
	if (!pattern) return [];
	return [...new Set([...expandPattern(pattern).matchAll(TERM_TOKEN)].map((m) => m[1]))];
}

/** True when the pattern needs a publish date to resolve. */
export function patternUsesDate(pattern: string | null): boolean {
	return !!pattern && DATE_TOKEN_TEST.test(pattern);
}

/**
 * EmDash's interpolateUrlPattern, plus `{term:<taxonomy>|fallback}` tokens
 * filled from `terms` (taxonomy → first term slug). A term token with no
 * term and no fallback stays literal, like a date token without a date.
 * The result has no trailing slash (see applyTrailingSlash).
 */
export function interpolateUrlPattern(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
	date?: string | Date | null;
	terms?: Record<string, string | null | undefined>;
}): string {
	const { pattern, collection, slug, id, date, terms } = options;
	const basePattern = pattern == null ? `/${encodeURIComponent(collection)}/{slug}` : expandPattern(pattern);
	let path = basePattern.replace(TERM_TOKEN, (match, taxonomy: string, fallback: string | undefined) => {
		const term = terms?.[taxonomy];
		if (term) return encodeURIComponent(term);
		return fallback ? fallback : match;
	});
	path = path.replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{id}", encodeURIComponent(id));
	path = applyDateTokens(path, date);
	path = path.replace(REPEATED_SLASHES, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	return path;
}

/**
 * Astro's trailingSlash policy, as EmDash applies it. With "ignore", an
 * override pattern keeps its own trailing slash (`/{slug}/` → `/a/`), while
 * EmDash's url_pattern resolution never has one.
 */
export function applyTrailingSlash(path: string, policy: TrailingSlash | undefined, patternHasSlash = false): string {
	if (path === "/") return path;
	const bare = path.replace(/\/+$/, "");
	if (policy === "always" || (policy !== "never" && patternHasSlash)) return `${bare}/`;
	return bare;
}

/** The path an override pattern gives an entry, or null when a term token can't be filled. */
export function overridePath(
	pattern: string,
	entry: { collection: string; id: string; slug: string; date?: string | Date | null; terms?: Record<string, string | null | undefined> },
	policy: TrailingSlash | undefined,
): string | null {
	const expanded = expandPattern(pattern);
	const path = interpolateUrlPattern({ pattern: expanded, collection: entry.collection, slug: entry.slug, id: entry.id, date: entry.date, terms: entry.terms });
	if (UNRESOLVED_TERM.test(path)) return null;
	return applyTrailingSlash(path, policy, expanded.endsWith("/"));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ANY_TOKEN = /\{(?:term:[A-Za-z0-9_-]+(?:\|[^{}/]*)?|[a-z]+)\}/g;

/**
 * Compile a pattern into a regex over decoded paths without a trailing
 * slash. Captures the {slug} and {id} tokens; other tokens match one segment.
 */
export function compilePattern(pattern: string): { regex: RegExp; slug: number; id: number } {
	let source = expandPattern(pattern).replace(REPEATED_SLASHES, "/");
	if (!source.startsWith("/")) source = `/${source}`;
	if (source.length > 1) source = source.replace(/\/+$/, "");
	let regex = "";
	let last = 0;
	let group = 0;
	let slug = 0;
	let id = 0;
	for (const m of source.matchAll(ANY_TOKEN)) {
		regex += escapeRegex(source.slice(last, m.index));
		group++;
		if (m[0] === "{slug}" && !slug) slug = group;
		if (m[0] === "{id}" && !id) id = group;
		regex += "([^/]+)";
		last = (m.index ?? 0) + m[0].length;
	}
	regex += escapeRegex(source.slice(last));
	return { regex: new RegExp(`^${regex}$`), slug, id };
}

const safeDecode = (path: string) => {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
};
/** Comparable form of a path: decoded, no trailing slash. */
export const comparablePath = (path: string) => {
	const p = safeDecode(path.split(/[?#]/)[0]);
	return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

// ── Configuration ────────────────────────────────────────────────

/** Collection slugs are validated before being used as table names. */
export const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;

export interface ContentUrlOptions {
	/** Collection → URL pattern, for collections the theme routes differently from EmDash's url_pattern. */
	urls?: Record<string, string>;
	/** Trailing-slash policy for the pack's entry URLs. Default: EmDash's (Astro's `trailingSlash`). */
	trailingSlash?: TrailingSlash;
}

let config: { urls: Map<string, string>; trailingSlash?: TrailingSlash } = { urls: new Map() };

/** Set from coywolfPlugin()/createPlugin() options. Invalid collection slugs are ignored. */
export function configureContentUrls(options: ContentUrlOptions = {}): void {
	const urls = new Map<string, string>();
	for (const [collection, pattern] of Object.entries(options.urls ?? {})) {
		if (COLLECTION_SLUG.test(collection) && typeof pattern === "string" && pattern.trim()) urls.set(collection, expandPattern(pattern.trim()));
	}
	config = { urls, trailingSlash: options.trailingSlash };
}

/** The configured override pattern for a collection (shorthands expanded), if any. */
export function urlOverride(collection: string): string | null {
	return config.urls.get(collection) ?? null;
}

// ── Sources ──────────────────────────────────────────────────────

/** The plugin context, or the parts of it URL resolution uses. */
export type UrlContext = Pick<PluginContext, "site" | "content" | "schema">;
export type UrlSource = UrlContext | D1Database;

const isD1 = (source: UrlSource): source is D1Database => typeof (source as D1Database).prepare === "function";

interface HostConfig {
	trailingSlash?: TrailingSlash;
	defaultLocale?: string;
}
let hostConfig: Promise<HostConfig> | null = null;
/** EmDash's build-time config (virtual:emdash/config), as menus read it. Empty outside a site build. */
function readHostConfig(): Promise<HostConfig> {
	hostConfig ??= (async () => {
		try {
			// @ts-ignore: provided by EmDash's Vite integration in the site build; absent under Node tests.
			const mod = (await import("virtual:emdash/config")) as { default?: { trailingSlash?: TrailingSlash; i18n?: { defaultLocale?: string } | null } };
			return { trailingSlash: mod.default?.trailingSlash, defaultLocale: mod.default?.i18n?.defaultLocale };
		} catch {
			return {};
		}
	})();
	return hostConfig;
}

async function trailingPolicy(source: UrlSource): Promise<TrailingSlash> {
	if (config.trailingSlash) return config.trailingSlash;
	if (!isD1(source) && source.site.trailingSlash) return source.site.trailingSlash;
	return (await readHostConfig()).trailingSlash ?? "ignore";
}

const SQL_CHUNK = 50;
function chunks<T>(items: T[], size = SQL_CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * First term slug per entry for each taxonomy, ordered as EmDash's
 * getTermsForEntries orders them (label ascending, locale-resolved terms).
 */
export async function primaryTerms(source: UrlSource, collection: string, ids: string[], taxonomies: string[]): Promise<Map<string, Record<string, string>>> {
	const out = new Map<string, Record<string, string>>();
	const unique = [...new Set(ids)];
	for (const id of unique) out.set(id, {});
	if (!unique.length || !taxonomies.length || !COLLECTION_SLUG.test(collection)) return out;

	if (!isD1(source)) {
		const { getTermsForEntries } = await import("emdash");
		for (const taxonomy of taxonomies) {
			const map = await getTermsForEntries(collection, unique, taxonomy).catch(() => new Map());
			for (const [id, terms] of map as Map<string, Array<{ slug: string }>>) {
				const first = terms[0]?.slug;
				if (first) out.get(id)![taxonomy] = first;
			}
		}
		return out;
	}

	// The SQL of EmDash's selectEntryTermRows (taxonomies/index.ts), for all wanted taxonomies at once.
	const defaultLocale = (await readHostConfig()).defaultLocale ?? "en";
	for (const chunk of chunks(unique)) {
		let rows: Array<{ entry_id: string; name: string; slug: string }>;
		try {
			const result = await source
				.prepare(
					`SELECT content.id AS entry_id,
						coalesce(exact_term.name, default_term.name) AS name,
						coalesce(exact_term.slug, default_term.slug) AS slug
					FROM "ec_${collection}" AS content
					INNER JOIN content_taxonomies AS pivot
						ON pivot.entry_id = content.translation_group
						AND pivot.collection = ?
					LEFT JOIN taxonomies AS exact_term
						ON exact_term.translation_group = pivot.taxonomy_id
						AND exact_term.locale = content.locale
					LEFT JOIN taxonomies AS default_term
						ON default_term.translation_group = pivot.taxonomy_id
						AND default_term.locale = ?
					WHERE content.id IN (${chunk.map(() => "?").join(",")})
						AND coalesce(exact_term.id, default_term.id) IS NOT NULL
						AND coalesce(exact_term.name, default_term.name) IN (${taxonomies.map(() => "?").join(",")})
					ORDER BY coalesce(exact_term.label, default_term.label) ASC`,
				)
				.bind(collection, defaultLocale, ...chunk, ...taxonomies)
				.all<{ entry_id: string; name: string; slug: string }>();
			rows = result.results;
		} catch {
			return out; // No taxonomy tables yet: no terms (fallbacks apply).
		}
		for (const row of rows) {
			const terms = out.get(row.entry_id);
			if (terms && row.slug && !(row.name in terms)) terms[row.name] = row.slug;
		}
	}
	return out;
}

// ── Collections (D1) ─────────────────────────────────────────────

export interface CollectionInfo {
	slug: string;
	label: string;
	labelSingular: string | null;
	urlPattern: string | null;
	titleField: string | null;
}

/** Read collection metadata from the site's D1 database. */
export async function readCollections(db: D1Database, slugs?: string[]): Promise<Map<string, CollectionInfo>> {
	const wanted = slugs?.filter((s) => COLLECTION_SLUG.test(s));
	if (wanted && wanted.length === 0) return new Map();
	const sql = wanted?.length
		? `SELECT slug, label, label_singular, url_pattern, title_field FROM _emdash_collections WHERE slug IN (${wanted.map(() => "?").join(",")})`
		: "SELECT slug, label, label_singular, url_pattern, title_field FROM _emdash_collections";
	const { results } = await db
		.prepare(sql)
		.bind(...(wanted ?? []))
		.all<{ slug: string; label: string; label_singular: string | null; url_pattern: string | null; title_field: string | null }>();
	const out = new Map<string, CollectionInfo>();
	for (const r of results) {
		out.set(r.slug, { slug: r.slug, label: r.label, labelSingular: r.label_singular, urlPattern: r.url_pattern, titleField: r.title_field });
	}
	return out;
}

// ── Entry URLs ───────────────────────────────────────────────────

export interface EntryRef {
	id: string;
	slug?: string | null;
	/** Publish date (for date tokens). `date` is accepted as an alias. */
	publishedAt?: string | Date | null;
	date?: string | Date | null;
	locale?: string | null;
	/** When known and not "published", context sources answer null (like getPublicUrl). */
	status?: string | null;
}

interface CollectionRoute {
	/** Override pattern, or EmDash's url_pattern (null = /<collection>/{slug}). */
	pattern: string | null;
	override: boolean;
	routable: boolean;
}

export interface EntryUrlResolver {
	/** Root-relative paths keyed by entry id (null: no public URL). */
	urls(collection: string, entries: EntryRef[]): Promise<Map<string, string | null>>;
	url(collection: string, entry: EntryRef): Promise<string | null>;
}

/**
 * A resolver that remembers collection info, the trailing-slash policy and
 * (with a context) whether local interpolation matches getPublicUrl for each
 * collection and locale. Use one per request or build.
 */
export function createEntryUrlResolver(source: UrlSource): EntryUrlResolver {
	const routes = new Map<string, Promise<CollectionRoute | null>>();
	const verdicts = new Map<string, "local" | "exact">();
	let policy: Promise<TrailingSlash> | null = null;
	const getPolicy = () => (policy ??= trailingPolicy(source));

	function route(collection: string): Promise<CollectionRoute | null> {
		let r = routes.get(collection);
		if (!r) {
			r = (async (): Promise<CollectionRoute | null> => {
				const override = urlOverride(collection);
				if (override) return { pattern: override, override: true, routable: true };
				if (isD1(source)) {
					const info = (await readCollections(source, [collection]).catch(() => new Map<string, CollectionInfo>())).get(collection);
					return { pattern: info?.urlPattern ?? null, override: false, routable: true };
				}
				const info = await source.schema?.getCollection(collection).catch(() => null);
				if (!info) return null;
				return { pattern: info.urlPattern ?? null, override: false, routable: info.routable };
			})();
			routes.set(collection, r);
		}
		return r;
	}

	/** Publish dates for entries that didn't bring one, when the pattern needs them (D1 only). */
	async function fillDates(collection: string, entries: EntryRef[]): Promise<Map<string, string | null>> {
		const dates = new Map<string, string | null>();
		const missing = entries.filter((e) => e.publishedAt === undefined && e.date === undefined).map((e) => e.id);
		if (!missing.length || !isD1(source) || !COLLECTION_SLUG.test(collection)) return dates;
		for (const chunk of chunks([...new Set(missing)])) {
			try {
				const { results } = await source
					.prepare(`SELECT id, published_at FROM "ec_${collection}" WHERE id IN (${chunk.map(() => "?").join(",")})`)
					.bind(...chunk)
					.all<{ id: string; published_at: string | null }>();
				for (const r of results) dates.set(r.id, r.published_at);
			} catch {
				// Leave date tokens unresolved rather than fail.
			}
		}
		return dates;
	}

	async function exact(collection: string, id: string): Promise<string | null> {
		if (isD1(source)) return null;
		const url = await source.content?.getPublicUrl?.(collection, id).catch(() => null);
		if (!url) return null;
		try {
			const path = new URL(url).pathname;
			// A pack-level trailingSlash option wins over EmDash's.
			return config.trailingSlash ? applyTrailingSlash(path, config.trailingSlash) : path;
		} catch {
			return null;
		}
	}

	async function urls(collection: string, entries: EntryRef[]): Promise<Map<string, string | null>> {
		const out = new Map<string, string | null>();
		const r = await route(collection);
		const usable = entries.filter((e) => {
			const ok = !!r?.routable && !!e.slug && (isD1(source) || !e.status || e.status === "published");
			if (!ok) out.set(e.id, null);
			return ok;
		});
		if (!r || !usable.length) return out;
		const trailing = await getPolicy();
		const dates = patternUsesDate(r.pattern) ? await fillDates(collection, usable) : new Map<string, string | null>();
		const dateOf = (e: EntryRef) => e.publishedAt ?? e.date ?? dates.get(e.id) ?? null;

		if (r.override && r.pattern) {
			const taxonomies = patternTaxonomies(r.pattern);
			const terms = taxonomies.length ? await primaryTerms(source, collection, usable.map((e) => e.id), taxonomies) : new Map<string, Record<string, string>>();
			for (const e of usable) {
				out.set(e.id, overridePath(r.pattern, { collection, id: e.id, slug: e.slug as string, date: dateOf(e), terms: terms.get(e.id) }, trailing));
			}
			return out;
		}

		for (const e of usable) {
			const local = applyTrailingSlash(interpolateUrlPattern({ pattern: r.pattern, collection, slug: e.slug as string, id: e.id, date: dateOf(e) }), trailing);
			if (isD1(source) || !source.content?.getPublicUrl) {
				out.set(e.id, local);
				continue;
			}
			// Context: getPublicUrl is authoritative (locale prefixes). Verify local interpolation once per collection and locale.
			const group = `${collection}|${e.locale ?? ""}`;
			const verdict = verdicts.get(group);
			if (verdict === "local") out.set(e.id, local);
			else if (verdict === "exact") out.set(e.id, await exact(collection, e.id));
			else {
				const real = await exact(collection, e.id);
				if (real !== null) verdicts.set(group, real === local ? "local" : "exact");
				out.set(e.id, real);
			}
		}
		return out;
	}

	return {
		urls,
		async url(collection, entry) {
			return (await urls(collection, [entry])).get(entry.id) ?? null;
		},
	};
}

/** Root-relative public path of one entry, or null. */
export async function entryUrl(source: UrlSource, collection: string, entry: EntryRef): Promise<string | null> {
	return createEntryUrlResolver(source).url(collection, entry);
}

/** Root-relative public paths of a list of entries (terms and dates read in batches), keyed by id. */
export async function entryUrls(source: UrlSource, collection: string, entries: EntryRef[]): Promise<Map<string, string | null>> {
	return createEntryUrlResolver(source).urls(collection, entries);
}

/** An absolute URL from a root-relative path and the site URL. */
export function absoluteUrl(path: string, siteUrl: string): string {
	return `${siteUrl.replace(/\/+$/, "")}${path}`;
}

// ── Reverse: path → entry ────────────────────────────────────────

export interface MatchedEntry {
	collection: string;
	id: string;
	/** The entry's canonical path (equal to the requested path, ignoring a trailing slash and encoding). */
	path: string;
}

interface Candidate extends EntryRef {
	slug: string;
}

/** Published entries of a collection with this slug (or id). */
async function findPublished(source: UrlSource, collection: string, by: "slug" | "id", value: string): Promise<Candidate[]> {
	if (!COLLECTION_SLUG.test(collection)) return [];
	if (isD1(source)) {
		try {
			const { results } = await source
				.prepare(`SELECT id, slug, published_at, locale FROM "ec_${collection}" WHERE ${by} = ? AND status = 'published' AND deleted_at IS NULL LIMIT 20`)
				.bind(value)
				.all<{ id: string; slug: string | null; published_at: string | null; locale: string | null }>();
			return results.filter((r) => r.slug).map((r) => ({ id: r.id, slug: r.slug as string, publishedAt: r.published_at, locale: r.locale, status: "published" }));
		} catch {
			return [];
		}
	}
	let id = value;
	if (by === "slug") {
		const { getEmDashEntry } = await import("emdash");
		const { entry } = await getEmDashEntry(collection, value).catch(() => ({ entry: null }));
		if (!entry) return [];
		const dataId = (entry.data as Record<string, unknown>).id;
		id = typeof dataId === "string" && dataId ? dataId : entry.id;
	}
	const item = await source.content?.get(collection, id).catch(() => null);
	if (!item || item.status !== "published" || !item.slug) return [];
	return [{ id: item.id, slug: item.slug, publishedAt: item.publishedAt, locale: item.locale, status: item.status }];
}

async function verify(resolver: EntryUrlResolver, collection: string, candidates: Candidate[], wanted: string): Promise<MatchedEntry | null> {
	if (!candidates.length) return null;
	const urls = await resolver.urls(collection, candidates);
	for (const c of candidates) {
		const path = urls.get(c.id);
		if (path && comparablePath(path) === wanted) return { collection, id: c.id, path };
	}
	return null;
}

async function matchPattern(source: UrlSource, resolver: EntryUrlResolver, collection: string, pattern: string, wanted: string): Promise<MatchedEntry | null> {
	let compiled: ReturnType<typeof compilePattern>;
	try {
		compiled = compilePattern(pattern);
	} catch {
		return null;
	}
	const m = compiled.regex.exec(wanted);
	if (!m) return null;
	const by = compiled.slug ? "slug" : compiled.id ? "id" : null;
	if (!by) return null;
	const value = m[by === "slug" ? compiled.slug : compiled.id];
	return verify(resolver, collection, await findPublished(source, collection, by, value), wanted);
}

/**
 * The published entry a site path belongs to, or null. Override patterns
 * first: e.g. for `/{term:category}/{slug}/` the entry is looked up by slug
 * and its primary category must match. Then EmDash's own routing
 * (resolveEmDashPath with a context; url_pattern or /<collection>/{slug}
 * from D1). Every match is verified by resolving the entry's URL back.
 */
export async function matchEntryPath(source: UrlSource, path: string): Promise<MatchedEntry | null> {
	const wanted = comparablePath(path);
	if (!wanted.startsWith("/")) return null;
	const resolver = createEntryUrlResolver(source);

	for (const [collection, pattern] of config.urls) {
		const found = await matchPattern(source, resolver, collection, pattern, wanted);
		if (found) return found;
	}

	if (isD1(source)) {
		let rows: Array<{ slug: string; url_pattern: string | null; routable?: number | null }> = [];
		try {
			rows = (await source.prepare("SELECT slug, url_pattern, routable FROM _emdash_collections").all<{ slug: string; url_pattern: string | null; routable: number | null }>()).results;
		} catch {
			rows = [...(await readCollections(source).catch(() => new Map<string, CollectionInfo>())).values()].map((c) => ({ slug: c.slug, url_pattern: c.urlPattern }));
		}
		for (const row of rows) {
			if (config.urls.has(row.slug) || row.routable === 0) continue;
			const found = await matchPattern(source, resolver, row.slug, row.url_pattern ?? `/${row.slug}/{slug}`, wanted);
			if (found) return found;
		}
		return null;
	}

	// Context: EmDash's resolver for url_pattern collections, then the default /<collection>/<slug>.
	const { resolveEmDashPath } = await import("emdash");
	for (const candidate of new Set([wanted, `${wanted}/`])) {
		const match = await resolveEmDashPath(candidate).catch(() => null);
		if (!match) continue;
		const dataId = (match.entry.data as Record<string, unknown>).id;
		const id = typeof dataId === "string" && dataId ? dataId : match.entry.id;
		const item = await source.content?.get(match.collection, id).catch(() => null);
		if (item?.slug && item.status === "published") {
			const found = await verify(resolver, match.collection, [{ id: item.id, slug: item.slug, publishedAt: item.publishedAt, locale: item.locale, status: item.status }], wanted);
			if (found) return found;
		}
	}
	const segments = wanted.split("/").filter(Boolean);
	if (segments.length === 2 && !config.urls.has(segments[0])) {
		const info = await source.schema?.getCollection(segments[0]).catch(() => null);
		if (info?.routable && !info.urlPattern) {
			const found = await verify(resolver, segments[0], await findPublished(source, segments[0], "slug", segments[1]), wanted);
			if (found) return found;
		}
	}
	return null;
}
