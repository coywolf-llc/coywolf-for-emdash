// Run: node --test test/wp-import.test.mjs
// Fixtures in test/fixtures/wp/ are verbatim block markup from coywolf.com (one transcript is shortened).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { gutenbergToPortableText, parseGutenbergBlocks } from "@emdash-cms/gutenberg-to-portable-text";

import "./ts-resolve.mjs";

const { parseBlocks, serializeBlocks } = await import("../src/wpImport/gutenberg.ts");
const { prepareContent, prepareWxr, wxrAttachments, repairUnicodeEscapes, cleanCodeHtml } = await import("../src/wpImport/prepare.ts");
const { convertPortableText, convertEntryData, mightNeedConversion, operatingSystems, streamSeconds, listItems } = await import("../src/wpImport/convert.ts");
const { parseMarker, markerHtml } = await import("../src/wpImport/markers.ts");
const { parseStreamEmbed } = await import("../src/wpImport/stream.ts");
const { defaultsFromWordPress, parseFileRows } = await import("../src/wpImport/sources.ts");
const { normalizeReview, reviewSchema } = await import("../src/reviews/lib.ts");
const { findVideoBlocks, buildVideoObject, playerConfig } = await import("../src/videos/lib.ts");
const { stampContent } = await import("../src/headings/stamp.ts");
const { isFileId, isUploadId } = await import("../src/files/format.ts");
const { resolveLanguage } = await import("../src/codeBlocks/render.ts");

const fixture = (name) => readFileSync(new URL(`./fixtures/wp/${name}`, import.meta.url), "utf8");
const keys = () => {
	let n = 0;
	return () => `k${++n}`;
};
/** Prepare → EmDash's own importer conversion → the pack's converter. */
function importFixture(name, opts = {}) {
	const prepared = prepareContent(fixture(name));
	const imported = gutenbergToPortableText(prepared.content);
	return { prepared, imported, result: convertPortableText(imported, { key: keys(), ...opts }) };
}
const ofType = (blocks, type) => blocks.filter((b) => b._type === type);

// ── Parser ───────────────────────────────────────────────────────

test("the block parser round-trips every fixture byte for byte and agrees with WordPress's parser", () => {
	for (const name of ["cloudflare-stream.html", "stream-embeds.html", "video-manager.html", "reviews.html", "toc.html", "file.html", "templates.html", "details.html", "code.html"]) {
		const raw = fixture(name);
		const ours = parseBlocks(raw);
		assert.equal(serializeBlocks(ours), raw, name);
		const names = (list) => list.filter((b) => b.blockName ?? b.name).map((b) => b.blockName ?? b.name);
		assert.deepEqual(names(ours), names(parseGutenbergBlocks(raw)), name);
	}
});

test("without preparing, EmDash's importer drops self-closing Coywolf blocks (why the prepare step exists)", () => {
	const pt = gutenbergToPortableText(fixture("reviews.html") + fixture("toc.html"));
	const json = JSON.stringify(pt);
	assert.ok(!json.includes("Level Bolt"));
	assert.ok(!json.includes("coywolf-seo"));
	// Heading ids are dropped too.
	assert.ok(!json.includes('"what"'));
});

// ── Videos ───────────────────────────────────────────────────────

test("Cloudflare Stream schema blocks merge with their embed HTML into Coywolf Video blocks", () => {
	const { prepared, result } = importFixture("cloudflare-stream.html");
	assert.equal(prepared.counts["coywolf-custom-blocks/cloudflare-stream → video"], 5);
	assert.equal(prepared.counts["core/html → removed"], 5);
	const videos = ofType(result.value, "coywolf-video");
	assert.equal(videos.length, 5);
	assert.equal(ofType(result.value, "htmlBlock").length, 0, "the embed HTML is consumed");

	const [ogc, ulysses, example, qr, shop] = videos;
	assert.deepEqual(
		{ uid: ogc.uid, title: ogc.title, preset: ogc.preset, controls: ogc.controls, autoplay: ogc.autoplay, posterTime: ogc.posterTime, aspect: ogc.aspect },
		{ uid: "5b7349bd06767b1ba66bf2ce566d1440", title: "Open Graph Checker", preset: "standard", controls: true, autoplay: false, posterTime: 1, aspect: 60.674 },
	);
	assert.match(ogc.caption, /^The Open Graph Checker by Coywolf/);
	assert.equal(ogc.showName, false, "the WordPress embed showed no title");
	// GIF-like embed: autoplay, loop, muted, no controls.
	assert.deepEqual([ulysses.autoplay, ulysses.loop, ulysses.muted, ulysses.controls, ulysses.preload], [true, true, true, false, "auto"]);
	// Wrapper whose iframe was stripped on WordPress: the video comes back, sized by the wrapper.
	assert.equal(example.uid, "309289b118775d55f6c0a8a51c4bbd79");
	assert.equal(example.aspect, 76.856);
	// <figure> wrapper with a caption and a phone-width max.
	assert.equal(qr.caption, "Scanning a QR code on a printed article with a smartphone");
	assert.equal(qr.showDescription, true);
	assert.deepEqual([qr.sizeMode, qr.maxWidth], ["maxwidth", 360]);
	assert.deepEqual([shop.sizeMode, shop.maxWidth], ["maxwidth", 344]);

	// Facts for the Videos module's per-video data (length from cs-seconds, size from the wrapper).
	const fact = result.videos.find((v) => v.uid === ogc.uid);
	assert.deepEqual(fact, { uid: ogc.uid, name: "Open Graph Checker", duration: 18, width: 1920, height: 1165, host: "customer-15o8x94gylvqq4v1.cloudflarestream.com" });
});

