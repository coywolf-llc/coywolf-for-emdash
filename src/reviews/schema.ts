/**
 * Review schema for a rendered page: the `coywolf-review` blocks in the
 * entry, plus any reviews the theme passes as `page.coywolf.reviews` (legacy
 * WordPress markers). Schema & Social folds them into its @graph
 * (attachPageReviews); with the graph off, the page:metadata hook here prints
 * standalone JSON-LD instead.
 */
import type { PageMetadataContribution, PageMetadataEvent, PluginContext } from "emdash";

import { cachedCtxFeatures, isOn } from "../core/features.js";
import { siteName } from "../core/site.js";
import { originOf, pageUrl } from "../schema/graph.js";
import { type Node, type Review, attachReviews, findReviewBlocks, normalizeReview, reviewDocuments } from "./lib.js";

type Page = PageMetadataEvent["page"];

const TTL_MS = 5 * 60_000;
const MAX_CACHED = 300;
/** Per-isolate cache of each entry's review blocks, keyed by entry and its modified time. */
const memo = new Map<string, { at: number; stamp: string; reviews: Review[] }>();

function themeReviews(page: Page): Review[] {
	const themed = (page as Page & { coywolf?: { reviews?: unknown } }).coywolf?.reviews;
	if (!Array.isArray(themed)) return [];
	return themed
		.slice(0, 20)
		.map(normalizeReview)
		.filter((r): r is Review => r !== null);
}

async function blockReviews(ctx: PluginContext, page: Page): Promise<Review[]> {
	if (!page.content || !ctx.content) return [];
	const key = `${page.content.collection}:${page.content.id}`;
	const stamp = page.articleMeta?.modifiedTime ?? "";
	const hit = memo.get(key);
	if (hit && hit.stamp === stamp && Date.now() - hit.at < TTL_MS) return hit.reviews;
	const entry = await ctx.content.get(page.content.collection, page.content.id);
	const reviews = findReviewBlocks(entry?.data ?? null)
		.map(normalizeReview)
		.filter((r): r is Review => r !== null);
	if (memo.size >= MAX_CACHED) memo.delete(memo.keys().next().value as string);
	memo.set(key, { at: Date.now(), stamp, reviews });
	return reviews;
}

/** The page's reviews: blocks first, then the theme's. */
export async function pageReviews(ctx: PluginContext, page: Page): Promise<Review[]> {
	const [blocks, themed] = [await blockReviews(ctx, page), themeReviews(page)];
	return [...blocks, ...themed];
}

/** Fold the page's reviews into Schema & Social's graph. Errors are logged, never fatal. */
export async function attachPageReviews(ctx: PluginContext, page: Page, graph: { "@graph": Node[] }, origin: string): Promise<void> {
	try {
		attachReviews(graph, await pageReviews(ctx, page), { origin });
	} catch (error) {
		ctx.log.warn("reviews: could not attach review schema", { error: String(error) });
	}
}

/** page:metadata (reviews.schema): standalone JSON-LD, only when Schema & Social's graph is off. */
export async function reviewsMetadata(event: PageMetadataEvent, ctx: PluginContext): Promise<PageMetadataContribution[] | null> {
	if (isOn(await cachedCtxFeatures(ctx), "schema.graph")) return null;
	const page = event.page;
	const reviews = await pageReviews(ctx, page);
	if (!reviews.length) return null;
	const origin = originOf(page.siteUrl || ctx.site.url || page.url);
	const docs = reviewDocuments(reviews, {
		pageUrl: pageUrl(page),
		origin,
		siteName: page.siteName || (await siteName(ctx)),
		authorName: page.articleMeta?.author,
		datePublished: page.articleMeta?.publishedTime,
	});
	return docs.map((graph, i) => ({ kind: "jsonld" as const, id: `coywolf-review-${i + 1}`, graph }));
}
