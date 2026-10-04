import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const cu = await import("../src/core/content-url.ts");
const { interpolateUrlPattern, overridePath, applyTrailingSlash, patternTaxonomies, expandPattern, compilePattern, configureContentUrls, entryUrl, entryUrls, matchEntryPath, primaryTerms } = cu;

// ── A D1 stand-in over node:sqlite, with EmDash's tables ──

function fakeD1() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE _emdash_collections (slug TEXT, label TEXT, label_singular TEXT, url_pattern TEXT, title_field TEXT, routable INTEGER DEFAULT 1);
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT);
		CREATE TABLE ec_pages (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT);
		CREATE TABLE ec_items (id TEXT PRIMARY KEY, slug TEXT, status TEXT, published_at TEXT, locale TEXT, translation_group TEXT, deleted_at TEXT, title TEXT);
		CREATE TABLE content_taxonomies (collection TEXT, entry_id TEXT, taxonomy_id TEXT);
		CREATE TABLE taxonomies (id TEXT, name TEXT, slug TEXT, label TEXT, parent_id TEXT, locale TEXT, translation_group TEXT);
		INSERT INTO _emdash_collections VALUES ('posts','Posts','Post','/posts/{slug}',NULL,1), ('pages','Pages','Page','/{slug}',NULL,1), ('items','Items','Item',NULL,NULL,1);
		INSERT INTO taxonomies VALUES
			('t1','category','zebra','Zebra',NULL,'en','g1'),
			('t2','category','apple','Apple',NULL,'en','g2'),
			('t3','tag','aardvark','Aardvark',NULL,'en','g3'),
			('t4','category','mind','Mind',NULL,'en','g4');
		INSERT INTO ec_posts VALUES
			('p1','first','published','2024-03-05 10:00:00','en','p1',NULL,'First'),
			('p2','second','published','2024-03-06 10:00:00','en','p2',NULL,'Second'),
			('p3','third','draft',NULL,'en','p3',NULL,'Third'),
			('p4','fourth','published','2024-03-07 10:00:00','en','p4',NULL,'Fourth');
		INSERT INTO content_taxonomies VALUES ('posts','p1','g1'), ('posts','p1','g2'), ('posts','p1','g3'), ('posts','p3','g4'), ('posts','p4','g4');
		INSERT INTO ec_pages VALUES ('a1','about','published','2024-01-01 00:00:00','en','a1',NULL,'About');
		INSERT INTO ec_items VALUES ('i1','widget','published','2024-01-01 00:00:00','en','i1',NULL,'Widget');
	`);
	const log = [];
	const d1 = {
		log,
		prepare(sql) {
			let params = [];
			const stmt = {
				bind(...p) {
					params = p;
					return stmt;
				},
				async all() {
					log.push(sql);
					return { results: db.prepare(sql).all(...params) };
				},
				async first() {
					log.push(sql);
					return db.prepare(sql).get(...params) ?? null;
				},
			};
			return stmt;
		},
	};
	return d1;
}

const WELLBEING = { urls: { posts: "/{term:category|uncategorized}/{slug}/" } };

// ── Interpolation ──

test("term tokens use the first term, the fallback, or stay literal", () => {
	const base = { pattern: "/{term:category|uncategorized}/{slug}/", collection: "posts", slug: "hello", id: "1" };
	assert.equal(interpolateUrlPattern({ ...base, terms: { category: "mind" } }), "/mind/hello");
	assert.equal(interpolateUrlPattern({ ...base, terms: {} }), "/uncategorized/hello");
	assert.equal(interpolateUrlPattern({ ...base, pattern: "/{term:category}/{slug}" }), "/{term:category}/hello");
	assert.equal(interpolateUrlPattern({ ...base, terms: { category: "a b" } }), "/a%20b/hello");
	// EmDash's own tokens are unchanged.
	assert.equal(interpolateUrlPattern({ pattern: "/{year}/{month}/{slug}", collection: "p", slug: "s", id: "1", date: "2023-05-08 23:59:00" }), "/2023/05/s");
	assert.equal(interpolateUrlPattern({ pattern: null, collection: "items", slug: "s", id: "1" }), "/items/s");
});

test("{category} is shorthand for {term:category|uncategorized}", () => {
	assert.equal(expandPattern("/{category}/{slug}/"), "/{term:category|uncategorized}/{slug}/");
	assert.deepEqual(patternTaxonomies("/{category}/{term:tag}/{slug}"), ["category", "tag"]);
	assert.deepEqual(patternTaxonomies(null), []);
});

test("overridePath: null for an unfillable term; trailing slash follows the pattern under ignore", () => {
	const entry = { collection: "posts", id: "1", slug: "hello" };
	assert.equal(overridePath("/{term:category}/{slug}/", entry, "ignore"), null);
	assert.equal(overridePath("/{term:category}/{slug}/", { ...entry, terms: { category: "mind" } }, "ignore"), "/mind/hello/");
	assert.equal(overridePath("/{category}/{slug}/", entry, "never"), "/uncategorized/hello");
	assert.equal(overridePath("/{category}/{slug}", entry, "always"), "/uncategorized/hello/");
	assert.equal(overridePath("/{category}/{slug}", entry, "ignore"), "/uncategorized/hello");
	assert.equal(applyTrailingSlash("/", "always"), "/");
	assert.equal(applyTrailingSlash("/a/", "never"), "/a");
	assert.equal(applyTrailingSlash("/a", "ignore"), "/a");
});

test("compilePattern captures slug and id groups", () => {
	const c = compilePattern("/{term:category|uncategorized}/{slug}/");
	const m = c.regex.exec("/mind/hello");
	assert.ok(m);
	assert.equal(m[c.slug], "hello");
	assert.equal(c.regex.exec("/mind/hello/extra"), null);
	const d = compilePattern("/{year}/{month}/{id}.html");
	assert.equal(d.regex.exec("/2024/03/42.html")[d.id], "42");
});

// ── Terms and batched URLs over D1 ──

test("primary terms follow EmDash's ordering (label ascending) per taxonomy", async () => {
	const d1 = fakeD1();
	const terms = await primaryTerms(d1, "posts", ["p1", "p2", "p4"], ["category", "tag"]);
	assert.deepEqual(terms.get("p1"), { category: "apple", tag: "aardvark" });
	assert.deepEqual(terms.get("p2"), {});
	assert.deepEqual(terms.get("p4"), { category: "mind" });
});

test("entryUrls resolves a list with one terms query", async () => {
	configureContentUrls(WELLBEING);
	const d1 = fakeD1();
	const urls = await entryUrls(d1, "posts", [
		{ id: "p1", slug: "first", publishedAt: "2024-03-05" },
		{ id: "p2", slug: "second", publishedAt: "2024-03-06" },
		{ id: "p4", slug: "fourth", publishedAt: "2024-03-07" },
		{ id: "p9", slug: null },
	]);
	assert.equal(urls.get("p1"), "/apple/first/");
	assert.equal(urls.get("p2"), "/uncategorized/second/");
	assert.equal(urls.get("p4"), "/mind/fourth/");
	assert.equal(urls.get("p9"), null);
	assert.equal(d1.log.filter((sql) => sql.includes("content_taxonomies")).length, 1);
	assert.equal(d1.log.filter((sql) => sql.includes("_emdash_collections")).length, 0, "overrides need no collection lookup");
});

test("collections without an override keep EmDash's url_pattern", async () => {
	configureContentUrls(WELLBEING);
	const d1 = fakeD1();
	assert.equal(await entryUrl(d1, "pages", { id: "a1", slug: "about" }), "/about");
	assert.equal(await entryUrl(d1, "items", { id: "i1", slug: "widget" }), "/items/widget");
	configureContentUrls({});
	assert.equal(await entryUrl(d1, "posts", { id: "p1", slug: "first" }), "/posts/first");
	configureContentUrls({ trailingSlash: "always" });
	assert.equal(await entryUrl(d1, "posts", { id: "p1", slug: "first" }), "/posts/first/");
});

test("date tokens in an override read missing publish dates from D1", async () => {
	configureContentUrls({ urls: { posts: "/{year}/{category}/{slug}" } });
	const d1 = fakeD1();
	assert.equal(await entryUrl(d1, "posts", { id: "p4", slug: "fourth" }), "/2024/mind/fourth");
});

// ── Reverse matching ──

test("matchEntryPath: override with primary category", async () => {
	configureContentUrls(WELLBEING);
	const d1 = fakeD1();
	assert.deepEqual(await matchEntryPath(d1, "/apple/first/"), { collection: "posts", id: "p1", path: "/apple/first/" });
	assert.deepEqual(await matchEntryPath(d1, "/apple/first"), { collection: "posts", id: "p1", path: "/apple/first/" });
	assert.equal(await matchEntryPath(d1, "/zebra/first/"), null, "not the primary category");
	assert.equal(await matchEntryPath(d1, "/uncategorized/first/"), null, "has a category");
	assert.deepEqual(await matchEntryPath(d1, "/uncategorized/second/"), { collection: "posts", id: "p2", path: "/uncategorized/second/" });
	assert.equal(await matchEntryPath(d1, "/mind/third/"), null, "drafts have no URL");
	assert.equal(await matchEntryPath(d1, "/posts/first"), null, "EmDash's pattern is not canonical under an override");
});

test("matchEntryPath: falls back to EmDash's url_pattern and the default route", async () => {
	configureContentUrls(WELLBEING);
	const d1 = fakeD1();
	assert.deepEqual(await matchEntryPath(d1, "/about"), { collection: "pages", id: "a1", path: "/about" });
	assert.deepEqual(await matchEntryPath(d1, "/items/widget/"), { collection: "items", id: "i1", path: "/items/widget" });
	assert.equal(await matchEntryPath(d1, "/items/nothing"), null);
	configureContentUrls({});
	assert.deepEqual(await matchEntryPath(d1, "/posts/first"), { collection: "posts", id: "p1", path: "/posts/first" });
});

test("removed content records the resolved former URL", async () => {
	const { buildPending } = await import("../src/redirects/removed-core.ts");
	const entry = { id: "p1", slug: "first", status: "published", publishedAt: "2024-03-05", locale: "en", title: "First" };
	assert.equal(buildPending("posts", entry, { url: "/apple/first/", urlPattern: "/posts/{slug}" }, "deleted").url, "/apple/first/");
	assert.equal(buildPending("posts", entry, { url: null, urlPattern: "/posts/{slug}" }, "deleted").url, "/posts/first");
});