test("the heading after a video keeps its WordPress id", () => {
	const { result } = importFixture("cloudflare-stream.html");
	const heading = result.value.find((b) => b._type === "block" && b.style === "h2");
	assert.equal(heading.anchor, "install");
});

test("stand-alone Stream embeds (iframes, <stream> elements) become Coywolf Video blocks", () => {
	const { result } = importFixture("stream-embeds.html");
	const videos = ofType(result.value, "coywolf-video");
	assert.equal(videos.length, 4);
	assert.equal(result.value.length, 4);
	assert.equal(videos[0].uid, "a912fd2f954cc035d30bc25caffd06e4");
	assert.equal(videos[0].aspect, 63.683);
	assert.deepEqual([videos[1].autoplay, videos[1].loop, videos[1].muted, videos[1].posterTime], [true, true, true, 7]);
	assert.equal(videos[2].caption, "Demo of VisBug");
	assert.equal(videos[3].title, "Erasing a scribble on a reMarkable 2 tablet");
});

test("Video Manager blocks become Coywolf Video blocks with the plugin's defaults filled in", () => {
	const { result } = importFixture("video-manager.html");
	const [search, firmware, , talk, ogc] = ofType(result.value, "coywolf-video");
	// Autoplaying loop with no controls; unset options took Video Manager's defaults (title and description shown).
	assert.deepEqual(
		{ controls: search.controls, autoplay: search.autoplay, loop: search.loop, muted: search.muted, showName: search.showName, showDescription: search.showDescription },
		{ controls: false, autoplay: true, loop: true, muted: true, showName: true, showDescription: true },
	);
	assert.deepEqual([firmware.sizeMode, firmware.maxWidth, firmware.showName, firmware.aspect], ["maxwidth", 360, false, 178.03]);
	// HTML descriptions become plain text; the block's poster frame is kept.
	assert.equal(talk.caption, "AI Agent, AI Spy presented by Meredith Whittaker and Udbhav Tiwari at 39C3 – CC BY 4.0");
	assert.equal(talk.posterTime, 392);
	assert.deepEqual([ogc.controls, ogc.showDate, ogc.showPlays, ogc.showLikes], [true, true, true, true]);
	const fact = result.videos.find((v) => v.uid === search.uid);
	assert.deepEqual(fact, { uid: search.uid, name: "Coywolf Search", duration: 49.3, width: 1920, height: 1573, created: "2026-07-24T05:20:49.223509Z" });

	// Site settings from WordPress override the plugin defaults.
	const custom = importFixture("video-manager.html", { videoDefaults: defaultsFromWordPress({ show_title: false, likes_enabled: false }, null).video });
	const first = ofType(custom.result.value, "coywolf-video")[0];
	assert.deepEqual([first.showName, first.showLikes], [false, false]);
});

