// Run: node --test test/reviews.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const {
	attachReviews,
	dedupeReviews,
	findReviewBlocks,
	listFromHtml,
	listFromLines,
	normalizeReview,
	normalizeStyle,
	pageCss,
	parseRating,
	renderReviewHtml,
	reviewCss,
	reviewDocuments,
	reviewFromAttrs,
	reviewSchema,
	sanitizeCustomCss,
	DEFAULT_ACCENT,
	MAX_CUSTOM_CSS,
} = await import("../src/reviews/lib.ts");

const URL_ = "https://example.com/health/best-decaf/";
const ORIGIN = "https://example.com";

test("parseRating clamps to 0–5 and rounds to halves", () => {
	assert.equal(parseRating(4.5), 4.5);
	assert.equal(parseRating("4.5"), 4.5);
	assert.equal(parseRating("4,5"), 4.5);
	assert.equal(parseRating(4.3), 4.5);
	assert.equal(parseRating(4.2), 4);
	assert.equal(parseRating(7), 5);
	assert.equal(parseRating(-1), 0);
	assert.equal(parseRating(0), 0);
	assert.equal(parseRating(""), null);
	assert.equal(parseRating("great"), null);
	assert.equal(parseRating(null), null);
	assert.equal(parseRating(Number.NaN), null);
});

test("listFromLines trims, drops bullets and blanks, caps items and length", () => {
	assert.deepEqual(listFromLines("- One\n\n• Two \r\n* Three"), ["One", "Two", "Three"]);
	assert.deepEqual(listFromLines(["a", " ", 3]), ["a", "3"]);
	assert.equal(listFromLines(Array.from({ length: 40 }, (_, i) => `x${i}`).join("\n")).length, 20);
	assert.ok(listFromLines("y".repeat(500))[0].length <= 300);
});

test("listFromHtml parses WordPress <ul> HTML to text safely", () => {
	assert.deepEqual(listFromHtml("<ul><li>Swiss Water &amp; CO<sub>2</sub></li><li><strong>Fresh</strong> beans</li></ul>"), ["Swiss Water & CO2", "Fresh beans"]);
	assert.deepEqual(listFromHtml('<ul><li>Bad<script>alert(1)</script></li><li class="x">Fine &#8217;s</li></ul>'), ["Bad", "Fine ’s"]);
	assert.deepEqual(listFromHtml("<ul><li>Unclosed one<li>two</ul>"), ["Unclosed one", "two"]);
	assert.deepEqual(listFromHtml("First<br>Second"), ["First", "Second"]);
	assert.deepEqual(listFromHtml(""), []);
	assert.deepEqual(listFromHtml(undefined), []);
});

test("reviewFromAttrs maps legacy marker attrs to block fields", () => {
	const fields = reviewFromAttrs({
		name: "Decaf &amp; Co",
		brand: "Acme",
		rating: "4.5",
		strengths: "<ul><li>Tastes great</li><li>Cheap</li></ul>",
		shortcomings: "<ul><li>Many roasters don&#39;t use Swiss Water</li></ul>",
	});
	assert.equal(fields.itemName, "Decaf & Co");
	assert.deepEqual(fields.pros, ["Tastes great", "Cheap"]);
	assert.deepEqual(fields.cons, ["Many roasters don't use Swiss Water"]);
	const review = normalizeReview(fields);
	assert.equal(review.rating, 4.5);
	assert.equal(review.itemType, "Product");
	assert.equal(review.brand, "Acme");
	assert.deepEqual(reviewFromAttrs(null), {});
});

test("normalizeReview validates types, URLs, headings and emptiness", () => {
	const r = normalizeReview({
		itemName: "  Thing ",
		itemType: "Spaceship",
		itemUrl: "javascript:alert(1)",
		image: "/media/x.jpg",
		rating: "5",
		pros: "A\nB",
		headingLevel: "3",
	});
	assert.equal(r.itemName, "Thing");
	assert.equal(r.itemType, "Product");
	assert.equal(r.itemUrl, undefined);
	assert.equal(r.image, "/media/x.jpg");
	assert.equal(r.headingLevel, 3);
	assert.equal(r.prosHeading, "What I liked most");
	assert.equal(r.consHeading, "Could be better");
	assert.equal(normalizeReview({ itemUrl: "https://user:pw@example.com/" , rating: 1 }).itemUrl, undefined);
	assert.equal(normalizeReview({ itemUrl: "https://acme.test/p", rating: 1, headingLevel: 9 }).itemUrl, "https://acme.test/p");
	assert.equal(normalizeReview({ itemUrl: "https://acme.test/p", rating: 1, headingLevel: 9 }).headingLevel, 2);
	assert.equal(normalizeReview({ itemName: "Nothing" }), null);
	assert.equal(normalizeReview(null), null);
	assert.equal(normalizeReview({ itemType: "SoftwareApplication", rating: 3 }).itemType, "SoftwareApplication");
});

