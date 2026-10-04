/**
 * "Removed content" decisions (feature "redirects.trashPrompt"): the pure
 * parts, unit tested in Node. When a published entry is deleted or
 * unpublished, its former URL is recorded so an editor can redirect it,
 * mark it 410 Gone, or dismiss it.
 */
import { type CollectionInfo, interpolateUrlPattern } from "../core/content-url.js";

export type RemovalReason = "deleted" | "unpublished";

export interface PendingDecision {
	/** Storage id: "<collection>:<entry id>". */
	id: string;
	collection: string;
	entryId: string;
	/** Former public path (the site's `urls` override, or the collection's URL pattern). */
	url: string;
	title: string;
	reason: RemovalReason;
	locale: string | null;
	/** ISO time of the removal. */
	at: string;
}

/** The entry fields a decision needs, from a D1 row or a hook's content record. */
export interface EntrySnapshot {
	id: string;
	slug: string | null;
	status: string | null;
	publishedAt: string | null;
	locale: string | null;
	title: string | null;
}

export const pendingId = (collection: string, entryId: string) => `${collection}:${entryId}`;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Read a snapshot from an ec_* row (snake_case columns, title in the collection's title field). */
export function snapshotFromRow(row: Record<string, unknown>, titleField: string | null): EntrySnapshot {
	return {
		id: String(row.id),
		slug: str(row.slug),
		status: str(row.status),
		publishedAt: str(row.published_at),
		locale: str(row.locale),
		title: str(titleField ? row[titleField] : null) ?? str(row.title),
	};
}

/** Read a snapshot from a content hook's record (EmDash ContentItem: camelCase, fields under data). */
export function snapshotFromContent(content: Record<string, unknown>, titleField: string | null): EntrySnapshot {
	const data = (content.data ?? {}) as Record<string, unknown>;
	return {
		id: String(content.id),
		slug: str(content.slug),
		status: str(content.status),
		publishedAt: str(content.publishedAt),
		locale: str(content.locale),
		title: str(titleField ? data[titleField] : null) ?? str(data.title) ?? str(content.title),
	};
}

/**
 * Build the decision for a removed entry, or null when there's nothing to
 * decide: the entry never had a public URL (no slug, never published), or,
 * for deletes, it wasn't live when it was deleted.
 */
export function buildPending(
	collection: string,
	entry: EntrySnapshot,
	/** The former path when already resolved (core/content-url.ts entryUrl), else the collection's URL pattern. */
	info: { url?: string | null; urlPattern?: CollectionInfo["urlPattern"] } | undefined,
	reason: RemovalReason,
	now: Date = new Date(),
): PendingDecision | null {
	if (!entry.slug) return null;
	if (reason === "deleted" && entry.status !== "published") return null;
	if (reason === "unpublished" && !entry.publishedAt) return null;
	const url =
		info?.url ||
		interpolateUrlPattern({
			pattern: info?.urlPattern ?? null,
			collection,
			slug: entry.slug,
			id: entry.id,
			date: entry.publishedAt,
		});
	return {
		id: pendingId(collection, entry.id),
		collection,
		entryId: entry.id,
		url,
		title: entry.title ?? entry.slug,
		reason,
		locale: entry.locale,
		at: now.toISOString(),
	};
}
