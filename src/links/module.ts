/**
 * Link Manager: routes, hooks and scheduled jobs.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { ctxFeatures, requireFeature } from "../core/features.js";
import { parseInput } from "../shared.js";
import { BudgetExhausted, type Budget, checkUrl } from "./check.js";
import { type IgnoreRule, IgnoreRuleError, type LinkStatus, nextCheckAt, normalizeIgnore } from "./classify.js";
import { type LinkEdit, transformEntry } from "./pt.js";
import {
	IDLE_SCAN,
	IGNORES_KEY,
	type RefRow,
	type UrlRow,
	getIgnores,
	getScan,
	indexEntry,
	latestData,
	linkCollections,
	queryAll,
	reapplyIgnores,
	refs,
	removeEntry,
	scanStep,
	siteUrl,
	startScan,
	urls,
} from "./store.js";

/** No build-time options yet; settings live on the plugin's Settings page. */
// biome-ignore lint/complexity/noBannedTypes: reserved for future options.
export type LinksOptions = {};

export const LINKS_SCAN_TASK = "links-scan";
export const LINKS_CHECK_TASK = "links-check";
const PAGE_SIZE = 50;
const CONCURRENCY = 6;
const STATUSES: LinkStatus[] = ["unchecked", "ok", "redirect", "broken", "blocked", "error"];

export const linksSettingsSchema = {
	linksCheckBudget: {
		type: "number" as const,
		label: "Link Manager: requests per check run",
		description:
			"Link checks run every 5 minutes. Each run makes at most this many HTTP requests (a link takes 1–2, plus 1 per redirect). Workers allow 50 subrequests per run on the Free plan and 1,000 on Paid.",
		min: 5,
		max: 900,
		default: 40,
	},
	linksCheckInternal: {
		type: "boolean" as const,
		label: "Link Manager: check links to this site",
		description: "Also request internal links (they're always listed).",
		default: true,
	},
	linksUserAgent: {
		type: "string" as const,
		label: "Link Manager: User-Agent override",
		description: "Leave empty to present a current desktop Chrome, which avoids most false \"Blocked\" results.",
	},
};

// ── Helpers ──────────────────────────────────────────────────────

type Content = NonNullable<PluginContext["content"]>;
type WritableContent = Content & { update: NonNullable<Content["update"]> };

function writable(ctx: PluginContext): WritableContent {
	const content = ctx.content;
	if (!content?.update) throw PluginRouteError.badRequest("Link Manager needs the content:write capability.");
	return content as WritableContent;
}

function since(ms: number) {
	return Date.now() + ms;
}

// ── Checking ─────────────────────────────────────────────────────

export interface CheckRun {
	checked: number;
	byStatus: Partial<Record<LinkStatus, number>>;
	exhausted: boolean;
}