test("renderReviewHtml escapes text and has accessible rating", () => {
	const html = renderReviewHtml(
		normalizeReview({ itemName: '<img src=x onerror="a">', rating: 4.5, pros: "<b>bold</b>", cons: "a & b", prosHeading: "Liked <3", headingLevel: 3 }),
	);
	assert.ok(!html.includes("<img"));
	assert.ok(!html.includes("<b>"));
	assert.match(html, /aria-label="Review of &lt;img src=x onerror=&quot;a&quot;&gt;"/);
	assert.match(html, /<span class="cw-review__badge" aria-hidden="true">4\.5<\/span>/);
	assert.match(html, /<span class="cw-review__sr">Rated <\/span>4\.5 out of 5/);
	assert.match(html, /<h3 class="cw-review__heading">Liked &lt;3<\/h3>/);
	assert.match(html, /<li class="cw-review__item">a &amp; b<\/li>/);
	assert.match(renderReviewHtml(normalizeReview({ rating: 5, pros: "x" })), />5<\/span>/);
	// No cons: no empty column.
	assert.ok(!renderReviewHtml(normalizeReview({ rating: 5, pros: "x" })).includes("cw-review__cons"));
	// No rating: no badge.
	assert.ok(!renderReviewHtml(normalizeReview({ pros: "x" })).includes("cw-review__badge"));
});

