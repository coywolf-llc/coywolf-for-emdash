// Unit tests for cache warming and scoped purges.
// Run: node --test src/pageCache/warm.test.mjs   (Node 22.6+ strips the types from the .ts files)
import assert from "node:assert/strict";
import { test } from "node:test";

const { sitemapLocs, warmOrder, collectUrls, homeLinks, newWarmState, claimWork, warmStep, writeWarmState, writeWarmQueue, readWarmState, startWarm, finishCollect, recordBatch, remainingUrls, WARM_STATE_OPTION, WARM_QUEUE_PREFIX, QUEUE_CHUNK } =
	await import("./warm.ts");
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

/** The slice of D1 the warm queue uses: one options table. Counts writes to the progress row and their size. */
function fakeDb() {
	const rows = new Map();
	const like = (pattern) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
	const db = {
		rows,
		stateWrites: [],
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
				async all() {
					// SELECT name, value FROM options WHERE name IN (…)
					return { results: args.filter((n) => rows.has(n)).map((name) => ({ name, value: rows.get(name) })) };
				},
				async run() {
					if (sql.startsWith("INSERT")) {
						rows.set(args[0], args[1]);
						if (args[0] === WARM_STATE_OPTION) db.stateWrites.push(args[1].length);
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("DELETE")) {
						const [include, exclude] = args.map(like);
						let changes = 0;
						for (const name of [...rows.keys()]) {
							if (include.test(name) && !(exclude && exclude.test(name))) {
								rows.delete(name);
								changes++;
							}
						}
						return { meta: { changes } };
					}
					// UPDATE options SET value = ? WHERE name = ? AND value = ?
					const [value, name, before] = args;
					if (rows.get(name) !== before) return { meta: { changes: 0 } };
					rows.set(name, value);
					db.stateWrites.push(value.length);
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
		async batch(statements) {
			return Promise.all(statements.map((s) => s.run()));
		},
	};
	return db;
}

const queueRows = (db) => [...db.rows.keys()].filter((name) => name.startsWith(WARM_QUEUE_PREFIX));

/** A run in its warm phase with these URLs queued. */
async function warmRun(db, urls) {
	const state = { ...newWarmState("x"), phase: "warm", next: 0, total: urls.length };
	await writeWarmState(db, state);
	await writeWarmQueue(db, state.generation, urls);
	return state;
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
	assert.deepEqual(queueRows(db), [], "a finished run's URL rows are removed");
});

test("claims only rewrite the small progress row, however long the queue", async () => {
	const db = fakeDb();
	const urls = Array.from({ length: 5000 }, (_, i) => `https://x.com/a-fairly-long-post-slug-number-${i}/`);
	const state = await warmRun(db, urls);
	assert.equal(queueRows(db).length, Math.ceil(5000 / QUEUE_CHUNK));
	db.stateWrites.length = 0;
	const claimed = [];
	for (let i = 0; i < 300; i++) {
		const claim = await claimWork(db, 4);
		claimed.push(...claim.urls);
		await recordBatch(db, state.generation, claim.urls.length, 0);
	}
	assert.deepEqual(claimed, urls.slice(0, 1200), "batches follow the queue order, across chunk rows");
	assert.ok(Math.max(...db.stateWrites) < 1000, `progress writes stay small (largest ${Math.max(...db.stateWrites)} bytes)`);
	const progress = await readWarmState(db);
	assert.equal(progress.next, 1200);
	assert.equal(remainingUrls(progress), 3800);
});

test("a batch spanning two queue rows gets URLs from both", async () => {
	const db = fakeDb();
	const urls = Array.from({ length: QUEUE_CHUNK + 3 }, (_, i) => `https://x.com/${i}/`);
	const state = await warmRun(db, urls);
	await writeWarmState(db, { ...state, next: QUEUE_CHUNK - 2 });
	const claim = await claimWork(db, 4);
	assert.deepEqual(claim.urls, urls.slice(QUEUE_CHUNK - 2, QUEUE_CHUNK + 2));
});