/** Check due links (or `ids`) within a request budget. */
export async function runChecks(ctx: PluginContext, options: { ids?: string[]; budget?: number } = {}): Promise<CheckRun> {
	const budget: Budget = { left: options.budget ?? (await ctx.settings.get<number>("linksCheckBudget")) ?? 40 };
	const checkInternal = (await ctx.settings.get<boolean>("linksCheckInternal")) ?? true;
	const userAgent = (await ctx.settings.get<string>("linksUserAgent")) ?? undefined;
	const now = Date.now();

	let candidates: Array<{ id: string; data: UrlRow }>;
	if (options.ids) {
		const found = await urls(ctx).getMany(options.ids);
		candidates = [...found].map(([id, data]) => ({ id, data }));
	} else {
		const page = await urls(ctx).query({
			where: { ignored: false, nextCheckAt: { lte: new Date(now).toISOString() } },
			orderBy: { nextCheckAt: "asc" },
			limit: 100,
		});
		candidates = page.items;
	}

	const run: CheckRun = { checked: 0, byStatus: {}, exhausted: false };
	const queue = [...candidates];
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			if (budget.left <= 0) {
				run.exhausted = true;
				return;
			}
			const { id, data } = next;
			const checkedAt = new Date().toISOString();
			if (!data.resolved || (data.internal && !checkInternal)) {
				await urls(ctx).put(id, {
					...data,
					note: data.resolved ? "Internal links aren't checked (see settings)." : "Can't be resolved to a web address.",
					nextCheckAt: nextCheckAt("ok", now),
				});
				continue;
			}
			try {
				const outcome = await checkUrl(new URL(data.resolved), budget, { userAgent });
				const current = (await urls(ctx).get(id)) ?? data;
				await urls(ctx).put(id, {
					...current,
					status: outcome.status,
					code: outcome.code || null,
					finalUrl: outcome.finalUrl,
					chain: outcome.chain.slice(0, 8),
					note: outcome.note.slice(0, 300),
					checkedAt,
					nextCheckAt: nextCheckAt(outcome.status, Date.now()),
				});
				run.checked++;
				run.byStatus[outcome.status] = (run.byStatus[outcome.status] ?? 0) + 1;
			} catch (error) {
				if (error instanceof BudgetExhausted) {
					run.exhausted = true;
					return;
				}
				ctx.log.warn("links: check failed", { url: data.url, error: String(error) });
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return run;
}

// ── Editing ──────────────────────────────────────────────────────

export interface EditResult {
	entries: number;
	links: number;
	published: number;
	staged: number;
	skipped: number;
	failed: Array<{ entry: string; error: string }>;
	/** Entry keys after `next` still to process; call again with `after: next`. */
	remaining: number;
	next: string | null;
}

const EDIT_BATCH = 20;

/**
 * Apply link edits to every entry that uses the given URLs. An entry with
 * unpublished changes is edited in its draft only; a published entry with no
 * pending draft is republished so the fix goes live.
 */
async function applyEdits(ctx: PluginContext, plan: Map<string, LinkEdit>, ids: string[], after: string | null): Promise<EditResult> {
	const content = writable(ctx);
	const collections = await linkCollections(ctx);
	const usage = await queryAll(refs(ctx), { urlId: { in: ids } });
	const keys = [...new Set(usage.map((r) => r.data.entryKey))].sort().filter((k) => !after || k > after);
	const batch = keys.slice(0, EDIT_BATCH);
	const result: EditResult = { entries: 0, links: 0, published: 0, staged: 0, skipped: 0, failed: [], remaining: keys.length - batch.length, next: null };

	for (const key of batch) {
		result.next = key;
		const slash = key.indexOf("/");
		const collection = key.slice(0, slash);
		const id = key.slice(slash + 1);
		try {
			const info = collections.get(collection);
			const item = await content.get(collection, id);
			if (!item || !info) {
				await removeEntry(ctx, collection, id);
				continue;
			}
			const hadDraft = Boolean(item.draftRevisionId);
			let data = await latestData(ctx, collection, item);
			const patch: Record<string, unknown> = {};
			let changed = 0;
			for (const [href, edit] of plan) {
				const step = transformEntry(data, info.fields, (h) => h === href, edit);
				changed += step.changed;
				result.skipped += step.skipped;
				Object.assign(patch, step.patch);
				data = { ...data, ...step.patch };
			}
			if (changed && Object.keys(patch).length) {
				await content.update(collection, id, patch);
				result.entries++;
				result.links += changed;
				if (info.revisions && item.status === "published") {
					if (!hadDraft && content.getVersioned && content.publish) {
						const versioned = await content.getVersioned(collection, id);
						if (versioned) {
							await content.publish(collection, id, { _rev: versioned._rev });
							result.published++;
						} else result.staged++;
					} else {
						result.staged++;
					}
				}
			}
			await indexEntry(ctx, collection, { ...item, data });
		} catch (error) {
			result.failed.push({ entry: key, error: String(error).slice(0, 200) });
			ctx.log.error("links: edit failed", { entry: key, error: String(error) });
		}
	}
	return result;
}

// ── Listing ──────────────────────────────────────────────────────

const listInput = z.object({
	status: z.enum(["all", "ignored", ...STATUSES] as [string, ...string[]]).optional(),
	scope: z.enum(["all", "internal", "external"]).optional(),
	host: z.string().max(253).optional(),
	q: z.string().max(500).optional(),
	page: z.number().int().min(1).max(10_000).optional(),
	sort: z.enum(["status", "url", "refs", "checked"]).optional(),
});

const STATUS_ORDER: Record<LinkStatus, number> = { broken: 0, error: 1, blocked: 2, redirect: 3, unchecked: 4, ok: 5 };

async function list(ctx: PluginContext, input: z.infer<typeof listInput>) {
	const rows = await queryAll(urls(ctx));
	const counts: Record<string, number> = { all: 0, ignored: 0, internal: 0, external: 0 };
	for (const s of STATUSES) counts[s] = 0;
	const hosts = new Map<string, number>();
	for (const { data } of rows) {
		if (data.ignored) {
			counts.ignored++;
			continue;
		}
		counts.all++;
		counts[data.status]++;
		counts[data.internal ? "internal" : "external"]++;
		if (data.host) hosts.set(data.host, (hosts.get(data.host) ?? 0) + 1);
	}

	const status = input.status ?? "all";
	const q = input.q?.trim().toLowerCase();
	const host = input.host?.trim().toLowerCase().replace(/^www\./, "");
	const filtered = rows.filter(({ data }) => {
		if (status === "ignored" ? !data.ignored : data.ignored) return false;
		if (status !== "all" && status !== "ignored" && data.status !== status) return false;
		if (input.scope === "internal" && !data.internal) return false;
		if (input.scope === "external" && data.internal) return false;
		if (host && data.host !== host && !data.host.endsWith(`.${host}`)) return false;
		if (q && !data.url.toLowerCase().includes(q) && !data.finalUrl?.toLowerCase().includes(q)) return false;
		return true;
	});
	const sort = input.sort ?? "status";
	filtered.sort((a, b) => {
		if (sort === "url") return a.data.url.localeCompare(b.data.url);
		if (sort === "refs") return b.data.refs - a.data.refs;
		if (sort === "checked") return (b.data.checkedAt ?? "").localeCompare(a.data.checkedAt ?? "");
		return STATUS_ORDER[a.data.status] - STATUS_ORDER[b.data.status] || a.data.url.localeCompare(b.data.url);
	});

	const page = input.page ?? 1;
	const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
	const ids = slice.map((r) => r.id);
	const usage = ids.length ? await queryAll(refs(ctx), { urlId: { in: ids } }) : [];
	const byUrl = new Map<string, RefRow[]>();
	for (const { data } of usage) byUrl.set(data.urlId, [...(byUrl.get(data.urlId) ?? []), data]);

	return {
		items: slice.map(({ id, data }) => ({
			id,
			...data,
			usedIn: (byUrl.get(id) ?? []).sort((a, b) => a.title.localeCompare(b.title)).map((r) => ({
				collection: r.collection,
				entryId: r.entryId,
				title: r.title,
				status: r.entryStatus,
				kinds: r.kinds,
				anchors: r.anchors,
				count: r.count,
			})),
		})),
		total: filtered.length,
		page,
		pageSize: PAGE_SIZE,
		counts,
		hosts: [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([name, count]) => ({ name, count })),
	};
}

async function summary(ctx: PluginContext) {
	const counts: Record<string, number> = {};
	for (const s of STATUSES) counts[s] = await urls(ctx).count({ ignored: false, status: s });
	return { counts, scan: (await getScan(ctx)) ?? IDLE_SCAN };
}

// ── Module ───────────────────────────────────────────────────────

const ids = z.array(z.string().regex(/^[0-9a-f]{24}$/)).min(1).max(500);
const targetUrl = z
	.string()
	.trim()
	.min(1, "Enter the new URL.")
	.max(2048)
	.refine((v) => /^(https?:\/\/|\/|#|mailto:|tel:)/i.test(v), "Use an http(s) URL, a path starting with /, mailto: or tel:.");

export function linksModule() {
	async function guard(ctx: PluginContext, feature = "links") {
		await requireFeature(ctx, feature);
		await siteUrl(ctx);
	}

	const routes = {
		"links/list": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(listInput, ctx.input ?? {});
				const features = await ctxFeatures(ctx);
				return {
					...(await list(ctx, input)),
					scan: (await getScan(ctx)) ?? IDLE_SCAN,
					checking: features["links.check"] ?? false,
					ignores: await getIgnores(ctx),
				};
			},
		}),

		"links/summary": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, "links");
				return summary(ctx);
			},
		},

		/** Start (or continue) a full scan; indexes for up to ~20 seconds per call. */
		"links/scan": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const { restart } = parseInput(z.object({ restart: z.boolean().optional() }), ctx.input ?? {});
				// Only start a scan when asked (or never scanned); otherwise continue one in progress.
				if (restart || !(await getScan(ctx))) await startScan(ctx);
				return scanStep(ctx, since(20_000));
			},
		}),

		"links/recheck": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx, "links.check");
				const input = parseInput(z.object({ ids: ids.optional() }), ctx.input ?? {});
				if (input.ids) {
					const found = await urls(ctx).getMany(input.ids);
					await urls(ctx).putMany([...found].map(([id, data]) => ({ id, data: { ...data, nextCheckAt: "" } })));
				}
				// Stay well inside a request's subrequest allowance.
				return runChecks(ctx, { ids: input.ids?.slice(0, 40), budget: 40 });
			},
		}),

		"links/replace": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(z.object({ ids, to: targetUrl, after: z.string().max(600).nullish() }), ctx.input);
				const found = await urls(ctx).getMany(input.ids);
				const plan = new Map<string, LinkEdit>();
				for (const row of found.values()) if (row.url !== input.to) plan.set(row.url, { type: "replace", to: input.to });
				if (!plan.size) return { entries: 0, links: 0, published: 0, staged: 0, skipped: 0, failed: [], remaining: 0, next: null };
				const result = await applyEdits(ctx, plan, input.ids, input.after ?? null);
				ctx.log.info("links: replaced", { from: [...plan.keys()].slice(0, 10), to: input.to, entries: result.entries });
				return result;
			},
		}),

		"links/unlink": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(z.object({ ids, after: z.string().max(600).nullish() }), ctx.input);
				const found = await urls(ctx).getMany(input.ids);
				const plan = new Map<string, LinkEdit>([...found.values()].map((row) => [row.url, { type: "unlink" }]));
				const result = await applyEdits(ctx, plan, input.ids, input.after ?? null);
				ctx.log.info("links: unlinked", { urls: [...plan.keys()].slice(0, 10), entries: result.entries });
				return result;
			},
		}),

		"links/ignore": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await guard(ctx);
				const input = parseInput(
					z.object({
						add: z.array(z.object({ type: z.enum(["domain", "url", "wildcard", "regex"]), value: z.string().max(1024) })).max(100).optional(),
						remove: z.array(z.string().max(64)).max(500).optional(),
					}),
					ctx.input,
				);
				let rules = await getIgnores(ctx);
				if (input.remove?.length) rules = rules.filter((r) => !input.remove?.includes(r.id));
				for (const rule of input.add ?? []) {
					let value: string;
					try {
						value = normalizeIgnore(rule.type, rule.value);
					} catch (error) {
						if (error instanceof IgnoreRuleError) throw PluginRouteError.badRequest(error.message);
						throw error;
					}
					if (rules.some((r) => r.type === rule.type && r.value === value)) continue;
					rules.push({ id: crypto.randomUUID().slice(0, 8), type: rule.type, value } satisfies IgnoreRule);
				}
				if (rules.length > 1000) throw PluginRouteError.badRequest("That's too many ignore rules (1,000 at most).");
				await ctx.kv.set(IGNORES_KEY, rules);
				const changed = await reapplyIgnores(ctx, rules);
				return { ignores: rules, changed };
			},
		}),
	};

	const hooks = {
		"content:afterSave": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			const c = event.content as { id?: string; slug?: string | null; status?: string; data?: Record<string, unknown> };
			if (!c.id || !c.data) return;
			await indexEntry(ctx, event.collection, { id: c.id, slug: c.slug, status: c.status, data: c.data });
		},
		"content:afterRestore": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			const c = event.content as { id?: string; slug?: string | null; status?: string; data?: Record<string, unknown> };
			if (!c.id || !c.data) return;
			await indexEntry(ctx, event.collection, { id: c.id, slug: c.slug, status: c.status, data: c.data });
		},
		"content:afterDelete": async (event: { id: string; collection: string }, ctx: PluginContext) => {
			await removeEntry(ctx, event.collection, event.id);
		},
	};

	/** Every 5 minutes: run the first full scan automatically, and continue any scan in progress. */
	async function scanTask(ctx: PluginContext) {
		const state = await getScan(ctx);
		if (!state) await startScan(ctx);
		else if (state.status !== "running") return;
		await scanStep(ctx, since(4 * 60_000));
	}

	async function checkTask(ctx: PluginContext) {
		await siteUrl(ctx);
		const run = await runChecks(ctx);
		if (run.checked) ctx.log.info("links: checked", run);
	}

	return { routes, hooks, scanTask, checkTask };
}
