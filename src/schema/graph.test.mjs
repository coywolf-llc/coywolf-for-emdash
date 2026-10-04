// Unit tests for the Schema & Social graph builders.
// Run: node --test src/schema/graph.test.mjs   (Node 22.6+ strips the types from graph.ts)
import assert from "node:assert/strict";
import { test } from "node:test";

const g = await import("./graph.ts");

const ORIGIN = "https://example.com";

function page(overrides = {}) {
	return {
		url: `${ORIGIN}/my-post/`,
		path: "/my-post/",
		locale: null,
		kind: "content",
		pageType: "article",
		title: "My Post | Example",
		pageTitle: "My Post",
		description: "About my post.",
		canonical: `${ORIGIN}/my-post/`,
		image: "/_emdash/api/media/file/01ABC.jpg",
		content: { collection: "posts", id: "e1", slug: "my-post" },
		seo: { ogImage: null, robots: null },
		articleMeta: { publishedTime: "2026-01-02T03:04:05Z", modifiedTime: "2026-02-03T04:05:06Z", author: "Jon Henshaw" },
		siteName: "Example",
		...overrides,
	};
}

function publisher(details = { publisherType: "organization", orgRows: [] }) {
	return g.publisherNode({ details, origin: ORIGIN, siteName: "Example", siteLogo: { url: "/_emdash/api/media/file/logo.png", width: 512, height: 512 } });
}

function build(p, extra = {}) {
	return g.buildGraph({
		page: p,
		origin: ORIGIN,
		siteName: "Example",
		tagline: "A site",
		language: "en",
		types: {},
		override: null,
		searchUrl: "/?s={search_term_string}",
		publisher: publisher(),
		authors: [],
		image: { url: `${ORIGIN}/_emdash/api/media/file/01ABC.jpg`, width: 1200, height: 630, alt: "A cover" },
		breadcrumbs: false,
		...extra,
	});
}

const nodes = (doc) => doc["@graph"];
const byType = (doc, type) => nodes(doc).filter((n) => n["@type"] === type);
const byId = (doc, id) => nodes(doc).find((n) => n["@id"] === id);

function assertRefsResolve(doc) {
	const ids = new Set(nodes(doc).map((n) => n["@id"]).filter(Boolean));
	const walk = (value, top) => {
		if (Array.isArray(value)) return value.forEach((v) => walk(v, false));
		if (value && typeof value === "object") {
			const keys = Object.keys(value);
			if (!top && keys.length === 1 && keys[0] === "@id") assert.ok(ids.has(value["@id"]), `dangling reference ${value["@id"]}`);
			for (const [k, v] of Object.entries(value)) if (k !== "@id") walk(v, false);
		}
	};
	nodes(doc).forEach((n) => walk(n, true));
	assert.equal(ids.size, nodes(doc).filter((n) => n["@id"]).length, "duplicate @id in graph");
}

test("article page: BlogPosting keeps everything core emits", () => {
	const doc = build(page(), { authors: [{ "@type": "Person", "@id": `${ORIGIN}/author/jon/#person`, name: "Jon Henshaw" }] });
	assert.equal(doc["@context"], "https://schema.org");
	const [article] = byType(doc, "BlogPosting");
	assert.ok(article, "BlogPosting node");
	assert.equal(article.headline, "My Post");
	assert.equal(article.description, "About my post.");
	assert.equal(article.datePublished, "2026-01-02T03:04:05Z");
	assert.equal(article.dateModified, "2026-02-03T04:05:06Z");
	assert.deepEqual(article.mainEntityOfPage, { "@id": `${ORIGIN}/my-post/#webpage` });
	assert.deepEqual(article.author, { "@id": `${ORIGIN}/author/jon/#person` });
	assert.deepEqual(article.publisher, { "@id": `${ORIGIN}/#organization` });
	assert.deepEqual(article.image, { "@id": `${ORIGIN}/my-post/#primaryimage` });
	const image = byId(doc, `${ORIGIN}/my-post/#primaryimage`);
	assert.equal(image.width, 1200);
	assert.equal(image.caption, "A cover");
	const [webpage] = byType(doc, "WebPage");
	assert.equal(webpage.url, `${ORIGIN}/my-post/`);
	assert.equal(webpage.inLanguage, "en");
	const [website] = byType(doc, "WebSite");
	assert.equal(website.potentialAction["@type"], "SearchAction");
	assert.equal(website.potentialAction.target.urlTemplate, `${ORIGIN}/?s={search_term_string}`);
	const org = byId(doc, `${ORIGIN}/#organization`);
	assert.equal(org.name, "Example");
	assert.equal(org.logo["@type"], "ImageObject");
	assert.equal(org.logo.url, `${ORIGIN}/_emdash/api/media/file/logo.png`);
	assert.equal(byType(doc, "BreadcrumbList").length, 0, "no breadcrumbs unless enabled");
	assertRefsResolve(doc);
});

