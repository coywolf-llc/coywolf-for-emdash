/**
 * Public URLs of content entries, using EmDash's own resolution.
 *
 * `ctx.content.getPublicUrl()` is EmDash's resolver (collection url_pattern,
 * date tokens, locale prefix, trailing-slash policy), but it costs two
 * queries per entry. For lists (llms.txt, the news sitemap) we interpolate
 * the url_pattern locally (the same rules as EmDash's interpolateUrlPattern)
 * and check the result against getPublicUrl() for the first entry of each
 * collection and locale; if they ever disagree (custom locale routing, say),
 * that group falls back to getPublicUrl() for every entry.
 */
import type { CollectionSchemaInfo, PluginContentItem, PluginContext } from "emdash";

const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/g;
const pad2 = (n: number) => String(n).padStart(2, "0");

function parseUtc(value: string): Date {
	const offsetless = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(value);
	return new Date(offsetless ? `${offsetless[1]}T${offsetless[2]}Z` : value);
}

/** Mirror of EmDash's interpolateUrlPattern + trailing-slash handling (no locale prefix). */
export function routePath(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
	date?: string | null;
	trailingSlash?: "always" | "never" | "ignore";
}): string {
	const { pattern, collection, slug, id, date } = options;
	let path = (pattern ?? `/${encodeURIComponent(collection)}/{slug}`).replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{id}", encodeURIComponent(id));
	const d = date ? parseUtc(date) : null;
	if (d && !Number.isNaN(d.getTime())) {
		const parts: Record<string, string> = {
			year: String(d.getUTCFullYear()),
			month: pad2(d.getUTCMonth() + 1),
			day: pad2(d.getUTCDate()),
			hour: pad2(d.getUTCHours()),
			minute: pad2(d.getUTCMinutes()),
			second: pad2(d.getUTCSeconds()),
		};
		path = path.replace(DATE_TOKEN, (match, key: string) => parts[key] ?? match);
	}
	path = path.replace(/\/{2,}/g, "/");
	if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
	if (!path.startsWith("/")) path = `/${path}`;
	if (options.trailingSlash === "always" && path !== "/") return `${path}/`;
	return path;
}

export function siteOrigin(ctx: Pick<PluginContext, "site">): string {
	return ctx.site.url.replace(/\/+$/, "");
}

export interface UrlResolver {
	url(collection: CollectionSchemaInfo, item: PluginContentItem): Promise<string | null>;
}

/** See the file comment. One resolver per build (it remembers which groups verified). */
export function createUrlResolver(ctx: PluginContext): UrlResolver {
	const verdicts = new Map<string, "local" | "exact">();
	const origin = siteOrigin(ctx);

	const exact = async (collection: string, id: string) => (await ctx.content?.getPublicUrl?.(collection, id)) ?? null;

	return {
		async url(collection, item) {
			if (!collection.routable || item.status !== "published" || !item.slug) return null;
			const group = `${collection.slug}|${item.locale ?? ""}`;
			const local = `${origin}${routePath({
				pattern: collection.urlPattern,
				collection: collection.slug,
				slug: item.slug,
				id: item.id,
				date: item.publishedAt,
				trailingSlash: ctx.site.trailingSlash,
			})}`;
			const verdict = verdicts.get(group);
			if (verdict === "local") return local;
			if (verdict === "exact" || !ctx.content?.getPublicUrl) return verdict === "exact" ? exact(collection.slug, item.id) : local;
			const real = await exact(collection.slug, item.id);
			verdicts.set(group, real === local ? "local" : "exact");
			return real;
		},
	};
}
