import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { MemoryCache, sizeOf } = await import("../src/discovery/memory-cache.ts");

function cache(overrides = {}) {
	let now = 0;
	const c = new MemoryCache({ ttlMs: 1000, maxBytes: 1000, maxEntryBytes: 400, maxMisses: 2, now: () => now, ...overrides });
	return { c, advance: (ms) => (now += ms) };
}

test("hits expire after the TTL", () => {
	const { c, advance } = cache();
	c.set("a", { body: "x" });
	assert.deepEqual(c.get("a"), { body: "x" });
	advance(1001);
	assert.equal(c.get("a"), undefined);
	assert.equal(c.totalBytes, 0);
});

test("large values are not cached; total bytes are capped (LRU eviction)", () => {
	const { c } = cache();
	c.set("big", { body: "x".repeat(300) });
	assert.equal(c.get("big"), undefined);
	const v = { body: "y".repeat(180) }; // ~380 bytes, so three exceed 1,000
	c.set("1", v);
	c.set("2", v);
	c.get("1"); // 1 is now most recent
	c.set("3", v);
	assert.ok(c.totalBytes <= 1000);
	assert.equal(c.get("2"), undefined, "least recently used is evicted");
	assert.deepEqual(c.get("1"), v);
	assert.deepEqual(c.get("3"), v);
	assert.equal(c.totalBytes, sizeOf(v) * 2);
});

test("misses are remembered in a small separate list", () => {
	const { c } = cache();
	c.set("doc", { body: "z" });
	for (const p of ["/a", "/b", "/c", "/d"]) c.set(p, null);
	assert.equal(c.size.misses, 2);
	assert.equal(c.get("/d"), null);
	assert.equal(c.get("/a"), undefined);
	assert.deepEqual(c.get("doc"), { body: "z" }, "misses never evict documents");
});
