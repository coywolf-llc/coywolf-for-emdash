/**
 * The link inventory in plugin storage.
 *
 * - links_urls: one row per distinct href (id = hash of the href as written),
 *   with its check result, schedule, ignore flag and how many entries use it.
 * - links_refs: one row per (entry, href) with the entry's title and the
 *   link's anchor text and kinds, so the admin can say where a link is used.
 *
 * Entries are indexed from their latest saved version (the pending draft when
 * a collection uses revisions), which is what an editor fixing a link sees.
 */
import type { CollectionSchemaInfo, PluginContext, StorageCollection } from "emdash";

import { type IgnoreRule, type LinkStatus, isIgnored } from "./classify.js";
import { type FoundLink, type LinkKind, bareHost, extractEntryLinks, isInternal, resolveHref } from "./pt.js";

export const STORAGE = {
	links_urls: {
		indexes: ["status", "host", "internal", "refs", ["ignored", "status"], ["ignored", "nextCheckAt"]],
	},
	links_refs: {
		indexes: ["urlId", "entryKey", "seenAt"],
	},
};

export interface UrlRow {
	url: string;
	/** Absolute URL that gets checked; null when the href can't be resolved. */
	resolved: string | null;
	host: string;
	internal: boolean;
	ignored: boolean;
	status: LinkStatus;
	code: number | null;
	finalUrl: string | null;
	chain: Array<{ url: string; code: number }>;
	note: string;
	checkedAt: string | null;
	/** "" until first checked, so unchecked links sort first. */
	nextCheckAt: string;
	refs: number;
	firstSeen: string;
}

export interface RefRow {
	urlId: string;
	entryKey: string;
	collection: string;
	entryId: string;
	title: string;
	entryStatus: string;
	kinds: LinkKind[];
	anchors: string[];
	count: number;
	seenAt: string;
}

export const IGNORES_KEY = "links:ignores";
export const SCAN_KEY = "links:scan";

/** Field types that can hold links. */
const LINK_FIELD_TYPES = new Set(["portableText", "blocks", "repeater", "url"]);

export function urls(ctx: PluginContext): StorageCollection<UrlRow> {
	return ctx.storage.links_urls as StorageCollection<UrlRow>;
}
export function refs(ctx: PluginContext): StorageCollection<RefRow> {
	return ctx.storage.links_refs as StorageCollection<RefRow>;
}

export async function urlId(href: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(href)));
	return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every row matching `where`, page by page. */
export async function queryAll<T>(
	collection: StorageCollection<T>,
	where?: Record<string, unknown>,
	max = 50_000,
): Promise<Array<{ id: string; data: T }>> {
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	do {
		// biome-ignore lint/suspicious/noExplicitAny: WhereClause is EmDash's.
		const page = await collection.query({ where: where as any, limit: 100, cursor });
		out.push(...page.items);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && out.length < max);
	return out;
}

const SITE_URL_KEY = "links:siteUrl";

/** ctx.site.url can be empty outside a request (cron); remember the last one a request saw. */
export async function siteUrl(ctx: PluginContext): Promise<string> {
	if (ctx.site.url) {
		const known = await ctx.kv.get<string>(SITE_URL_KEY);
		if (known !== ctx.site.url) await ctx.kv.set(SITE_URL_KEY, ctx.site.url);
		return ctx.site.url;
	}
	return (await ctx.kv.get<string>(SITE_URL_KEY)) ?? "";
}

export async function getIgnores(ctx: PluginContext): Promise<IgnoreRule[]> {
	return (await ctx.kv.get<IgnoreRule[]>(IGNORES_KEY)) ?? [];
}

// ── Schema ───────────────────────────────────────────────────────

export interface CollectionLinkInfo {
	slug: string;
	label: string;
	titleField: string | null;
	revisions: boolean;
	fields: Array<{ slug: string; type: string }>;
}

let schemaCache: { at: number; map: Map<string, CollectionLinkInfo> } | null = null;

/** Collections with link-bearing fields (cached per isolate for a minute). */
export async function linkCollections(ctx: PluginContext): Promise<Map<string, CollectionLinkInfo>> {
	if (schemaCache && Date.now() - schemaCache.at < 60_000) return schemaCache.map;
	const map = new Map<string, CollectionLinkInfo>();
	const collections: CollectionSchemaInfo[] = (await ctx.schema?.listCollections()) ?? [];
	for (const c of collections) {
		const fields = c.fields.filter((f) => LINK_FIELD_TYPES.has(f.type)).map((f) => ({ slug: f.slug, type: f.type }));
		if (!fields.length) continue;
		map.set(c.slug, {
			slug: c.slug,
			label: c.label,
			titleField: c.titleField,
			revisions: c.supports.includes("revisions"),
			fields,
		});
	}
	schemaCache = { at: Date.now(), map };
	return map;
}

