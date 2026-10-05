// Run: node --test test/block-render.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { renderTocHtml, SAMPLE_TOC_HEADINGS } = await import("../src/headings/render.ts");
const { buildTocTree } = await import("../src/headings/toc.ts");
const { renderFileCardHtml, SAMPLE_FILE } = await import("../src/files/card.ts");

const toc = (o = {}) =>
	renderTocHtml(buildTocTree(SAMPLE_TOC_HEADINGS, o.levels ?? [2, 3]), {
		title: "Table of contents",
		showTitle: true,
		listStyle: "none",
		display: "open",
		smooth: false,
		titleId: "t",
		...o,
	});

test("TOC: open with title, nested by level", () => {
	const html = toc();
	assert.match(html, /^<nav class="cw-toc cw-toc--none" aria-labelledby="t"><h2 id="t" class="cw-toc__title">Table of contents<\/h2><ul class="cw-toc__list">/);
	assert.match(html, /<li><a href="#jump-getting-started">Getting started<\/a><ul><li><a href="#jump-what-you-need">/);
	assert.doesNotMatch(html, /A quick tip/); // H4 not listed
});

test("TOC: hidden title uses aria-label; numbered uses ol; collapsed uses details", () => {
	assert.match(toc({ showTitle: false }), /aria-label="Table of contents"/);
	assert.doesNotMatch(toc({ showTitle: false }), /<h2/);
	assert.match(toc({ listStyle: "numbered" }), /<ol class="cw-toc__list">/);
	assert.match(toc({ display: "collapsed" }), /<details class="cw-toc__details"><summary/);
	assert.match(toc({ display: "collapsible" }), /<details class="cw-toc__details" open>/);
	assert.match(toc({ smooth: true }), / data-smooth>/);
});

test("TOC: escapes heading text, ids and title", () => {
	const html = renderTocHtml([{ level: 2, id: 'x"><script>', text: "<b>&</b>", children: [] }], {
		title: "<i>T</i>",
		showTitle: true,
		listStyle: "none",
		display: "open",
		smooth: false,
		titleId: "t",
	});
	assert.doesNotMatch(html, /<script>|<b>|<i>/);
	assert.match(html, /&lt;b&gt;&amp;&lt;\/b&gt;/);
});

test("TOC: the title's heading level follows titleTag (h2 by default, only h2–h6)", () => {
	assert.match(toc({ titleTag: "h3" }), /<h3 id="t" class="cw-toc__title">Table of contents<\/h3>/);
	assert.match(toc({ titleTag: "p" }), /<h2 id="t" class="cw-toc__title">/);
	assert.match(toc({ titleTag: "h3", display: "collapsible" }), /<summary class="cw-toc__summary"><span id="t"/);
});

test("File card: scheme, accent, meta and toggles", () => {
	const html = renderFileCardHtml(SAMPLE_FILE, { scheme: "dark", accent: "#b22d47" });
	assert.match(html, /^<div class="cw-file cw-file--dark" style="--cw-file-accent:#b22d47">/);
	assert.match(html, /PDF · 2\.4 MB · Uploaded Mar 4, 2026/);
	assert.match(html, />PDF<\/text>/);
	const bare = renderFileCardHtml(SAMPLE_FILE, { scheme: "auto", accent: "red;x", showIcon: false, showDownload: false, showCopyLink: false, showMeta: false, showDescription: false });
	assert.match(bare, /^<div class="cw-file cw-file--auto">/);
	assert.doesNotMatch(bare, /cw-file__icon|cw-file__download|cw-file__copy|cw-file__meta|cw-file__desc/);
});

test("File card: escapes title, description and links", () => {
	const html = renderFileCardHtml({ ...SAMPLE_FILE, title: '"><img src=x>', description: "<script>", absolute: 'https://x/"a' }, { scheme: "light", accent: "" });
	assert.doesNotMatch(html, /<img|<script>/);
	assert.match(html, /data-cw-file-url="https:\/\/x\/&quot;a"/);
});
