// Unit tests for restoring missing media in batches.
// Run: node --test src/backups/restore.test.mjs   (Node 22.6+ strips the types from store.ts)
import assert from "node:assert/strict";
import { test } from "node:test";

const { restoreMissingMedia } = await import("./store.ts");

/** The slice of an R2 bucket that restoreMissingMedia uses, paging 100 keys at a time like R2's default 1,000. */
function bucket(entries = {}) {
	const store = new Map(Object.entries(entries));
	return {
		store,
		async list({ prefix = "", cursor } = {}) {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = cursor ? Number(cursor) : 0;
			const page = keys.slice(start, start + 100);
			const truncated = start + 100 < keys.length;
			return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + 100) : undefined };
		},
		async get(key) {
			return store.has(key) ? { body: store.get(key), httpMetadata: {} } : null;
		},
		async put(key, body) {
			store.set(key, body);
		},
	};
}

test("restores missing media in batches until nothing is pending, never overwriting", async () => {
	const mirror = {};
	for (let i = 0; i < 450; i++) mirror[`media/current/file-${String(i).padStart(3, "0")}.jpg`] = `backup-${i}`;
	const backups = bucket(mirror);
	const media = bucket({ "file-000.jpg": "live-0" });

	const runs = [];
	for (;;) {
		const result = await restoreMissingMedia(media, backups, 200);
		runs.push(result);
		if (!result.pending) break;
	}
	assert.deepEqual(runs.map((r) => [r.restored, r.pending]), [[200, 249], [200, 49], [49, 0]]);
	assert.equal(media.store.size, 450);
	assert.equal(media.store.get("file-000.jpg"), "live-0", "existing files are left alone");
	assert.equal(media.store.get("file-449.jpg"), "backup-449");
	assert.deepEqual(await restoreMissingMedia(media, backups, 200), { restored: 0, checked: 450, pending: 0 });
});
