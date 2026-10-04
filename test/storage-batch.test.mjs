// Run: node --test test/storage-batch.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { getManyBatched, deleteManyBatched, STORAGE_IN_LIMIT } = await import("../src/core/storage.ts");

function fakeCollection() {
	const calls = [];
	return {
		calls,
		async getMany(ids) {
			calls.push(ids.length);
			if (ids.length + 2 > 100) throw new Error("too many SQL variables");
			return new Map(ids.map((id) => [id, { id }]));
		},
		async deleteMany(ids) {
			calls.push(ids.length);
			if (ids.length + 2 > 100) throw new Error("too many SQL variables");
			return ids.length;
		},
	};
}

test("getManyBatched stays under D1's 100 bound values and dedupes", async () => {
	const c = fakeCollection();
	const ids = Array.from({ length: 250 }, (_, i) => `v${i}`);
	const out = await getManyBatched(c, [...ids, "v1", "v2"]);
	assert.equal(out.size, 250);
	assert.ok(c.calls.every((n) => n <= STORAGE_IN_LIMIT));
	assert.deepEqual(c.calls, [90, 90, 70]);
});

test("deleteManyBatched counts every deleted id", async () => {
	const c = fakeCollection();
	assert.equal(await deleteManyBatched(c, Array.from({ length: 181 }, (_, i) => `x${i}`)), 181);
	assert.deepEqual(c.calls, [90, 90, 1]);
	assert.equal(await deleteManyBatched(c, []), 0);
});
