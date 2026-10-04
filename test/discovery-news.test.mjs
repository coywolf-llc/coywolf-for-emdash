import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { NEWS_WINDOW_MS, buildNewsSitemap, escapeXml, newsLanguage, parseDate, selectNewsArticles } = await import("../src/discovery/news.ts");

const now = Date.parse("2026-10-03T12:00:00Z");
const hoursAgo = (h) => new Date(now - h * 3600_000).toISOString();

test("48-hour window: newest first, excludes old and future entries", () => {
	const picked = selectNewsArticles(
		[
			{ url: "https://e.com/a", title: "A", publishedAt: hoursAgo(1) },
			{ url: "https://e.com/old", title: "Old", publishedAt: hoursAgo(49) },
			{ url: "https://e.com/edge", title: "Edge", publishedAt: new Date(now - NEWS_WINDOW_MS).toISOString() },
			{ url: "https://e.com/b", title: "B", publishedAt: "2026-10-03 02:00:00" }, // SQLite format, UTC
			{ url: "https://e.com/future", title: "Future", publishedAt: hoursAgo(-1) },
			{ url: "https://e.com/bad", title: "Bad", publishedAt: "not a date" },
		],
		now,
	);
	assert.deepEqual(
		picked.map((a) => a.title),
		["A", "B"],
	);
});

test("limit caps the list", () => {
	const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://e.com/${i}`, title: `${i}`, publishedAt: hoursAgo(i + 1) }));
	assert.equal(selectNewsArticles(many, now, 3).length, 3);
});

test("XML escaping in loc, name and title; control characters stripped", () => {
	assert.equal(escapeXml(`a&b<c>"d"'e'\u0001`), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
	const xml = buildNewsSitemap([{ url: "https://e.com/?a=1&b=2", title: "Tom & Jerry <live>", publishedAt: "2026-10-03 10:30:00" }], {
		name: "News & Views",
		language: "en-US",
	});
	assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:news="http:\/\/www\.google\.com\/schemas\/sitemap-news\/0\.9">/);
	assert.ok(xml.includes("<loc>https://e.com/?a=1&amp;b=2</loc>"));
	assert.ok(xml.includes("<news:name>News &amp; Views</news:name>"));
	assert.ok(xml.includes("<news:language>en</news:language>"));
	assert.ok(xml.includes("<news:publication_date>2026-10-03T10:30:00Z</news:publication_date>"));
	assert.ok(xml.includes("<news:title>Tom &amp; Jerry &lt;live&gt;</news:title>"));
	assert.ok(xml.trimEnd().endsWith("</urlset>"));
});

test("empty sitemap is still valid", () => {
	const xml = buildNewsSitemap([], { name: "X", language: "fr" });
	assert.ok(!xml.includes("<url>"));
	assert.ok(xml.includes("</urlset>"));
});

test("language codes", () => {
	assert.equal(newsLanguage("en-GB"), "en");
	assert.equal(newsLanguage("zh-TW"), "zh-tw");
	assert.equal(newsLanguage("zh-Hans"), "zh-cn");
	assert.equal(newsLanguage(""), "en");
	assert.equal(newsLanguage("pt_BR"), "pt");
});

test("dates without an offset are UTC", () => {
	assert.equal(parseDate("2026-10-03 10:00:00")?.toISOString(), "2026-10-03T10:00:00.000Z");
	assert.equal(parseDate("2026-10-03T10:00:00+02:00")?.toISOString(), "2026-10-03T08:00:00.000Z");
	assert.equal(parseDate(null), null);
});