test("article page without bylines falls back to the articleMeta author name", () => {
	const doc = build(page());
	const [article] = byType(doc, "BlogPosting");
	assert.deepEqual(article.author, { "@type": "Person", name: "Jon Henshaw" });
});

test("non-article content page: typed WebPage, no Article", () => {
	const doc = build(page({ pageType: "website", content: { collection: "pages", id: "p1", slug: "about" }, path: "/about/", url: `${ORIGIN}/about/`, canonical: `${ORIGIN}/about/` }), {
		types: { pages: { pageType: "AboutPage" } },
	});
	assert.equal(byType(doc, "AboutPage").length, 1);
	assert.equal(nodes(doc).some((n) => /Article|Posting/.test(String(n["@type"]))), false);
	assertRefsResolve(doc);
});

test("collection defaults choose the Article subtype", () => {
	const doc = build(page(), { types: { posts: { pageType: "WebPage", articleType: "NewsArticle" } } });
	assert.equal(byType(doc, "NewsArticle").length, 1);
	assert.equal(byType(doc, "BlogPosting").length, 0);
});

test("entry override beats the collection default, and 'none' drops the Article", () => {
	const types = { posts: { articleType: "NewsArticle" } };
	let doc = build(page(), { types, override: { articleType: "TechArticle", pageType: "ItemPage" } });
	assert.equal(byType(doc, "TechArticle").length, 1);
	assert.equal(byType(doc, "ItemPage").length, 1);
	doc = build(page(), { types, override: { articleType: "none" } });
	assert.equal(nodes(doc).some((n) => /Article|Posting/.test(String(n["@type"]))), false);
});

test("home page: WebPage about the publisher, no Article, no breadcrumbs", () => {
	const home = page({ kind: "custom", pageType: "website", content: undefined, path: "/", url: `${ORIGIN}/`, canonical: `${ORIGIN}/`, pageTitle: "Example", articleMeta: undefined, breadcrumbs: undefined });
	const doc = build(home, { breadcrumbs: true });
	const [webpage] = byType(doc, "WebPage");
	assert.deepEqual(webpage.about, { "@id": `${ORIGIN}/#organization` });
	assert.equal(byType(doc, "BreadcrumbList").length, 0);
	assert.equal(nodes(doc).some((n) => /Article|Posting/.test(String(n["@type"]))), false);
	assertRefsResolve(doc);
});

test("home page type comes from the _home key", () => {
	const home = page({ kind: "custom", pageType: "website", content: undefined, path: "/", url: `${ORIGIN}/`, canonical: `${ORIGIN}/` });
	const doc = build(home, { types: { [g.HOME_KEY]: { pageType: "CollectionPage" } } });
	assert.equal(byType(doc, "CollectionPage").length, 1);
});

