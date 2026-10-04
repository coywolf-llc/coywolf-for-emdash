/**
 * Public URLs of content entries, using EmDash's own resolution.
 *
 * `ctx.content.getPublicUrl()` is EmDash's resolver (collection url_pattern,
 * date tokens, locale prefix, trailing-slash policy), but it costs two
 * queries per entry. For lists (llms.txt, the news sitemap) we interpolate
 * the url_pattern locally (core/content-url.ts, EmDash's interpolateUrlPattern)
 * and check the result against getPublicUrl() for the first entry of each
 * collection and locale; if they ever disagree (custom locale routing, say),
 * that group falls back to getPublicUrl() for every entry.
 */
import type { CollectionSchemaInfo, PluginContentItem, PluginContext } from "emdash";

import { interpolateUrlPattern } from "../core/content-url.js";

/** EmDash's url_pattern interpolation (shared core helper) plus its trailing-slash policy; no locale prefix. */
export function routePath(options: {
	pattern: string | null;
	collection: string;
	slug: string;
	id: string;
	date?: string | null;
	trailingSlash?: "always" | "never" | "ignore";
}): string {
	const path = interpolateUrlPattern(options);
	return options.trailingSlash === "always" && path !== "/" ? `${path}/` : path;
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
