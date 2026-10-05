// Run: node --test test/redirects.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { compile, match, listRules } = await import("../src/redirects/rules.ts");
const { serveRedirect, invalidateRedirectCache } = await import("../src/redirects/middleware.ts");

const rule = (source, target, extra = {}) => ({
	id: source,
	source,
	target,
	type: 301,
	isRegex: true,
	enabled: true,
	hits: 0,
	lastHit: null,
	note: null,
	createdAt: "",
	updatedAt: "",
	...extra,
});

/** What a browser would end up on: the request URL's own parsing, then the Location resolved against it. */
function follow(compiled, requestUrl) {
	const url = new URL(requestUrl);
	const found = match(compiled, url.pathname, url.search);
	return found && new URL(found.location, url).href;
}

test("regex capture can't turn a site path into a protocol-relative redirect", () => {
	const compiled = compile([rule("^/blog/(.*)$", "/$1")]);
	assert.equal(follow(compiled, "https://example.com/blog/hello"), "https://example.com/hello");
	assert.equal(follow(compiled, "https://example.com/blog//evil.com/x"), "https://example.com/evil.com/x");
	assert.equal(follow(compiled, "https://example.com/blog///evil.com"), "https://example.com/evil.com");
	// URL parsing turns "\" into "/" in http(s) paths before the rules see it.
	assert.equal(follow(compiled, "https://example.com/blog/\\evil.com"), "https://example.com/evil.com");
	assert.equal(follow(compiled, "https://example.com/blog/\\/evil.com"), "https://example.com/evil.com");
	// Percent-encoded slashes and backslashes stay encoded, so they stay on this site.
	assert.equal(follow(compiled, "https://example.com/blog/%2F%2Fevil.com"), "https://example.com/%2F%2Fevil.com");
	assert.equal(follow(compiled, "https://example.com/blog/%5Cevil.com"), "https://example.com/%5Cevil.com");
	assert.equal(follow(compiled, "https://example.com/blog/%5C%5Cevil.com"), "https://example.com/%5C%5Cevil.com");
});

test("a backslash captured from the raw path is collapsed too", () => {
	const compiled = compile([rule("^/blog/(.*)$", "/$1")]);
	assert.equal(match(compiled, "/blog/\\evil.com", "").location, "/evil.com");
	assert.equal(match(compiled, "/blog/\\\\evil.com", "").location, "/evil.com");
});

test("an absolute target keeps the host it names", () => {
	const compiled = compile([rule("^/old(.*)$", "https://example.com$1")]);
	assert.equal(match(compiled, "/old/page", "").location, "https://example.com/page");
	assert.equal(match(compiled, "/old.evil.com/x", ""), null);
	assert.equal(match(compiled, "/old@evil.com", ""), null);
	// A host built from a capture is the site owner's choice.
	const open = compile([rule("^/go/([a-z.]+)$", "https://$1/")]);
	assert.equal(match(open, "/go/coywolf.com", "").location, "https://coywolf.com/");
});

test("ordinary rules are unchanged", () => {
	const compiled = compile([
		rule("/old", "/new", { isRegex: false }),
		rule("^/a/(\\d+)$", "/b/$1"),
		rule("/gone", "", { isRegex: false, type: 410 }),
	]);
	assert.equal(match(compiled, "/old/", "?x=1").location, "/new?x=1");
	assert.equal(match(compiled, "/a/42", "").location, "/b/42");
	assert.equal(match(compiled, "/gone", "?x").location, "");
});

test("middleware never answers with an off-site Location for a site path", async () => {
	invalidateRedirectCache();
	const rows = [
		{ id: "1", source: "^/blog/(.*)$", target: "/$1", type: 301, is_regex: 1, enabled: 1, hits: 0, last_hit: null, note: null, created_at: "", updated_at: "" },
	];
	const db = {
		prepare: (sql) => ({
			sql,
			bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }),
			all: async () => ({ results: rows }),
		}),
		batch: async () => [],
	};
	const res = await serveRedirect(new URL("https://example.com/blog//evil.com/x"), { DB: db }, () => {});
	assert.equal(res.status, 301);
	assert.equal(res.headers.get("Location"), "https://example.com/evil.com/x");
	invalidateRedirectCache();
});

test("listRules creates the table once per isolate and recreates it if a restore dropped it", async () => {
	let batches = 0;
	let selects = 0;
	let dropped = false;
	const db = {
		prepare: (sql) => ({
			all: async () => {
				selects++;
				if (dropped) {
					dropped = false;
					throw new Error("D1_ERROR: no such table: coywolf_redirects");
				}
				return { results: [] };
			},
		}),
		batch: async () => {
			batches++;
			return [];
		},
	};
	await Promise.all([listRules(db), listRules(db)]);
	await listRules(db);
	const before = batches;
	assert.ok(before <= 1);
	dropped = true;
	await listRules(db);
	assert.equal(batches, before + 1);
	assert.equal(selects, 5);
});