test("breadcrumbs: [] means none, undefined derives from the path, explicit trail is verbatim", () => {
	let doc = build(page({ breadcrumbs: [] }), { breadcrumbs: true });
	assert.equal(byType(doc, "BreadcrumbList").length, 0);
	assert.equal(byType(doc, "WebPage")[0].breadcrumb, undefined);

	doc = build(page({ path: "/guides/my-post/", url: `${ORIGIN}/guides/my-post/`, canonical: `${ORIGIN}/guides/my-post/` }), { breadcrumbs: true });
	const [derived] = byType(doc, "BreadcrumbList");
	assert.deepEqual(
		derived.itemListElement.map((i) => [i.position, i.name, i.item]),
		[
			[1, "Home", `${ORIGIN}/`],
			[2, "Guides", `${ORIGIN}/guides/`],
			[3, "My Post", `${ORIGIN}/guides/my-post/`],
		],
	);
	assert.deepEqual(byType(doc, "WebPage")[0].breadcrumb, { "@id": derived["@id"] });

	doc = build(page({ breadcrumbs: [{ name: "Home", url: "/" }, { name: "Health", url: "/health/" }] }), { breadcrumbs: true });
	const [explicit] = byType(doc, "BreadcrumbList");
	assert.deepEqual(explicit.itemListElement.map((i) => i.item), [`${ORIGIN}/`, `${ORIGIN}/health/`]);
	assertRefsResolve(doc);
});

test("standalone breadcrumb document when the graph is off", () => {
	assert.equal(g.breadcrumbDocument(page({ breadcrumbs: [] }), ORIGIN), null);
	const doc = g.breadcrumbDocument(page({ path: "/a/b/" }), ORIGIN);
	assert.equal(doc["@type"], "BreadcrumbList");
	assert.equal(doc["@context"], "https://schema.org");
});

test("graph has exactly one node per @id (no duplicate primary entities)", () => {
	const author = { "@type": "Person", "@id": `${ORIGIN}/#person`, name: "Jon" };
	const personPublisher = g.publisherNode({
		details: { publisherType: "person", personBylineId: "b1", orgRows: [] },
		origin: ORIGIN,
		siteName: "Example",
		person: { byline: { id: "b1", slug: "jon", displayName: "Jon" }, rows: null },
	});
	assert.equal(personPublisher["@type"], "Person");
	assert.equal(personPublisher["@id"], `${ORIGIN}/#person`);
	const doc = build(page(), { publisher: personPublisher, authors: [author] });
	assert.equal(nodes(doc).filter((n) => n["@id"] === `${ORIGIN}/#person`).length, 1);
	assert.equal(byType(doc, "WebSite").length, 1);
	assert.equal(byType(doc, "BlogPosting").length, 1);
	assertRefsResolve(doc);
});

test("person publisher without a byline still resolves", () => {
	const node = g.publisherNode({ details: { publisherType: "person", orgRows: [] }, origin: ORIGIN, siteName: "Example", person: null });
	assert.equal(node["@type"], "Organization");
	assert.equal(node.name, "Example");
});

test("shapeRows: repeats become arrays, objects get types, relative URLs become absolute", () => {
	const out = g.shapeRows(
		[
			{ prop: "@id", value: "/#org" },
			{ prop: "@id", value: "/#ignored" },
			{ prop: "name", value: "Coywolf" },
			{ prop: "sameAs", value: "https://x.com/coywolf" },
			{ prop: "sameAs", value: "https://github.com/coywolf" },
			{ prop: "logo", value: "/_emdash/api/media/file/logo.png" },
			{ prop: "founder", value: "Jon Henshaw" },
			{ prop: "address", value: { addressLocality: "Austin", addressRegion: "TX", junk: "" } },
			{ prop: "numberOfEmployees", value: "5" },
			{ prop: "url", value: "javascript:alert(1)" },
			{ prop: "description", value: "   " },
		],
		"Organization",
		ORIGIN,
	);
	assert.equal(out["@id"], `${ORIGIN}/#org`);
	assert.deepEqual(out.sameAs, ["https://x.com/coywolf", "https://github.com/coywolf"]);
	assert.deepEqual(out.logo, { "@type": "ImageObject", url: `${ORIGIN}/_emdash/api/media/file/logo.png` });
	assert.deepEqual(out.founder, { "@type": "Person", name: "Jon Henshaw" });
	assert.deepEqual(out.address, { "@type": "PostalAddress", addressLocality: "Austin", addressRegion: "TX" });
	assert.deepEqual(out.numberOfEmployees, { "@type": "QuantitativeValue", value: 5 });
	assert.equal(out.url, undefined);
	assert.equal(out.description, undefined);
});