test("converted videos work with the Videos module: index, player options, schema without a Stream token", () => {
	const { result } = importFixture("cloudflare-stream.html");
	const refs = findVideoBlocks({ content: result.value });
	assert.equal(refs.length, 5);
	assert.equal(refs[0].title, "Open Graph Checker");
	const cfg = playerConfig(ofType(result.value, "coywolf-video")[1]);
	assert.deepEqual([cfg.autoplay, cfg.loop, cfg.muted, cfg.controls], [true, true, true, false]);
	const fact = result.videos[0];
	const schema = buildVideoObject({
		ref: refs[0],
		video: { uid: fact.uid, name: fact.name, duration: fact.duration, width: fact.width, height: fact.height },
		host: "customer-15o8x94gylvqq4v1.cloudflarestream.com",
		siteUrl: "https://coywolf.com",
		page: { title: "Open Graph Checker", publishedTime: "2024-09-12T00:00:00Z" },
	});
	assert.equal(schema.duration, "PT18S");
	assert.equal(schema.uploadDate, "2024-09-12T00:00:00Z");
	assert.equal(schema.embedUrl, "https://customer-15o8x94gylvqq4v1.cloudflarestream.com/5b7349bd06767b1ba66bf2ce566d1440/iframe");
	assert.match(schema.thumbnailUrl[0], /time=1s/);
});

test("stream seconds add up hours, minutes and seconds", () => {
	assert.equal(streamSeconds({ "cs-hours": 1, "cs-minutes": 2, "cs-seconds": 3 }), 3723);
	assert.equal(streamSeconds({ "cs-minutes": 1, "cs-seconds": 27 }), 87);
	assert.equal(streamSeconds({}), undefined);
});

test("embed parsing refuses HTML with other content", () => {
	assert.equal(parseStreamEmbed('<p>Hello</p><iframe src="https://iframe.videodelivery.net/a912fd2f954cc035d30bc25caffd06e4"></iframe>'), null);
	assert.equal(parseStreamEmbed('<iframe src="https://www.youtube.com/embed/x"></iframe>'), null);
	assert.equal(parseStreamEmbed("<div></div>"), null);
});

// ── Reviews ──────────────────────────────────────────────────────

test("reviews convert with the item type WordPress used (field, else book or software details)", () => {
	const { result } = importFixture("reviews.html");
	const [bolt, linkpop, seoBook, minimalism, fathom, router] = ofType(result.value, "coywolf-review");
	assert.deepEqual([bolt.itemType, bolt.brand, bolt.rating], ["Product", "Level Home", "4.7"]);
	assert.equal(bolt.pros.split("\n").length, 5);
	assert.equal(bolt.cons, "More expensive than most smart locks");
	assert.equal(bolt.headingLevel, "2");
	assert.deepEqual([linkpop.itemType, linkpop.operatingSystem, linkpop.applicationCategory], ["SoftwareApplication", "macOS, Windows, Linux, iOS, iPadOS, Android", "Page Builder"]);
	assert.deepEqual(
		[seoBook.itemType, seoBook.bookAuthor, seoBook.isbn, seoBook.bookPublisher, seoBook.genre, seoBook.copyrightYear, seoBook.itemUrl],
		["Book", "Eli Schwartz", "978-1544519579", "Houndstooth Press", "Marketing and Sales", "2021", "https://amzn.to/2UHIEOi"],
	);
	// No schema-type field, but book details: WordPress's Book category made it a Book.
	assert.equal(minimalism.itemType, "Book");
	// A list with a missing </li> still splits.
	assert.equal(fathom.pros.split("\n").length, 8);
	assert.ok(fathom.pros.includes("Can import all Google Analytics data"));
	assert.equal(router.pros.split("\n").length, 6);
});

test("converted reviews render and give valid Review schema, with book and software details", () => {
	const { result } = importFixture("reviews.html");
	const blocks = ofType(result.value, "coywolf-review");
	const ctx = { pageUrl: "https://coywolf.com/reviews/x/", origin: "https://coywolf.com", author: { "@id": "https://coywolf.com/#jon" }, publisherName: "Coywolf" };

	const book = normalizeReview(blocks[2]);
	assert.equal(book.rating, 4);
	const bookNode = reviewSchema(book, 1, ctx);
	assert.equal(bookNode["@type"], "Review");
	assert.deepEqual(bookNode.itemReviewed.author, { "@type": "Person", name: "Eli Schwartz" });
	assert.equal(bookNode.itemReviewed.isbn, "978-1544519579");
	assert.deepEqual(bookNode.itemReviewed.publisher, { "@type": "Organization", name: "Houndstooth Press" });
	assert.equal(bookNode.itemReviewed.copyrightYear, 2021);
	assert.equal(bookNode.itemReviewed.url, "https://amzn.to/2UHIEOi");

	const software = reviewSchema(normalizeReview(blocks[1]), 2, ctx);
	assert.equal(software.itemReviewed["@type"], "SoftwareApplication");
	assert.equal(software.itemReviewed.operatingSystem, "macOS, Windows, Linux, iOS, iPadOS, Android");
	assert.equal(software.itemReviewed.applicationCategory, "Page Builder");

	const product = reviewSchema(normalizeReview(blocks[0]), 3, ctx);
	assert.equal(product["@type"], "Product");
	assert.equal(product.review.reviewRating.ratingValue, 4.5, "4.7 rounds to the block's half steps");
	assert.equal(product.review.positiveNotes.itemListElement.length, 5);
	// Book fields never leak onto other types.
	assert.equal(product.isbn, undefined);
});