test("custom CSS can't break out of <style>", () => {
	assert.equal(sanitizeCustomCss(".cw-review{color:red}</style><script>alert(1)</script>"), ".cw-review{color:red}><script>alert(1)</script>");
	assert.ok(!/<\/style/i.test(sanitizeCustomCss("</sty</stylele>")));
	assert.ok(!/<\/style/i.test(sanitizeCustomCss("</STYLE >")));
	assert.equal(sanitizeCustomCss("<!-- a --> b"), "a  b");
	assert.equal(sanitizeCustomCss("x".repeat(MAX_CUSTOM_CSS + 50)).length, MAX_CUSTOM_CSS);
	assert.equal(sanitizeCustomCss(42), "");
	const css = pageCss({ accent: "#123456", css: ".cw-review{--cw-review-accent:red}" });
	assert.ok(css.indexOf("--cw-review-accent:red") > css.indexOf(".cw-review__badge"), "custom CSS comes after the built-in CSS");
	assert.match(reviewCss("#123456"), /var\(--cw-review-accent,#123456\)/);
	assert.match(reviewCss("red;}body{x"), new RegExp(`var\\(--cw-review-accent,${DEFAULT_ACCENT}\\)`));
	assert.deepEqual(normalizeStyle({ accent: "nope", css: "</style>" }), { accent: DEFAULT_ACCENT, css: ">" });
});

test("findReviewBlocks walks any Portable Text field", () => {
	const data = {
		title: "x",
		content: [{ _type: "block", children: [] }, { _type: "coywolf-review", itemName: "A", rating: "4" }],
		sidebar: { blocks: [{ _type: "coywolf-review", itemName: "B", rating: "3" }] },
	};
	assert.deepEqual(findReviewBlocks(data).map((b) => b.itemName), ["A", "B"]);
	assert.deepEqual(findReviewBlocks(null), []);
});

const baseGraph = () => ({
	"@context": "https://schema.org",
	"@graph": [
		{ "@type": "WebPage", "@id": `${URL_}#webpage`, url: URL_ },
		{
			"@type": "BlogPosting",
			"@id": `${URL_}#article`,
			author: { "@id": `${ORIGIN}/author/jon/#person` },
			publisher: { "@id": `${ORIGIN}/#organization` },
			datePublished: "2026-01-02T00:00:00Z",
			about: { "@id": "https://www.wikidata.org/wiki/Q1" },
		},
		{ "@type": "WebSite", "@id": `${ORIGIN}/#website`, publisher: { "@id": `${ORIGIN}/#organization` } },
		{ "@type": "Organization", "@id": `${ORIGIN}/#organization`, name: "Well Being" },
	],
});

test("attachReviews: Product with nested Review, ids, ItemList, links, dedupe", () => {
	const graph = baseGraph();
	const product = normalizeReview({ itemName: "Decaf Club", brand: "Acme", itemUrl: "https://acme.test/", image: "/m/a.jpg", rating: "4.5", pros: "A\nB", cons: "C", summary: "Good." });
	const dupe = normalizeReview({ itemName: "decaf club", rating: 2 });
	const app = normalizeReview({ itemName: "CleanMyMac", itemType: "SoftwareApplication", brand: "MacPaw", rating: 5, pros: "Fast" });
	attachReviews(graph, [product, dupe, app], { origin: ORIGIN });
	const nodes = graph["@graph"];
	assert.equal(nodes.length, 6);
	const p = nodes.find((n) => n["@id"] === `${URL_}#review-1-item`);
	assert.equal(p["@type"], "Product");
	assert.deepEqual(p.brand, { "@type": "Brand", name: "Acme" });
	assert.equal(p.image, `${ORIGIN}/m/a.jpg`);
	assert.equal(p.url, "https://acme.test/");
	const r = p.review;
	assert.equal(r["@type"], "Review");
	assert.equal(r["@id"], `${URL_}#review-1`);
	assert.equal(r.itemReviewed, undefined);
	assert.deepEqual(r.reviewRating, { "@type": "Rating", ratingValue: 4.5, bestRating: 5, worstRating: 0 });
	assert.deepEqual(r.author, { "@id": `${ORIGIN}/author/jon/#person` });
	assert.deepEqual(r.publisher, { "@id": `${ORIGIN}/#organization` });
	assert.equal(r.datePublished, "2026-01-02T00:00:00Z");
	assert.deepEqual(r.positiveNotes, {
		"@type": "ItemList",
		itemListElement: [
			{ "@type": "ListItem", position: 1, name: "A" },
			{ "@type": "ListItem", position: 2, name: "B" },
		],
	});
	assert.equal(r.negativeNotes.itemListElement[0].name, "C");
	assert.equal(r.reviewBody, "Good.");
	// Second unique review: a top-level Review with itemReviewed, no brand on SoftwareApplication.
	const s = nodes.find((n) => n["@id"] === `${URL_}#review-2`);
	assert.equal(s["@type"], "Review");
	assert.equal(s.itemReviewed["@type"], "SoftwareApplication");
	assert.equal(s.itemReviewed["@id"], `${URL_}#review-2-item`);
	assert.equal(s.itemReviewed.brand, undefined);
	// Article.about keeps existing entities and adds the items.
	const article = nodes.find((n) => n["@id"] === `${URL_}#article`);
	assert.deepEqual(article.about, [{ "@id": "https://www.wikidata.org/wiki/Q1" }, { "@id": `${URL_}#review-1-item` }, { "@id": `${URL_}#review-2-item` }]);
	// Inserted right after the Article.
	assert.equal(nodes.indexOf(article) + 1, nodes.indexOf(p));
});

test("attachReviews: no Article → WebPage owner, publisher as author; ineligible reviews skipped", () => {
	const graph = baseGraph();
	graph["@graph"].splice(1, 1);
	const self = normalizeReview({ itemName: "Our Shop", itemType: "LocalBusiness", itemUrl: "https://www.example.com/about/", rating: 5 });
	const selfByName = normalizeReview({ itemName: "well being", itemType: "Organization", rating: 5 });
	const noRating = normalizeReview({ itemName: "X", pros: "a" });
	const noName = normalizeReview({ rating: 3 });
	const ok = normalizeReview({ itemName: "Book", itemType: "Book", rating: 3 });
	attachReviews(graph, [self, selfByName, noRating, noName, ok], { origin: ORIGIN });
	const webpage = graph["@graph"][0];
	const reviews = graph["@graph"].filter((n) => n["@type"] === "Review");
	assert.equal(reviews.length, 1);
	assert.deepEqual(reviews[0].author, { "@id": `${ORIGIN}/#organization` });
	assert.deepEqual(webpage.about, { "@id": reviews[0].itemReviewed["@id"] });
});

test("dedupeReviews and attachReviews with nothing", () => {
	const a = normalizeReview({ itemName: "A", rating: 1 });
	assert.equal(dedupeReviews([a, a, normalizeReview({ itemName: "A", itemType: "Book", rating: 1 })]).length, 2);
	const graph = baseGraph();
	attachReviews(graph, [], { origin: ORIGIN });
	assert.equal(graph["@graph"].length, 4);
});

test("reviewDocuments: standalone JSON-LD when the graph is off", () => {
	const docs = reviewDocuments([normalizeReview({ itemName: "Decaf", rating: 4, pros: "a\nb" })], {
		pageUrl: URL_,
		origin: ORIGIN,
		siteName: "Well Being",
		authorName: "Jon Henshaw",
		datePublished: "2026-01-02",
	});
	assert.equal(docs.length, 1);
	const d = docs[0];
	assert.equal(d["@context"], "https://schema.org");
	assert.equal(d["@type"], "Product");
	assert.deepEqual(d.review.author, { "@type": "Person", name: "Jon Henshaw" });
	assert.equal(d.review.publisher.name, "Well Being");
	assert.equal(d.review.mainEntityOfPage, URL_);
	const noAuthor = reviewDocuments([normalizeReview({ itemName: "Game", itemType: "Game", rating: 4 })], { pageUrl: URL_, origin: ORIGIN, siteName: "Site" });
	assert.equal(noAuthor[0].author["@type"], "Organization");
	assert.equal(noAuthor[0].mainEntityOfPage, URL_);
});

test("reviewSchema date validation", () => {
	const r = normalizeReview({ itemName: "X", itemType: "Movie", rating: 3 });
	const node = reviewSchema(r, 1, { pageUrl: URL_, origin: ORIGIN, author: { "@id": "a" }, datePublished: "not a date" });
	assert.equal(node.datePublished, undefined);
	assert.equal(node.itemReviewed.brand, undefined);
});
