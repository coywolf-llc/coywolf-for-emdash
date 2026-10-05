// Unit tests for page cache purge rules.
// Run: node --test src/pageCache/lib.test.mjs   (Node 22.6+ strips the types from lib.ts)
import assert from "node:assert/strict";
import { test } from "node:test";

const { purgesAfter } = await import("./lib.ts");
const api = "/_emdash/api/plugins/coywolf-pack/";

test("admin writes to pack routes purge the page cache", () => {
	for (const route of ["schema/site/save", "redirects/import", "features/save", "robots/save", "videos/webhook", "videos/update", "backups/run"]) {
		assert.equal(purgesAfter("POST", api + route), true, route);
	}
});

test("public pack routes, reads, and other plugins don't", () => {
	for (const route of ["search/live", "search/index", "discovery/public/llms", "videos/like", "videos/play", "videos/caption", "videos/embed", "videos/sitemap"]) {
		assert.equal(purgesAfter("POST", api + route), false, route);
	}
	assert.equal(purgesAfter("GET", api + "schema/config"), false);
	assert.equal(purgesAfter("POST", "/_emdash/api/plugins/emdash-forms/submit"), false);
	assert.equal(purgesAfter("POST", "/_emdash/api/content/posts"), false, "EmDash purges its own content by tag");
});