test("operating systems and list items parse WordPress's field formats", () => {
	assert.equal(operatingSystems('"macOS","Windows"'), "macOS, Windows");
	assert.equal(operatingSystems("macOS, Windows"), "macOS, Windows");
	assert.equal(operatingSystems(""), "");
	assert.deepEqual(listItems("<ul><li>A &amp; B</li><li>C</li></ul>"), ["A & B", "C"]);
});

// ── Table of contents and headings ───────────────────────────────

test("tables of contents and heading ids carry over, and Headings & TOC keeps the ids", () => {
	const { result } = importFixture("toc.html");
	const toc = ofType(result.value, "coywolf-toc")[0];
	assert.deepEqual({ ...toc, _key: undefined }, { _type: "coywolf-toc", _key: undefined, levels: ["2", "3"], listStyle: "bulleted", display: "open", showTitle: "show" });
	const headings = result.value.filter((b) => b._type === "block" && /^h[2-6]$/.test(b.style));
	assert.equal(headings.length, 13);
	assert.deepEqual(headings.slice(0, 3).map((h) => h.anchor), ["what", "why", "solid"]);
	// The Headings & TOC save hook keeps imported anchors (no jump- prefix) and fills the TOC from them.
	const stamped = stampContent({ content: result.value }, { anchors: true, toc: true, prefix: "jump-" });
	const content = stamped.content;
	assert.equal(content.find((b) => b.style === "h2").anchor, "what");
	const list = content.find((b) => b._type === "coywolf-toc")._headings;
	assert.deepEqual(list[0], { level: 2, id: "what", text: "What is a decentralized social network?" });
});

test("TOC options map from Coywolf SEO's attributes", () => {
	const wrap = (attrs) => gutenbergToPortableText(prepareContent(`<!-- wp:coywolf-seo/table-of-contents ${JSON.stringify(attrs)} /-->`).content);
	const one = (attrs) => convertPortableText(wrap(attrs), { key: keys() }).value[0];
	assert.deepEqual([one({}).levels, one({}).listStyle, one({}).display], [["2", "3"], "none", "open"]);
	assert.equal(one({ initiallyCollapsed: true, collapsible: true }).display, "collapsed");
	assert.equal(one({ showTitle: false }).showTitle, "hide");
	assert.equal(one({ title: "📑 Table of contents" }).title, "📑 Table of contents");
	assert.equal(one({ listStyle: "decimal", levels: [2, 3, 4, 5, 6] }).listStyle, "numbered");
});

// ── Files ────────────────────────────────────────────────────────

test("Coywolf Files blocks keep their WordPress file id", () => {
	const { result } = importFixture("file.html");
	const [file] = ofType(result.value, "coywolf-file");
	assert.equal(file.id, "6c1a82a7a33c1d642102");
	assert.equal(file.title, "The Maker's Bill of Rights");
	assert.ok(file.description.startsWith("Make magazine poster"));
	assert.ok(isUploadId(file.id) && isFileId(file.id), "File Downloads resolves WordPress ids from plugin storage");
	assert.ok(!isUploadId("01J9ZQ3W4X5Y6Z7A8B9C0D1E2F"));
});

test("Coywolf Files records parse from wp db query output", () => {
	const rows = parseFileRows(
		"file_id\tobject_key\tfilename\tmime\tsize\tdownloads\tcreated\n6c1a82a7a33c1d642102\tcoywolf-files/2026/08/6c1a82a7a33c1d642102-makers-rights.pdf\tmakers-rights.pdf\tapplication/pdf\t66042\t22\t2026-08-11 20:34:03\n",
	);
	assert.deepEqual(rows[0], {
		file_id: "6c1a82a7a33c1d642102",
		object_key: "coywolf-files/2026/08/6c1a82a7a33c1d642102-makers-rights.pdf",
		filename: "makers-rights.pdf",
		mime: "application/pdf",
		size: "66042",
		downloads: "22",
		created: "2026-08-11 20:34:03",
	});
});

