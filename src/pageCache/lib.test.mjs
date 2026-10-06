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

const { applyPageLifetime } = await import("./lib.ts");

function routeCache(maxAge) {
	return {
		enabled: true,
		options: maxAge === undefined ? {} : { maxAge },
		sets: [],
		set(o) {
			this.sets.push(o);
		},
	};
}

test("page lifetimes apply only to routes the site made cacheable", () => {
	const page = routeCache(3600);
	assert.equal(applyPageLifetime(page, 7, 1), true);
	assert.deepEqual(page.sets, [{ maxAge: 604800, swr: 86400 }]);

	const uncached = routeCache(undefined);
	assert.equal(applyPageLifetime(uncached, 7, 1), false, "never turns caching on");
	assert.deepEqual(uncached.sets, []);
	assert.equal(applyPageLifetime(undefined, 7, 1), false);
	assert.equal(applyPageLifetime({ ...routeCache(60), enabled: false }, 7, 1), false);
});

const { shortenStopgapPage, STOPGAP_LIFETIME } = await import("./lib.ts");

const html = (body = "<p>hi</p>", init = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });

test("a page rendered with a stopgap poster is cached for minutes, decided after its body has rendered", async () => {
	const page = routeCache(604800);
	let rendered = false;
	// The flag is set while the body streams (a component deep in the page), not before next() returns.
	const stream = new ReadableStream({
		async pull(controller) {
			await new Promise((r) => setTimeout(r, 0));
			rendered = true;
			controller.enqueue(new TextEncoder().encode("<video>"));
			controller.close();
		},
	});
	const out = await shortenStopgapPage(page, html(stream, { headers: { "content-type": "text/html", "x-keep": "1" } }), () => rendered);
	assert.deepEqual(page.sets, [{ maxAge: STOPGAP_LIFETIME.maxAge, swr: STOPGAP_LIFETIME.swr }]);
	assert.equal(await out.text(), "<video>");
	assert.equal(out.headers.get("x-keep"), "1");
	assert.equal(out.status, 200);
});

test("pages without a stopgap, uncached routes and non-HTML responses keep their lifetime", async () => {
	const page = routeCache(604800);
	assert.equal(await (await shortenStopgapPage(page, html(), () => false)).text(), "<p>hi</p>");
	assert.deepEqual(page.sets, []);

	const untouched = html();
	assert.equal(await shortenStopgapPage(routeCache(undefined), untouched, () => assert.fail("asked")), untouched);
	assert.equal(await shortenStopgapPage(undefined, untouched, () => assert.fail("asked")), untouched);

	const json = new Response("{}", { headers: { "content-type": "application/json" } });
	assert.equal(await shortenStopgapPage(routeCache(60), json, () => assert.fail("asked")), json);
	const missing = html("gone", { status: 404 });
	assert.equal(await shortenStopgapPage(routeCache(60), missing, () => assert.fail("asked")), missing);

	const short = routeCache(120);
	await shortenStopgapPage(short, html(), () => true);
	assert.deepEqual(short.sets, [{ maxAge: 120, swr: STOPGAP_LIFETIME.swr }], "never lengthens a shorter lifetime");
});

test("the cache warmer's stopgap render isn't cached and is marked for a revisit; visitors' renders aren't marked", async () => {
	const warmer = routeCache(604800);
	const marked = await shortenStopgapPage(warmer, html("<video>", { headers: { "content-type": "text/html", "x-keep": "1" } }), () => true, "X-Coywolf-Stopgap");
	assert.deepEqual(warmer.sets, [false], "not cached, so the mark never reaches visitors and the revisit renders afresh");
	assert.equal(marked.headers.get("x-coywolf-stopgap"), "1");
	assert.equal(marked.headers.get("x-keep"), "1");
	assert.equal(await marked.text(), "<video>");

	const visitor = routeCache(604800);
	const plain = await shortenStopgapPage(visitor, html(), () => true);
	assert.equal(plain.headers.get("x-coywolf-stopgap"), null);
	assert.deepEqual(visitor.sets, [{ maxAge: STOPGAP_LIFETIME.maxAge, swr: STOPGAP_LIFETIME.swr }]);

	const fine = routeCache(604800);
	const clean = await shortenStopgapPage(fine, html(), () => false, "X-Coywolf-Stopgap");
	assert.equal(clean.headers.get("x-coywolf-stopgap"), null, "the warmer's normal renders aren't marked");
	assert.deepEqual(fine.sets, []);
});