test("a new run clears older runs' URL rows; a superseded collect doesn't leave its URLs", async () => {
	const db = fakeDb();
	const old = await warmRun(db, ["https://x.com/1/", "https://x.com/2/"]);
	assert.equal(queueRows(db).length, 1);
	const fresh = await startWarm(db, "deploy");
	assert.deepEqual(queueRows(db), []);
	// The old run's collect finishing late (after the restart) stores nothing.
	await finishCollect(db, old.generation, ["https://x.com/1/"], "https://x.com");
	assert.deepEqual(queueRows(db), []);
	assert.equal((await readWarmState(db)).generation, fresh.generation);
});

test("progress rows from before the queue rows are reported, then moved to URL rows and worked on", async () => {
	const db = fakeDb();
	const legacy = { ...newWarmState("x"), next: undefined, phase: "warm", queue: ["https://x.com/3/"], total: 3, warmed: 2 };
	db.rows.set(WARM_STATE_OPTION, JSON.stringify(legacy));
	const state = await readWarmState(db);
	assert.equal(state.legacy, true);
	assert.equal(remainingUrls(state), 1);
	assert.equal(state.queue, undefined);
	const claim = await claimWork(db, 4);
	assert.equal(claim.kind, "warm");
	assert.deepEqual(claim.urls, ["https://x.com/3/"]);
	assert.notEqual(claim.state.generation, legacy.generation, "a new generation, so a stale cleanup of the old one can't remove its rows");
	const migrated = JSON.parse(db.rows.get(WARM_STATE_OPTION));
	assert.equal(migrated.queue, undefined);
	assert.equal(migrated.total, 1);
});

test("deploy race: an old isolate finishing a new run's collect (queue + next, no URL rows) doesn't fail every page", async () => {
	const db = fakeDb();
	const s = site(["/a/", "/b/", "/c/"]);
	const fresh = await startWarm(db, "deploy");
	// What the older version's finishCollect writes: the new state spread, plus `queue`.
	const urls = ["https://x.com/", "https://x.com/a/", "https://x.com/b/", "https://x.com/c/"];
	db.rows.set(WARM_STATE_OPTION, JSON.stringify({ ...fresh, phase: "warm", queue: urls, total: urls.length }));
	assert.deepEqual(queueRows(db), []);
	await warmStep(db, s, "https://x.com", { budgetMs: 10_000, batchSize: 2 });
	const state = await readWarmState(db);
	assert.equal(state.phase, "done");
	assert.equal(state.warmed, 4);
	assert.equal(state.failed, 0);
	assert.equal(state.legacy, undefined);
	assert.deepEqual(queueRows(db), []);
});

test("an older-format collect step (queue: [], no next) is still collected", async () => {
	const db = fakeDb();
	const { next: _next, ...rest } = newWarmState("deploy");
	db.rows.set(WARM_STATE_OPTION, JSON.stringify({ ...rest, queue: [] }));
	const claim = await claimWork(db, 4);
	assert.equal(claim.kind, "collect");
	assert.equal(claim.state.next, 0);
	assert.equal(JSON.parse(db.rows.get(WARM_STATE_OPTION)).queue, undefined);
});

test("an older-format finished run is only reported", async () => {
	const db = fakeDb();
	db.rows.set(WARM_STATE_OPTION, JSON.stringify({ ...newWarmState("x"), next: undefined, phase: "done", queue: [], total: 2, warmed: 2 }));
	const before = db.rows.get(WARM_STATE_OPTION);
	assert.equal(await claimWork(db, 4), null);
	assert.equal(db.rows.get(WARM_STATE_OPTION), before);
});

test("parallel claims never take the same pages", async () => {
	const db = fakeDb();
	await warmRun(db, ["https://x.com/1/", "https://x.com/2/", "https://x.com/3/", "https://x.com/4/"]);
	const [a, b] = await Promise.all([claimWork(db, 2), claimWork(db, 2)]);
	const taken = [a, b].filter(Boolean).flatMap((c) => c.urls);
	assert.equal(new Set(taken).size, taken.length, "no URL claimed twice");
	const c = await claimWork(db, 2);
	const all = [...taken, ...(c?.urls ?? [])];
	assert.ok(all.length <= 4);
});

test("a restarted run makes old batches stop counting", async () => {
	const db = fakeDb();
	await warmRun(db, ["https://x.com/1/"]);
	const claim = await claimWork(db, 5);
	await startWarm(db, "settings");
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
