// Unit tests for cache warming and scoped purges.
// Run: node --test src/pageCache/warm.test.mjs   (Node 22.6+ strips the types from the .ts files)
import assert from "node:assert/strict";
import { test } from "node:test";

const { sitemapLocs, warmOrder, collectUrls, homeLinks, newWarmState, claimWork, warmStep, writeWarmState, readWarmState, startWarm } = await import("./warm.ts");
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

test("section pages linked from the home page come right after it", async () => {
	const site = fakeSite({
		"https://x.com/": `<nav><a href="/notes/">Notes</a> <a class="x" href='https://x.com/news/#top'>News</a> <a href="https://other.com/a/">x</a>
			<a href="/p1/">p1</a> <a href="/_emdash/admin">admin</a> <a href="/feed/">rss</a> <a href="/file.pdf">pdf</a> <a href="/search/?q=a">s</a> <a href="#main">skip</a></nav>`,
		"https://x.com/sitemap.xml": "<urlset><url><loc>https://x.com/p2/</loc></url><url><loc>https://x.com/p1/</loc></url></urlset>",
	});
	assert.deepEqual(await collectUrls(site, "https://x.com"), ["https://x.com/", "https://x.com/notes/", "https://x.com/news/", "https://x.com/p1/", "https://x.com/p2/"]);
});

test("home links are capped", () => {
	const html = Array.from({ length: 300 }, (_, i) => `<a href="/c${i}/">c</a>`).join("");
	assert.equal(homeLinks(html, "https://x.com").length, 200);
});

/** The slice of D1 the warm queue uses: one options table. */
function fakeDb() {
	const rows = new Map();
	return {
		rows,
		prepare(sql) {
			let args = [];
			const stmt = {
				bind(...a) {
					args = a;
					return stmt;
				},
				async first() {
					return rows.has(args[0]) ? { value: rows.get(args[0]) } : null;
				},
				async run() {
					if (sql.startsWith("INSERT")) {
						rows.set(args[0], args[1]);
						return { meta: { changes: 1 } };
					}
					// UPDATE options SET value = ? WHERE name = ? AND value = ?
					const [value, name, before] = args;
					if (rows.get(name) !== before) return { meta: { changes: 0 } };
					rows.set(name, value);
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
	};
}

const site = (paths) =>
	fakeSite({
		"https://x.com/sitemap.xml": `<urlset>${paths.map((p) => `<url><loc>https://x.com${p}</loc></url>`).join("")}</urlset>`,
		"https://x.com/": "home",
		...Object.fromEntries(paths.map((p) => [`https://x.com${p}`, p])),
	});

test("a warm step reads the sitemap, then warms every page and finishes", async () => {
	const db = fakeDb();
	const s = site(["/a/", "/b/", "/c/", "/gone/"]);
	await startWarm(db, "deploy");
	await warmStep(db, { fetch: (req) => (req.url.endsWith("/gone/") ? Promise.resolve(new Response("", { status: 404 })) : s.fetch(req)) }, "https://x.com", { budgetMs: 10_000, batchSize: 2 });
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.total, 5, "home page plus the sitemap's four");
	assert.equal(state.warmed, 4);
	assert.equal(state.failed, 1);
});

test("parallel claims never take the same pages", async () => {
	const db = fakeDb();
	await writeWarmState(db, { ...newWarmState("x"), phase: "warm", queue: ["https://x.com/1/", "https://x.com/2/", "https://x.com/3/", "https://x.com/4/"], total: 4 });
	const [a, b] = await Promise.all([claimWork(db, 2), claimWork(db, 2)]);
	const taken = [a, b].filter(Boolean).flatMap((c) => c.urls);
	assert.equal(new Set(taken).size, taken.length, "no URL claimed twice");
	const c = await claimWork(db, 2);
	const all = [...taken, ...(c?.urls ?? [])];
	assert.ok(all.length <= 4);
});

test("a restarted run makes old batches stop counting", async () => {
	const db = fakeDb();
	await writeWarmState(db, { ...newWarmState("x"), phase: "warm", queue: ["https://x.com/1/"], total: 1 });
	const claim = await claimWork(db, 5);
	await startWarm(db, "settings");
	const { recordBatch } = await import("./warm.ts");
	await recordBatch(db, claim.state.generation, 1, 0);
	const state = await readWarmState(db);
	assert.equal(state.phase, "collect");
	assert.equal(state.warmed, 0, "the old run's batch isn't added to the new one");
});

test("nothing to do when no run is queued or the collect step is already taken", async () => {
	const db = fakeDb();
	assert.equal(await claimWork(db, 4), null);
	await startWarm(db, "deploy");
	assert.equal((await claimWork(db, 4)).kind, "collect");
	assert.equal(await claimWork(db, 4), null, "another isolate is reading the sitemap");
});
