// The pure parts of scripts/video-show-migrate.mjs, so they can be tested.
// Import this after test/ts-resolve.mjs has been registered (it loads the
// pack's TypeScript sources).

const { BLOCK_TYPE, normalizeVideoShows } = await import("../src/videos/lib.ts");

/** How many coywolf-video blocks a content value holds (any depth, like normalizeVideoShows). */
export function countVideoBlocks(value) {
	let count = 0;
	const visit = (node, depth) => {
		if (depth > 12 || node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1);
			return;
		}
		if (node._type === BLOCK_TYPE) {
			count++;
			return;
		}
		for (const child of Object.values(node)) visit(child, depth + 1);
	};
	visit(value, 0);
	return count;
}

/** A published entry whose draft revision isn't the live one has edits waiting. */
export function hasPendingDraft(item) {
	return Boolean(item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId);
}

/**
 * What the migration would do to one entry (as the content API returned it,
 * with draft data hydrated): the content fields to rewrite, how many blocks
 * change, and the action: "publish" (save + publish), "draft" (save to the
 * draft only), "skip" (published with a pending draft) or "none".
 */
export function planEntry(item, followSiteDefaults) {
	const changes = {};
	let blocks = 0;
	let videos = 0;
	for (const [field, value] of Object.entries(item.data ?? {})) {
		videos += countVideoBlocks(value);
		const out = normalizeVideoShows(value, followSiteDefaults);
		if (out.changed) {
			changes[field] = out.value;
			blocks += out.changed;
		}
	}
	const pendingDraft = hasPendingDraft(item);
	let action = "none";
	if (blocks) action = item.status === "published" ? (pendingDraft ? "skip" : "publish") : "draft";
	return { changes, blocks, videos, pendingDraft, action };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/i;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** True for the ISO 8601 UTC instants EmDash stores in updated_at. */
export function isIsoInstant(value) {
	return typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The guarded SQL that puts one entry's updated_at back: it changes the row
 * only while updated_at still holds the value the migration left (`from`), so
 * an edit made since keeps its own date. Every part is validated, so the
 * statement needs no parameters.
 */
export function restoreUpdatedAtSql({ collection, id, from, to }) {
	if (!IDENTIFIER.test(collection)) throw new Error(`Invalid collection: ${collection}`);
	if (!ENTRY_ID.test(id)) throw new Error(`Invalid entry id: ${id}`);
	if (!isIsoInstant(from) || !isIsoInstant(to)) throw new Error(`Invalid timestamp for ${collection}/${id}`);
	return `UPDATE ec_${collection} SET updated_at = '${to}' WHERE id = '${id}' AND updated_at = '${from}';`;
}

/**
 * Whether one entry's updated_at can be put back, from its backup (the entry
 * before the migration, plus `after`: the entry as the migration left it) and
 * the entry as it is now. Returns { action: "restore", from, to } or
 * { action: "skip", reason }.
 */
export function planRestore(backup, current, followSiteDefaults) {
	const original = backup?.item?.updatedAt;
	if (!isIsoInstant(original)) return { action: "skip", reason: "the backup has no original date" };
	if (!current) return { action: "skip", reason: "the entry no longer exists" };
	if (!backup.after) return { action: "skip", reason: "the migration didn't save this entry" };
	if (current.updatedAt === original) return { action: "skip", reason: "already at its original date" };
	if (current.updatedAt !== backup.after.updatedAt) return { action: "skip", reason: "edited since the migration" };
	if (hasPendingDraft(current)) return { action: "skip", reason: "has a pending draft" };
	if (planEntry(current, followSiteDefaults).blocks) return { action: "skip", reason: "still has true/false choices" };
	return { action: "restore", from: current.updatedAt, to: original };
}

/**
 * The rows each statement of `wrangler d1 execute --json` changed, from its
 * output (an array with one result per statement). null for a statement whose
 * result doesn't say.
 */
export function d1Changes(output) {
	const results = Array.isArray(output) ? output : [];
	return results.map((r) => (r && r.success !== false && typeof r.meta?.changes === "number" ? r.meta.changes : null));
}
