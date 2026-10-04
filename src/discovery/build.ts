/**
 * Builds llms.txt, the news sitemap, and per-entry Markdown from EmDash
 * content (inside the plugin context), with KV caching for the two lists.
 */
import { type CollectionSchemaInfo, type PluginContentItem, type PluginContext, after, getEmDashEntry, getSiteSetting, resolveEmDashPath } from "emdash";

import { buildLlmsTxt, type LlmsSection } from "./llms.js";
import { estimateTokens, frontmatter, markdownUrl, portableTextToMarkdown } from "./markdown.js";
import { NEWS_LIMIT, NEWS_WINDOW_MS, buildNewsSitemap, parseDate, selectNewsArticles, type NewsArticle } from "./news.js";
import { type DiscoverySettings, loadSettings, selected } from "./settings.js";
import { createUrlResolver, siteOrigin } from "./urls.js";

export const LLMS_CACHE = "cache:discovery:llms";
export const NEWS_CACHE = "cache:discovery:news";
/** The news sitemap's 48-hour window moves, so its cache is short. */
export const NEWS_TTL_MS = 5 * 60_000;
/** llms.txt is invalidated on content changes; this is only a safety net. */
export const LLMS_TTL_MS = 24 * 60 * 60_000;

export interface CachedDocument {
	body: string;
	count: number;
	builtAt: string;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export function entryTitle(collection: CollectionSchemaInfo, item: PluginContentItem): string {
	return str(item.data[collection.titleField ?? "title"]) || str(item.data.title) || item.slug || item.id;
}

function entryNote(item: PluginContentItem): string {
	return str(item.data.excerpt).trim() || str(item.seo?.description).trim();
}

/** Routable collections in the selection. Hidden collections are listed only when picked explicitly. */
export async function pickCollections(ctx: PluginContext, selection: string[]): Promise<CollectionSchemaInfo[]> {
	const all = (await ctx.schema?.listCollections()) ?? [];
	return all.filter((c) => c.routable && (selection.length ? selection.includes(c.slug) : !c.hidden));
}

/** Published entries of a collection, newest first. `stop` ends the walk early. */
async function* published(ctx: PluginContext, collection: string, max: number, stop?: (item: PluginContentItem) => boolean) {
	if (!ctx.content || max <= 0) return;
	let cursor: string | undefined;
	let count = 0;
	do {
		const page = await ctx.content.list(collection, { limit: 100, cursor, orderBy: { publishedAt: "desc" }, where: { status: "published" } });
		for (const item of page.items) {
			if (stop?.(item)) return;
			yield item;
			if (++count >= max) return;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
}

// ── llms.txt ─────────────────────────────────────────────────────

export async function buildLlms(ctx: PluginContext, settings: DiscoverySettings): Promise<CachedDocument> {
	const resolver = createUrlResolver(ctx);
	const max = settings.llms.maxEntries;
	const sections: LlmsSection[] = [];
	let remaining = max;
	for (const collection of await pickCollections(ctx, settings.llms.collections)) {
		if (remaining <= 0) break;
		const entries: LlmsSection["entries"] = [];
		for await (const item of published(ctx, collection.slug, remaining)) {
			if (item.seo?.noIndex) continue;
			const url = await resolver.url(collection, item);
			if (!url) continue;
			entries.push({ title: entryTitle(collection, item), url: settings.llms.markdown ? markdownUrl(url) : url, note: entryNote(item) });
		}
		remaining -= entries.length;
		if (entries.length) sections.push({ label: collection.label, entries });
	}
	const tagline = await getSiteSetting("tagline").catch(() => undefined);
	const body = buildLlmsTxt({
		name: ctx.site.name,
		siteUrl: siteOrigin(ctx),
		summary: settings.llms.summary || tagline,
		intro: settings.llms.intro,
		markdownLinks: settings.llms.markdown,
		sections,
		maxEntries: max,
	});
	return { body, count: sections.reduce((n, s) => n + s.entries.length, 0), builtAt: new Date().toISOString() };
}

// ── News sitemap ─────────────────────────────────────────────────

export async function buildNews(ctx: PluginContext, settings: DiscoverySettings, now = Date.now()): Promise<CachedDocument> {
	const resolver = createUrlResolver(ctx);
	const articles: NewsArticle[] = [];
	const tooOld = (item: PluginContentItem) => (parseDate(item.publishedAt)?.getTime() ?? 0) <= now - NEWS_WINDOW_MS;
	// An empty news selection lists nothing (unlike llms.txt, where empty means all).
	const collections = settings.news.collections.length ? await pickCollections(ctx, settings.news.collections) : [];
	for (const collection of collections) {
		for await (const item of published(ctx, collection.slug, NEWS_LIMIT, tooOld)) {
			if (item.seo?.noIndex || !item.publishedAt) continue;
			const url = await resolver.url(collection, item);
			if (url) articles.push({ url, title: entryTitle(collection, item), publishedAt: item.publishedAt });
		}
	}
	const selectedArticles = selectNewsArticles(articles, now);
	const body = buildNewsSitemap(selectedArticles, {
		name: settings.news.publicationName || ctx.site.name || new URL(ctx.site.url).host,
		language: settings.news.language || ctx.site.locale,
	});
	return { body, count: selectedArticles.length, builtAt: new Date(now).toISOString() };
}

// ── Caching (stale-while-revalidate) ─────────────────────────────
//
// Visitor requests only read the last good copy from plugin KV. Content
// hooks, settings saves and stale reads schedule a rebuild with after(),
// debounced per isolate, which overwrites the copy when it's done. The one
// exception is a cold start (nothing stored yet), which builds inline once.

export type DocKind = "llms" | "news";
const DOC_KEY: Record<DocKind, string> = { llms: LLMS_CACHE, news: NEWS_CACHE };
const DOC_TTL: Record<DocKind, number> = { llms: LLMS_TTL_MS, news: NEWS_TTL_MS };
/** Wait this long after a change for more changes before rebuilding. */
const REBUILD_DEBOUNCE_MS = 5000;

async function buildDoc(ctx: PluginContext, kind: DocKind): Promise<CachedDocument> {
	const settings = await loadSettings(ctx);
	const doc = kind === "llms" ? await buildLlms(ctx, settings) : await buildNews(ctx, settings);
	await ctx.kv.set(DOC_KEY[kind], doc);
	return doc;
}

const pendingRebuild = new Set<DocKind>();
let rebuildScheduled = false;
const coldBuilds = new Map<DocKind, Promise<CachedDocument>>();

/** Rebuild these documents in the background, after the response (debounced). */
export function scheduleRebuild(ctx: PluginContext, kinds: DocKind[], delayMs = REBUILD_DEBOUNCE_MS): void {
	for (const kind of kinds) pendingRebuild.add(kind);
	if (rebuildScheduled || !pendingRebuild.size) return;
	rebuildScheduled = true;
	after(async () => {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		const kinds = [...pendingRebuild];
		pendingRebuild.clear();
		rebuildScheduled = false;
		for (const kind of kinds) {
			try {
				await buildDoc(ctx, kind);
			} catch (error) {
				ctx.log.error(`Discovery: rebuilding ${kind} failed`, { error: String(error) });
			}
		}
	});
}

/** The stored document; a stale one is served while a rebuild is scheduled. */
export async function readDoc(ctx: PluginContext, kind: DocKind): Promise<CachedDocument> {
	const hit = await ctx.kv.get<CachedDocument>(DOC_KEY[kind]);
	if (hit?.body) {
		if (Date.now() - Date.parse(hit.builtAt) >= DOC_TTL[kind]) scheduleRebuild(ctx, [kind], 0);
		return hit;
	}
	let cold = coldBuilds.get(kind);
	if (!cold) {
		cold = buildDoc(ctx, kind).finally(() => coldBuilds.delete(kind));
		coldBuilds.set(kind, cold);
	}
	return cold;
}

/** Rebuild now (admin "Rebuild now"). */
export async function rebuildNow(ctx: PluginContext, kind: DocKind): Promise<CachedDocument> {
	return buildDoc(ctx, kind);
}

// ── Per-entry Markdown ───────────────────────────────────────────

export interface MarkdownDocument {
	body: string;
	tokens: number;
	pageUrl: string;
	markdownUrl: string;
}

const safeDecode = (path: string) => {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
};
const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * Find the published entry a site path belongs to, using EmDash's own
 * routing: resolveEmDashPath() for collections with a url_pattern, the
 * default /{collection}/{slug} otherwise, and then a check that
 * getPublicUrl() for the match is this exact path.
 */
async function resolveEntry(ctx: PluginContext, pagePath: string): Promise<{ collection: CollectionSchemaInfo; id: string; url: string } | null> {
	const path = trimSlash(pagePath);
	const decoded = safeDecode(path);
	let found: { collection: string; id: string } | null = null;
	for (const candidate of new Set([decoded, `${decoded}/`])) {
		const match = await resolveEmDashPath(candidate).catch(() => null);
		if (match) {
			found = { collection: match.collection, id: str((match.entry.data as Record<string, unknown>).id) || match.entry.id };
			break;
		}
	}
	if (!found) {
		const segments = decoded.split("/").filter(Boolean);
		if (segments.length === 2) {
			const info = await ctx.schema?.getCollection(segments[0]);
			if (info?.routable && !info.urlPattern) {
				const { entry } = await getEmDashEntry(segments[0], segments[1]).catch(() => ({ entry: null }));
				if (entry) found = { collection: segments[0], id: str((entry.data as Record<string, unknown>).id) || entry.id };
			}
		}
	}
	if (!found) return null;
	const collection = await ctx.schema?.getCollection(found.collection);
	const url = await ctx.content?.getPublicUrl?.(found.collection, found.id);
	if (!collection || !url || safeDecode(trimSlash(new URL(url).pathname)) !== decoded) return null;
	return { collection, id: found.id, url };
}

export async function buildMarkdown(ctx: PluginContext, settings: DiscoverySettings, pagePath: string): Promise<MarkdownDocument | null> {
	if (!settings.llms.markdown) return null;
	const resolved = await resolveEntry(ctx, pagePath);
	if (!resolved || !selected(settings.llms.collections, resolved.collection.slug)) return null;
	if (!settings.llms.collections.length && resolved.collection.hidden) return null;
	const item = await ctx.content?.get(resolved.collection.slug, resolved.id);
	if (!item || item.status !== "published" || item.seo?.noIndex) return null;

	const origin = siteOrigin(ctx);
	const absolute = (href: string) => {
		if (href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
		try {
			return new URL(href, `${origin}/`).href;
		} catch {
			return href;
		}
	};
	const body = resolved.collection.fields
		.filter((f) => f.type === "portableText")
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.map((f) => portableTextToMarkdown(item.data[f.slug], { absolute }))
		.filter(Boolean)
		.join("\n\n");

	const markdown = `${frontmatter({
		title: entryTitle(resolved.collection, item),
		url: resolved.url,
		published: item.publishedAt ? (parseDate(item.publishedAt)?.toISOString() ?? undefined) : undefined,
		updated: parseDate(item.updatedAt)?.toISOString() ?? undefined,
		sources: [resolved.url],
		license: settings.llms.license || undefined,
	})}\n${body}\n`;
	return { body: markdown, tokens: estimateTokens(markdown), pageUrl: resolved.url, markdownUrl: markdownUrl(resolved.url) };
}
