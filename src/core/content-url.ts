/**
 * Public URLs of content entries, resolved the way EmDash resolves them
 * (emdash/src/i18n/resolve.ts interpolateUrlPattern, which isn't exported):
 * the collection's `url_pattern` with {slug}, {id} and WordPress-style date
 * tokens from the publish date, falling back to /<collection>/<slug>.
 * No locale prefix is applied.
 */

const REPEATED_SLASHES = /\/{2,}/g;
const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;
const OFFSETLESS_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
const pad2 = (n: number) => String(n).padStart(2, "0");

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

export function interpolateUrlPattern(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
	date?: string | Date | null;
}): string {
	const { pattern, collection, slug, id, date } = options;
	const basePattern = pattern ?? `/${encodeURIComponent(collection)}/{slug}`;
	let path = basePattern.replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{id}", encodeURIComponent(id));
	path = applyDateTokens(path, date);
	path = path.replace(REPEATED_SLASHES, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	return path;
}

/** True when the pattern needs a publish date to resolve. */
export function patternUsesDate(pattern: string | null): boolean {
	return !!pattern && /\{(year|month|day|hour|minute|second)\}/.test(pattern);
}

/** Collection slugs are validated before being used as table names. */
export const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;

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
