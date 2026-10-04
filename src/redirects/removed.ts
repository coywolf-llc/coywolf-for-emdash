/**
 * "Removed content" (feature "redirects.trashPrompt"): when a published entry
 * is deleted or unpublished, record its former URL as a pending decision in
 * plugin storage. The Redirects admin page lists them with Redirect to…,
 * Return 410 Gone, and Dismiss. Republishing or restoring the entry clears it.
 */
import type { PluginContext } from "emdash";
import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { COLLECTION_SLUG, entryUrl, readCollections } from "../core/content-url.js";
import { requireFeature } from "../core/features.js";
import { parseInput, workerEnv } from "../shared.js";
import { invalidateRedirectCache } from "./middleware.js";
import {
	type EntrySnapshot,
	type PendingDecision,
	type RemovalReason,
	buildPending,
	pendingId,
	snapshotFromContent,
	snapshotFromRow,
} from "./removed-core.js";
import { RedirectValidationError, saveRule } from "./rules.js";

export const TRASH_PROMPT_FEATURE = "redirects.trashPrompt";
const STORE = "redirects_removed";

export const removedStorage = { [STORE]: { indexes: ["at"] } };

interface Options {
	database?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: plugin storage collections are untyped here.
const store = (ctx: PluginContext) => (ctx.storage as Record<string, any>)[STORE] as {
	get(id: string): Promise<PendingDecision | null>;
	put(id: string, data: PendingDecision): Promise<void>;
	delete(id: string): Promise<boolean>;
	query(o: { orderBy?: Record<string, "asc" | "desc">; limit?: number }): Promise<{ items: Array<{ id: string; data: PendingDecision }> }>;
};

/** A snapshot plus its former path, resolved while the row and its terms still exist. */
interface Taken {
	entry: EntrySnapshot;
	urlPattern: string | null;
	url: string | null;
}

/** Snapshots taken in content:beforeDelete, while the row still exists (a permanent delete removes it). */
const beforeDelete = new Map<string, Taken>();

export function removedModule(options: Options) {
	async function db(): Promise<D1Database | undefined> {
		try {
			return (await workerEnv())[options.database ?? "DB"] as D1Database | undefined;
		} catch {
			return undefined;
		}
	}

	async function snapshot(collection: string, id: string) {
		const d1 = await db();
		if (!d1 || !COLLECTION_SLUG.test(collection)) return null;
		const info = (await readCollections(d1, [collection])).get(collection);
		const row = await d1.prepare(`SELECT * FROM "ec_${collection}" WHERE id = ?`).bind(id).first<Record<string, unknown>>();
		if (!row) return null;
		const entry = snapshotFromRow(row, info?.titleField ?? null);
		return { entry, urlPattern: info?.urlPattern ?? null, url: await formerUrl(d1, collection, entry) };
	}

	/** The entry's public path via the pack-wide resolver (honors the site's `urls` overrides). */
	async function formerUrl(d1: D1Database, collection: string, entry: EntrySnapshot): Promise<string | null> {
		if (!entry.slug) return null;
		return entryUrl(d1, collection, { id: entry.id, slug: entry.slug, publishedAt: entry.publishedAt, locale: entry.locale }).catch(() => null);
	}

	async function record(ctx: PluginContext, collection: string, reason: RemovalReason, taken: Taken | null) {
		if (!taken) return;
		const pending = buildPending(collection, taken.entry, { url: taken.url, urlPattern: taken.urlPattern }, reason);
		if (!pending) return;
		const existing = await store(ctx).get(pending.id);
		if (existing) return; // Keep the first record (e.g. trashed, then permanently deleted).
		await store(ctx).put(pending.id, pending);
		ctx.log.info("Removed content recorded", { url: pending.url, reason });
	}

	const hooks = {
		"content:beforeDelete": async (event: { id: string; collection: string }) => {
			try {
				const taken = await snapshot(event.collection, event.id);
				if (beforeDelete.size > 500) beforeDelete.clear(); // Deletes that never completed.
				if (taken) beforeDelete.set(pendingId(event.collection, event.id), taken);
			} catch {
				// Never block a delete.
			}
			return undefined;
		},

		"content:afterDelete": async (event: { id: string; collection: string; permanent: boolean }, ctx: PluginContext) => {
			const key = pendingId(event.collection, event.id);
			const taken = beforeDelete.get(key) ?? (await snapshot(event.collection, event.id));
			beforeDelete.delete(key);
			await record(ctx, event.collection, "deleted", taken);
		},

		"content:afterUnpublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			const d1 = await db();
			const info = d1 ? (await readCollections(d1, [event.collection])).get(event.collection) : undefined;
			const entry = snapshotFromContent(event.content, info?.titleField ?? null);
			await record(ctx, event.collection, "unpublished", {
				entry,
				urlPattern: info?.urlPattern ?? null,
				url: d1 ? await formerUrl(d1, event.collection, entry) : null,
			});
		},

		"content:afterPublish": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			await store(ctx).delete(pendingId(event.collection, String(event.content.id)));
		},

		// Restored entries come back as drafts; restoring says the content is coming back, so drop the decision.
		"content:afterRestore": async (event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) => {
			await store(ctx).delete(pendingId(event.collection, String(event.content.id)));
		},
	};

	const routes = {
		"redirects/removed": {
			permission: "plugins:manage" as const,
			handler: async (ctx: PluginContext) => {
				await requireFeature(ctx, TRASH_PROMPT_FEATURE);
				const { items } = await store(ctx).query({ orderBy: { at: "desc" }, limit: 100 });
				return { items: items.map((i) => i.data) };
			},
		},

		"redirects/removed/resolve": definePluginRoute({
			permission: "plugins:manage",
			methods: ["POST"],
			request: { body: "json" },
			handler: async (ctx) => {
				await requireFeature(ctx, TRASH_PROMPT_FEATURE);
				const input = parseInput(
					z.object({
						id: z.string().max(300),
						action: z.enum(["redirect", "gone", "dismiss"]),
						target: z.string().max(2000).optional(),
						type: z.number().int().optional(),
					}),
					ctx.input,
				);
				const pending = await store(ctx).get(input.id);
				if (!pending) throw PluginRouteError.notFound("That removed entry is no longer pending.");
				let rule = null;
				if (input.action !== "dismiss") {
					const d1 = await db();
					if (!d1) throw PluginRouteError.badRequest("Redirects: missing database binding.");
					try {
						rule = await saveRule(d1, {
							source: pending.url,
							target: input.action === "gone" ? "" : input.target,
							type: input.action === "gone" ? 410 : (input.type ?? 301),
							note: `Removed: ${pending.title}`.slice(0, 500),
						});
					} catch (error) {
						if (error instanceof RedirectValidationError) throw PluginRouteError.badRequest(error.message);
						throw error;
					}
					invalidateRedirectCache();
				}
				await store(ctx).delete(pending.id);
				ctx.log.info("Removed content resolved", { url: pending.url, action: input.action });
				return { resolved: pending.id, rule };
			},
		}),
	};

	return { hooks, routes, storage: removedStorage };
}