test("personNode: rows win, byline fills gaps, author page anchors the id", () => {
	const node = g.personNode({
		byline: { id: "b1", slug: "jon", displayName: "Jon Henshaw", bio: "Writer.", websiteUrl: null, avatarUrl: "/_emdash/api/media/asset/m1/jon.jpg" },
		rows: [
			{ prop: "jobTitle", value: "Founder" },
			{ prop: "sameAs", value: "https://henshaw.social/@jon" },
		],
		origin: ORIGIN,
		defaultId: `${ORIGIN}/author/jon/#person`,
		authorUrl: `${ORIGIN}/author/jon/`,
	});
	assert.equal(node["@id"], `${ORIGIN}/author/jon/#person`);
	assert.equal(node.name, "Jon Henshaw");
	assert.equal(node.jobTitle, "Founder");
	assert.equal(node.url, `${ORIGIN}/author/jon/`);
	assert.equal(node.description, "Writer.");
	assert.equal(node.image, `${ORIGIN}/_emdash/api/media/asset/m1/jon.jpg`);
	assert.equal(g.authorPath("/author/{slug}/", "jon"), "/author/jon/");
	assert.equal(g.authorPath("", "jon"), null);
});

test("headline is capped at 110 characters", () => {
	const doc = build(page({ pageTitle: "x".repeat(200) }));
	assert.ok(byType(doc, "BlogPosting")[0].headline.length <= 110);
});

test("no SearchAction without a {search_term_string} template", () => {
	const doc = build(page(), { searchUrl: "" });
	assert.equal(byType(doc, "WebSite")[0].potentialAction, undefined);
});

test("robots: defaults, noindex merge, nofollow, explicit values kept", () => {
	const defaults = { maxImagePreview: "large", maxSnippet: -1, maxVideoPreview: -1 };
	assert.equal(g.robotsContent(null, defaults), "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1");
	assert.equal(g.robotsContent("noindex, nofollow", defaults), "noindex, nofollow");
	assert.equal(g.robotsContent(null, { ...defaults, nofollow: true }), "index, nofollow, max-image-preview:large, max-snippet:-1, max-video-preview:-1");
	assert.equal(g.robotsContent("max-snippet:50", { maxImagePreview: "", maxSnippet: -1 }), "index, follow, max-snippet:50");
	assert.equal(g.robotsContent("none", defaults), "noindex, nofollow");
});

test("og:locale", () => {
	assert.equal(g.ogLocale("en"), "en_US");
	assert.equal(g.ogLocale("en-GB"), "en_GB");
	assert.equal(g.ogLocale("pt-br"), "pt_BR");
	assert.equal(g.ogLocale("fr"), "fr_FR");
	assert.equal(g.ogLocale("zh-Hant-TW"), "zh_TW");
	assert.equal(g.ogLocale(""), null);
});

test("media URLs map to lookups; foreign or resized URLs don't", () => {
	assert.deepEqual(g.mediaRefFromUrl("/_emdash/api/media/file/01ABC.jpg", ORIGIN), { by: "storage_key", value: "01ABC.jpg" });
	assert.deepEqual(g.mediaRefFromUrl(`${ORIGIN}/_emdash/api/media/asset/m1/cover.jpg`, ORIGIN), { by: "id", value: "m1" });
	assert.equal(g.mediaRefFromUrl("https://cdn.other.com/_emdash/api/media/file/01ABC.jpg", ORIGIN), null);
	assert.equal(g.mediaRefFromUrl("/_emdash/api/media/file/01ABC.jpg?w=600", ORIGIN), null);
	assert.equal(g.mediaRefFromUrl("/images/x.jpg", ORIGIN), null);
});

test("JSON-LD output is plain JSON with no undefined values", () => {
	const doc = build(page({ description: null, articleMeta: {} }), { image: null, tagline: null, language: null });
	const json = JSON.stringify(doc);
	assert.equal(JSON.stringify(JSON.parse(json)), json);
	assert.equal(json.includes("null"), false);
});