// ── Template blocks, code, others ────────────────────────────────

test("template blocks keep their content as HTML; disclosures and forms leave markers; the newsletter block goes", () => {
	const { prepared, result } = importFixture("templates.html");
	assert.equal(prepared.counts["coywolf-custom-blocks/newsletter → removed"], 1);
	const html = ofType(result.value, "htmlBlock").map((b) => parseMarker(b.html));
	assert.deepEqual(
		html.map((m) => m.name),
		["blockquote", "sidenote", "editorsnote", "transcript", "testimonial", "disclosure", "gravity-form"],
	);
	assert.match(html[0].inner, /<blockquote cite="https:\/\/web\.archive\.org\/[^"]+"><p>My question is/);
	assert.match(html[0].inner, /<figcaption><cite>Jon Cooper, Senior Interaction Designer, Twitter<\/cite><\/figcaption>/);
	assert.match(html[1].inner, /<aside class="sidenote"><h2>&#x1F4CC; Sidenote<\/h2><p><a href=/);
	// The transcript's broken escapes (u003cp) are repaired.
	assert.match(html[3].inner, /<summary>Read the audio transcript<\/summary><div class="transcript__body"><p>Jon Henshaw: I'm with Paul Jarvis/);
	assert.ok(!html[3].inner.includes("u003c"));
	assert.deepEqual(html[6].attrs, { block: "gravityforms/form", formId: "1", title: false });
	// Converting leaves them alone (reported as leftovers).
	assert.equal(result.changes.length, 0);
	assert.equal(result.leftovers["marker:blockquote"], 1);
});

test("testimonial headshots come from the WXR's attachments", () => {
	const block = fixture("templates.html").split("\n\n").find((s) => s.includes("testimonial"));
	const out = prepareContent(block, { attachments: new Map([[712, "https://coywolf.com/wp-content/uploads/aj.jpg"]]) });
	assert.match(parseMarker(gutenbergToPortableText(out.content)[0].html).inner, /<img alt="AJ Kohn" height="60" width="60" src="https:\/\/coywolf\.com\/wp-content\/uploads\/aj\.jpg">/);
});

test("core Details blocks keep their summary", () => {
	const { result } = importFixture("details.html");
	assert.equal(result.value.length, 1);
	assert.match(parseMarker(result.value[0].html).inner, /^<details class="wp-block-details"><summary>Read full transcript<\/summary>\n<p>Jon Henshaw: Welcome/);
});

test("code blocks: Prism language names map to the editor's, bold markup and &#91; are cleaned", () => {
	const { result } = importFixture("code.html");
	const [html, json] = ofType(result.value, "code");
	assert.equal(html.language, "html");
	assert.equal(html.code, '<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">');
	assert.ok(json.code.startsWith('"icons": [\n  { "src"'));
	assert.equal(resolveLanguage("markup").id, "html");
	assert.equal(cleanCodeHtml('<pre class="wp-block-code"><code>a &lt;b&gt;</code></pre>'), null);
});

test("repairUnicodeEscapes only touches text that lost its backslashes", () => {
	assert.equal(repairUnicodeEscapes("u003cpu003eHiu003c/pu003e"), "<p>Hi</p>");
	assert.equal(repairUnicodeEscapes("<p>Plain u0041</p>"), "<p>Plain u0041</p>");
});

// ── Idempotence, other shapes, WXR ───────────────────────────────

test("converting twice changes nothing; preparing twice changes nothing", () => {
	for (const name of ["cloudflare-stream.html", "video-manager.html", "reviews.html", "toc.html", "templates.html"]) {
		const { prepared, result } = importFixture(name);
		assert.equal(convertPortableText(result.value).changed, false, name);
		assert.equal(prepareContent(prepared.content).changed, false, name);
	}
});

test("an export that wasn't prepared still converts Video Manager and file blocks (importer fallback)", () => {
	const pt = gutenbergToPortableText(fixture("video-manager.html") + fixture("file.html"));
	assert.equal(pt[0]._type, "htmlBlock");
	assert.equal(pt[0].originalBlockName, "coywolf/video");
	const out = convertPortableText(pt, { key: keys() });
	assert.deepEqual(out.value.map((b) => b._type), ["coywolf-video", "coywolf-video", "coywolf-video", "coywolf-video", "coywolf-video", "coywolf-file"]);
});

test("wellbeing.io's data-wb-block markers convert too", () => {
	const wb = (name, attrs) => ({ _type: "htmlBlock", _key: "w", html: `<div data-wb-block="${name}" data-wb-attrs="${JSON.stringify(attrs).replace(/"/g, "&quot;")}"></div>` });
	const out = convertPortableText([
		wb("cloudflare-stream", { id: "19d6d4ab3b82d549a4f8238fc159aa3f", host: "customer-abc.cloudflarestream.com", aspect: 62.5, name: "Demo", description: "A demo", seconds: 3 }),
		wb("review", { name: "Decaf", brand: "Acme", rating: "4.5", strengths: "<ul><li>Smooth</li></ul>", shortcomings: "<ul><li>Pricey</li></ul>" }),
		wb("jsonld", { "@type": "Thing" }),
	]);
	assert.deepEqual(
		{ ...out.value[0] },
		{ _type: "coywolf-video", _key: "w", uid: "19d6d4ab3b82d549a4f8238fc159aa3f", preset: "gif", title: "Demo", caption: "A demo", aspect: 62.5 },
	);
	assert.deepEqual([out.value[1].itemName, out.value[1].pros, out.value[1].cons], ["Decaf", "Smooth", "Pricey"]);
	assert.equal(out.value[2]._type, "htmlBlock");
	assert.equal(out.videos[0].duration, 3);
});

test("convertEntryData converts every Portable Text field and leaves other fields", () => {
	const data = { title: "T", content: [{ _type: "htmlBlock", _key: "a", html: markerHtml("toc", { listStyle: "disc" }) }], sidebar: [{ _type: "block", _key: "b", children: [] }] };
	assert.ok(mightNeedConversion(data));
	const out = convertEntryData(data);
	assert.equal(out.value.title, "T");
	assert.equal(out.value.content[0]._type, "coywolf-toc");
	assert.equal(out.value.sidebar, data.sidebar);
	assert.ok(!mightNeedConversion({ content: [{ _type: "block", children: [] }] }));
});

test("prepareWxr rewrites only content:encoded, keeps CDATA safe, and reads attachments", () => {
	const content = `${fixture("toc.html")}<!-- wp:code -->\n<pre class="wp-block-code"><code>a ]]&gt; b</code></pre>\n<!-- /wp:code -->`;
	const cdata = (text) => `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
	const xml = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel>
<item><title>${cdata("Decentralized ]]> social")}</title><wp:post_id>174</wp:post_id><wp:post_type>${cdata("post")}</wp:post_type><content:encoded>${cdata(content + "\n<p>x ]]> y</p>")}</content:encoded></item>
<item><title>Logo</title><wp:post_id>712</wp:post_id><wp:post_type>${cdata("attachment")}</wp:post_type><wp:attachment_url>${cdata("https://coywolf.com/wp-content/uploads/aj.jpg")}</wp:attachment_url><content:encoded>${cdata("")}</content:encoded></item>
</channel></rss>`;
	assert.equal(wxrAttachments(xml).get(712), "https://coywolf.com/wp-content/uploads/aj.jpg");
	const out = prepareWxr(xml);
	assert.equal(out.posts.length, 1);
	assert.equal(out.posts[0].id, 174);
	assert.equal(out.counts["core/heading → anchor"], 13);
	const body = out.xml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/)[1];
	const text = [...body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]).join("");
	assert.ok(text.includes("<p>x ]]> y</p>"), "a literal ]]> survives");
	assert.ok(text.includes('data-coywolf-wp="toc"'));
	assert.ok(out.xml.includes("<title><![CDATA[Decentralized ]]]]><![CDATA[> social]]></title>"), "other elements are untouched");
	assert.equal(prepareWxr(out.xml).posts.length, 0, "preparing a prepared file changes nothing");
});

test("Video Manager and Coywolf Files settings map to converter defaults", () => {
	const d = defaultsFromWordPress(
		{ controls: true, autoplay: false, loop: false, mute: false, preload: "metadata", show_title: true, show_desc: false, show_date: "1", plays_enabled: 0, likes_enabled: true },
		{ show_icon: true, show_description: false, show_meta: true, show_download: true, show_copy_link: false },
	);
	assert.deepEqual(d.video, { controls: true, autoplay: false, loop: false, mute: false, showName: true, showDescription: false, showDate: true, showPlays: false, showLikes: true, preload: "metadata" });
	assert.deepEqual(d.files, { showIcon: true, showDescription: false, showMeta: true, showDownload: true, showCopyLink: false });
});
