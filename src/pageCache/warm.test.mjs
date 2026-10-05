// Unit tests for cache warming and scoped purges.
// Run: node --test src/pageCache/warm.test.mjs   (Node 22.6+ strips the types from the .ts files)
import assert from "node:assert/strict";
import { test } from "node:test";

const { sitemapLocs, warmOrder, warmBatch, collectUrls, newWarmState } = await import("./warm.ts");
const { purgeScope } = await import("./lib.ts");

const API = "/_emdash/api/plugins/coywolf-pack/";

test("settings that don't change pages don't clear them; robots clears only robots.txt", () => {
	assert.equal(purgeScope(API + "redirects/import"), null);
	assert.equal(purgeScope(API + "backups/run"), null);
	assert.equal(purgeScope(API + "links/recheck"), null);
	assert.equal(purgeScope(API + "cache/warm/start"), null);
	assert.equal(purgeScope(API + "cache/media/apply"), null);
	assert.deepEqual(purgeScope(API + "robots/save"), { pathPrefixes: ["/robots.txt"] });
	assert.deepEqual(purgeScope(API + "schema/site/save"), { purgeEverything: true });
	assert.deepEqual(purgeScope(API + "cache/settings/save"), { purgeEverything: true });
	assert.deepEqual(purgeScope(API + "features/save"), { purgeEverything: true });
});

test("reads sitemaps and sitemap indexes", () => {
	assert.deepEqual(sitemapLocs('<urlset><url><loc>https://x.com/a/?p=1&amp;q=2</loc></url><url><loc> https://x.com/b/ </loc></url></urlset>'), {
		isIndex: false,
		locs: ["https://x.com/a/?p=1&q=2", "https://x.com/b/"],
	});
	assert.equal(sitemapLocs("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>").isIndex, true);
});

test("warm order: home first, same origin only, no duplicates, capped", () => {
	const order = warmOrder("https://x.com", ["https://x.com/new/", "https://other.com/x/", "https://x.com/", "https://x.com/new/#top", "/old/"], 3);
	assert.deepEqual(order, ["https://x.com/", "https://x.com/new/", "https://x.com/old/"]);
});

function fakeSite(pages) {
	const hits = [];
	return {
		hits,
		async fetch(req) {
			hits.push(req.url);
			const body = pages[req.url];
			return body === undefined ? new Response("nope", { status: 404 }) : new Response(body, { status: 200 });
		},
	};
}

test("collects URLs through a sitemap index", async () => {
	const site = fakeSite({
		"https://x.com/sitemap.xml": "<sitemapindex><sitemap><loc>https://x.com/sitemap-posts-1.xml</loc></sitemap><sitemap><loc>https://evil.com/s.xml</loc></sitemap></sitemapindex>",
		"https://x.com/sitemap-posts-1.xml": "<urlset><url><loc>https://x.com/p2/</loc></url><url><loc>https://x.com/p1/</loc></url></urlset>",
	});
	assert.deepEqual(await collectUrls(site, "https://x.com"), ["https://x.com/", "https://x.com/p2/", "https://x.com/p1/"]);
	assert.ok(!site.hits.some((u) => u.includes("evil.com")), "other hosts are never fetched");
});

test("warms in batches within the budget and finishes", async () => {
	const site = fakeSite({ "https://x.com/": "h", "https://x.com/a/": "a", "https://x.com/b/": "b" });
	let state = { ...newWarmState("deploy"), phase: "warm", queue: ["https://x.com/", "https://x.com/a/", "https://x.com/b/", "https://x.com/gone/"], total: 4 };
	state = await warmBatch(site, state, { budgetMs: 10_000, concurrency: 2, isCurrent: async () => true });
	assert.equal(state.phase, "done");
	assert.equal(state.warmed, 3);
	assert.equal(state.failed, 1);
	assert.equal(state.queue.length, 0);
});

test("stops when the budget runs out or a newer purge restarted the job", async () => {
	const site = fakeSite({ "https://x.com/a/": "a", "https://x.com/b/": "b", "https://x.com/c/": "c" });
	const queue = ["https://x.com/a/", "https://x.com/b/", "https://x.com/c/"];
	let clock = 0;
	const out = await warmBatch(site, { ...newWarmState("x"), phase: "warm", queue, total: 3 }, { budgetMs: 2, concurrency: 1, isCurrent: async () => true, now: () => clock++ });
	assert.equal(out.phase, "warm");
	assert.ok(out.queue.length > 0 && out.warmed >= 1);
	const stopped = await warmBatch(site, { ...newWarmState("x"), phase: "warm", queue, total: 3 }, { budgetMs: 10_000, isCurrent: async () => false });
	assert.equal(stopped.warmed, 0);
	assert.equal(stopped.queue.length, 3);
});
