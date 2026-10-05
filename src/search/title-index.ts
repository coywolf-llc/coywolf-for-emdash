/**
 * The title index behind instant live results: every published entry of
 * the searchable collections as [title, url, type], newest first, capped.
 * The browser downloads it once per content version (lazily, on first focus
 * of a search field) and matches titles locally while the server's full-text
 * answer is on its way.
 *
 * Compact on purpose: no content, root-relative URLs, type labels listed
 * once and referenced by position, and plain arrays that compress well.
 */
import { COLLECTION_SLUG, type PrimaryTermRow, type SqlQuery, collectPrimaryTerms, hostDefaultLocale, patternTaxonomies, primaryTermsQuery, urlOverride } from "../core/content-url.js";
import { type CollectionMeta, type SearchMeta, entryUrlsFromMeta, runBatch, searchTargets, titleExpression } from "./engine.js";

/** Most entries in an index (newest kept). */
export const TITLE_INDEX_MAX = 5000;
/** Longest title kept (characters); longer ones are cut. */
const MAX_TITLE = 200;

export interface TitleIndex {
	/** The search content version it was built from. */
	v: string;
	/** Type labels; each entry's third item is a position in this list. */
	types: string[];
	/** [title, root-relative URL, type index], newest first. */
	entries: Array<[string, string, number]>;
}

export interface IndexEntry {
	title: string;
	url: string;
	type: string;
	/** Publish date (ISO or SQLite datetime); newer first. */
	date: string | null;
}

/** Pack entries into the index: newest first, one per URL, titles trimmed, at most `max`. */
export function packTitleIndex(entries: IndexEntry[], version: string, max = TITLE_INDEX_MAX): TitleIndex {
	const sorted = entries
		.map((e, i) => ({ e, i }))
		.filter(({ e }) => e.title.trim() && e.url)
		.sort((a, b) => (b.e.date ?? "").localeCompare(a.e.date ?? "") || a.i - b.i);
	const types: string[] = [];
	const typeIndex = new Map<string, number>();
	const seen = new Set<string>();
	const out: Array<[string, string, number]> = [];
	for (const { e } of sorted) {
		if (out.length >= max) break;
		if (seen.has(e.url)) continue;
		seen.add(e.url);
		let t = typeIndex.get(e.type);
		if (t === undefined) {
			t = types.length;
			types.push(e.type);
			typeIndex.set(e.type, t);
		}
		out.push([e.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE), e.url, t]);
	}
	return { v: version, types, entries: out };
}

/** One collection's published entries for the index, newest first. */
export function indexEntriesQuery(meta: CollectionMeta, options: { locale?: string; max: number }): SqlQuery | null {
	if (!COLLECTION_SLUG.test(meta.slug)) return null;
	const title = titleExpression(meta);
	if (title === "NULL") return null;
	const binds: unknown[] = [];
	let where = "c.status = 'published' AND c.deleted_at IS NULL AND c.slug IS NOT NULL";
	if (options.locale) {
		where += " AND c.locale = ? COLLATE NOCASE";
		binds.push(options.locale);
	}
	binds.push(options.max);
	return {
		sql: `SELECT c.id AS id, c.slug AS slug, c.locale AS locale, c.published_at AS published_at, ${title} AS title FROM "ec_${meta.slug}" c WHERE ${where} ORDER BY c.published_at DESC LIMIT ?`,
		binds,
	};
}

interface IndexRow {
	id: string;
	slug: string;
	locale: string | null;
	published_at: string | null;
	title: string | null;
}

/**
 * Build the index from D1: one batch with each collection's entries (and,
 * for collections whose URLs use terms, every published entry's terms in one
 * query), then URLs from the cached metadata.
 */
export async function buildTitleIndex(db: D1Database, meta: SearchMeta, options: { collections?: string[]; locale?: string; version: string; max?: number }): Promise<TitleIndex> {
	const max = options.max ?? TITLE_INDEX_MAX;
	const targets = searchTargets(meta, options.collections);
	const defaultLocale = await hostDefaultLocale();
	const plan: Array<{ kind: "entries" | "terms"; slug: string }> = [];
	const queries: SqlQuery[] = [];
	for (const t of targets) {
		const q = indexEntriesQuery(t, { locale: options.locale, max });
		if (!q) continue;
		plan.push({ kind: "entries", slug: t.slug });
		queries.push(q);
		const taxonomies = patternTaxonomies(urlOverride(t.slug));
		if (taxonomies.length) {
			plan.push({ kind: "terms", slug: t.slug });
			queries.push(primaryTermsQuery(t.slug, null, taxonomies, defaultLocale));
		}
	}
	const results = await runBatch(db, queries);
	const rows = new Map<string, IndexRow[]>();
	const terms = new Map<string, Map<string, Record<string, string>>>();
	plan.forEach((p, i) => {
		if (p.kind === "entries") rows.set(p.slug, (results[i] ?? []) as unknown as IndexRow[]);
		else terms.set(p.slug, collectPrimaryTerms((results[i] ?? []) as unknown as PrimaryTermRow[]));
	});

	const slugs = [...rows.keys()];
	const urls = await entryUrlsFromMeta(db, meta, slugs, (slug) =>
		(rows.get(slug) ?? []).map((r) => ({
			id: String(r.id),
			slug: r.slug,
			locale: r.locale,
			publishedAt: r.published_at,
			terms: terms.has(slug) ? (terms.get(slug)?.get(String(r.id)) ?? {}) : undefined,
		})),
	);

	const entries: IndexEntry[] = [];
	for (const slug of slugs) {
		const info = meta.collections.get(slug);
		const type = info?.labelSingular || info?.label || slug;
		for (const r of rows.get(slug) ?? []) {
			const url = urls.get(`${slug}:${String(r.id)}`);
			if (!url || !r.title) continue;
			entries.push({ title: String(r.title), url, type, date: r.published_at });
		}
	}
	return packTitleIndex(entries, options.version, max);
}
