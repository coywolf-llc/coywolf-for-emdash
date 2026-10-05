// Unit tests for restoring missing media in batches.
// Run: node --test src/backups/restore.test.mjs   (Node 22.6+ strips the types from store.ts)
import assert from "node:assert/strict";
import { test } from "node:test";

const { restoreMissingMedia, mirrorBucket, pruneBackups } = await import("./store.ts");

/** The slice of an R2 bucket that restoreMissingMedia uses, paging 100 keys at a time like R2's default 1,000. */
function bucket(entries = {}) {
	const store = new Map(Object.entries(entries));
	return {
		store,
		async list({ prefix = "", cursor, delimiter } = {}) {
			const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			if (delimiter) {
				const dirs = [...new Set(keys.map((k) => k.slice(prefix.length)).filter((k) => k.includes(delimiter)).map((k) => prefix + k.split(delimiter)[0] + delimiter))];
				return { objects: [], delimitedPrefixes: dirs, truncated: false };
			}
			const start = cursor ? Number(cursor) : 0;
			const page = keys.slice(start, start + 100);
			const truncated = start + 100 < keys.length;
			return { objects: page.map((key) => ({ key, etag: `e-${store.get(key)}` })), truncated, cursor: truncated ? String(start + 100) : undefined };
		},
		async get(key) {
			return store.has(key) ? { body: store.get(key), httpMetadata: {} } : null;
		},
		async put(key, body) {
			store.set(key, body);
		},
		async delete(keys) {
			for (const k of [].concat(keys)) store.delete(k);
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

test("private form uploads mirror to uploads/ and restore from there, separate from media", async () => {
	const uploads = bucket({ "forms/a.pdf": "A", "forms/b.png": "B" });
	const backups = bucket({ "media/current/photo.jpg": "P" });
	const first = await mirrorBucket(uploads, backups, "2020-01-01T0600Z", "uploads");
	assert.deepEqual(first, { copied: 2, preserved: 0, total: 2, pending: 0 });
	assert.equal(backups.store.get("uploads/current/forms/a.pdf"), "A");

	// A replaced upload keeps its old copy under uploads/changed/<stamp>/; a deleted one too.
	uploads.store.set("forms/a.pdf", "A2");
	uploads.store.delete("forms/b.png");
	await mirrorBucket(uploads, backups, "2020-01-02T0600Z", "uploads");
	assert.equal(backups.store.get("uploads/current/forms/a.pdf"), "A2");
	assert.equal(backups.store.get("uploads/changed/2020-01-02T0600Z/forms/a.pdf"), "A");
	assert.equal(backups.store.get("uploads/changed/2020-01-02T0600Z/forms/b.png"), "B");
	assert.ok(!backups.store.has("uploads/current/forms/b.png"));
	assert.equal(backups.store.get("media/current/photo.jpg"), "P", "media mirror untouched");

	const empty = bucket();
	const restored = await restoreMissingMedia(empty, backups, 200, "uploads");
	assert.deepEqual(restored, { restored: 1, checked: 1, pending: 0 });
	assert.equal(empty.store.get("forms/a.pdf"), "A2");
	assert.ok(!empty.store.has("photo.jpg"), "media isn't restored into the uploads bucket");

	// Old replaced copies are pruned like media's.
	assert.equal(await pruneBackups(backups, 1), 0);
	assert.ok(![...backups.store.keys()].some((k) => k.startsWith("uploads/changed/2020-01-02")), "uploads/changed pruned");
});