// ── Indexing ─────────────────────────────────────────────────────

export const entryKey = (collection: string, id: string) => `${collection}/${id}`;

function entryTitle(info: CollectionLinkInfo, item: { data: Record<string, unknown>; slug?: string | null; id: string }): string {
	const candidates = [info.titleField ? item.data[info.titleField] : undefined, item.data.title, item.data.name, item.slug, item.id];
	const title = candidates.find((v) => typeof v === "string" && v.trim()) as string;
	return title.trim().slice(0, 200);
}

/** The entry's latest saved data: its pending draft when it has one. */
export async function latestData(
	ctx: PluginContext,
	collection: string,
	item: { id: string; data: Record<string, unknown>; draftRevisionId?: string | null },
): Promise<Record<string, unknown>> {
	if (item.draftRevisionId && ctx.content?.getRevision) {
		try {
			const draft = await ctx.content.getRevision(collection, item.id, item.draftRevisionId);
			if (draft?.data) return { ...item.data, ...draft.data };
		} catch (error) {
			ctx.log.warn("links: could not read draft revision", { collection, id: item.id, error: String(error) });
		}
	}
	return item.data;
}

function group(found: FoundLink[]): Map<string, { kinds: Set<LinkKind>; anchors: Set<string>; count: number }> {
	const map = new Map<string, { kinds: Set<LinkKind>; anchors: Set<string>; count: number }>();
	for (const link of found) {
		const g = map.get(link.href) ?? { kinds: new Set(), anchors: new Set(), count: 0 };
		g.kinds.add(link.kind);
		if (link.anchor && g.anchors.size < 3) g.anchors.add(link.anchor);
		g.count++;
		map.set(link.href, g);
	}
	return map;
}

function newUrlRow(href: string, siteUrl: string, ignores: IgnoreRule[], now: string): UrlRow {
	const resolved = resolveHref(href, siteUrl);
	return {
		url: href,
		resolved: resolved?.href ?? null,
		host: resolved ? bareHost(resolved.hostname) : "",
		internal: isInternal(href, siteUrl),
		ignored: resolved ? isIgnored(ignores, resolved.href) : false,
		status: "unchecked",
		code: null,
		finalUrl: null,
		chain: [],
		note: "",
		checkedAt: null,
		nextCheckAt: "",
		refs: 0,
		firstSeen: now,
	};
}

async function adjustRefs(ctx: PluginContext, ids: string[], delta: 1 | -1): Promise<void> {
	for (const id of ids) {
		const result = await urls(ctx).updateIf(id, { where: {}, delta: { refs: delta > 0 ? { inc: 1 } : { dec: 1 } } });
		if (delta < 0 && result.applied && result.data.refs <= 0) await urls(ctx).delete(id);
	}
}

/** Replace an entry's link references with the links in `data`. */
export async function indexEntry(
	ctx: PluginContext,
	collection: string,
	item: { id: string; slug?: string | null; status?: string; data: Record<string, unknown> },
	options: { ignores?: IgnoreRule[]; siteUrl?: string } = {},
): Promise<number> {
	const info = (await linkCollections(ctx)).get(collection);
	if (!info) return removeEntry(ctx, collection, item.id).then(() => 0);
	const key = entryKey(collection, item.id);
	const grouped = group(extractEntryLinks(item.data, info.fields));
	const now = new Date().toISOString();
	const title = entryTitle(info, item);

	const next = new Map<string, RefRow>();
	for (const [href, g] of grouped) {
		next.set(await urlId(href), {
			urlId: "",
			entryKey: key,
			collection,
			entryId: item.id,
			title,
			entryStatus: item.status ?? "",
			kinds: [...g.kinds],
			anchors: [...g.anchors],
			count: g.count,
			seenAt: now,
		});
	}
	const hrefById = new Map<string, string>();
	for (const [href] of grouped) hrefById.set(await urlId(href), href);

	const existing = await queryAll(refs(ctx), { entryKey: key });
	const oldIds = new Set(existing.map((r) => r.data.urlId));
	const removed = [...oldIds].filter((id) => !next.has(id));
	const added = [...next.keys()].filter((id) => !oldIds.has(id));

	if (removed.length) await refs(ctx).deleteMany(removed.map((id) => `${key}|${id}`));
	if (next.size) await refs(ctx).putMany([...next].map(([id, row]) => ({ id: `${key}|${id}`, data: { ...row, urlId: id } })));

	if (added.length) {
		const have = await urls(ctx).getMany(added);
		const missing = added.filter((id) => !have.has(id));
		if (missing.length) {
			const ignores = options.ignores ?? (await getIgnores(ctx));
			const base = options.siteUrl ?? (await siteUrl(ctx));
			await urls(ctx).putMany(missing.map((id) => ({ id, data: newUrlRow(hrefById.get(id) as string, base, ignores, now) })));
		}
		await adjustRefs(ctx, added, 1);
	}
	if (removed.length) await adjustRefs(ctx, removed, -1);
	return next.size;
}

export async function removeEntry(ctx: PluginContext, collection: string, id: string): Promise<void> {
	const key = entryKey(collection, id);
	const existing = await queryAll(refs(ctx), { entryKey: key });
	if (!existing.length) return;
	await refs(ctx).deleteMany(existing.map((r) => r.id));
	await adjustRefs(
		ctx,
		existing.map((r) => r.data.urlId),
		-1,
	);
}

// ── Full scan ────────────────────────────────────────────────────

export interface ScanState {
	status: "idle" | "running";
	startedAt: string | null;
	finishedAt: string | null;
	collections: string[];
	index: number;
	cursor: string | null;
	processed: number;
	error?: string;
}

export const IDLE_SCAN: ScanState = { status: "idle", startedAt: null, finishedAt: null, collections: [], index: 0, cursor: null, processed: 0 };

export async function getScan(ctx: PluginContext): Promise<ScanState | null> {
	return ctx.kv.get<ScanState>(SCAN_KEY);
}

export async function startScan(ctx: PluginContext): Promise<ScanState> {
	const state: ScanState = {
		status: "running",
		startedAt: new Date().toISOString(),
		finishedAt: null,
		collections: [...(await linkCollections(ctx)).keys()],
		index: 0,
		cursor: null,
		processed: 0,
	};
	await ctx.kv.set(SCAN_KEY, state);
	return state;
}

/** Index entries until `deadline` (epoch ms). Finishes the scan, dropping references not seen, when every collection is done. */
export async function scanStep(ctx: PluginContext, deadline: number): Promise<ScanState> {
	const state = (await getScan(ctx)) ?? IDLE_SCAN;
	if (state.status !== "running" || !ctx.content) return state;
	const ignores = await getIgnores(ctx);
	const base = await siteUrl(ctx);
	try {
		while (Date.now() < deadline && state.index < state.collections.length) {
			const collection = state.collections[state.index];
			let page: Awaited<ReturnType<NonNullable<PluginContext["content"]>["list"]>>;
			try {
				page = await ctx.content.list(collection, { limit: 25, cursor: state.cursor ?? undefined });
			} catch (error) {
				// Skip a collection that can't be listed (e.g. removed mid-scan) instead of retrying it forever.
				ctx.log.warn("links: could not list collection", { collection, error: String(error) });
				state.index++;
				state.cursor = null;
				continue;
			}
			for (const item of page.items) {
				await indexEntry(ctx, collection, { ...item, data: await latestData(ctx, collection, item) }, { ignores, siteUrl: base });
				state.processed++;
			}
			if (page.hasMore && page.cursor) state.cursor = page.cursor;
			else {
				state.index++;
				state.cursor = null;
			}
			await ctx.kv.set(SCAN_KEY, state);
		}
		if (state.index >= state.collections.length) {
			// References not refreshed by this scan belong to entries that no longer exist.
			const stale = await queryAll(refs(ctx), { seenAt: { lt: state.startedAt ?? new Date().toISOString() } });
			if (stale.length) {
				await refs(ctx).deleteMany(stale.map((r) => r.id));
				await adjustRefs(
					ctx,
					stale.map((r) => r.data.urlId),
					-1,
				);
			}
			Object.assign(state, { status: "idle", finishedAt: new Date().toISOString(), cursor: null });
			delete state.error;
			await ctx.kv.set(SCAN_KEY, state);
			ctx.log.info("links: scan finished", { entries: state.processed });
		}
	} catch (error) {
		state.error = String(error).slice(0, 300);
		await ctx.kv.set(SCAN_KEY, state);
		throw error;
	}
	return state;
}

// ── Ignore flags ─────────────────────────────────────────────────

/** Recompute every URL's ignore flag after the rules change. */
export async function reapplyIgnores(ctx: PluginContext, rules: IgnoreRule[]): Promise<number> {
	let changed = 0;
	const rows = await queryAll(urls(ctx));
	const updates: Array<{ id: string; data: UrlRow }> = [];
	for (const row of rows) {
		const ignored = row.data.resolved ? isIgnored(rules, row.data.resolved) : false;
		if (ignored !== row.data.ignored) {
			updates.push({ id: row.id, data: { ...row.data, ignored } });
			changed++;
		}
	}
	for (let i = 0; i < updates.length; i += 100) await urls(ctx).putMany(updates.slice(i, i + 100));
	return changed;
}
