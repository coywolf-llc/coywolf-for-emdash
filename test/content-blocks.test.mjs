// Run: node --test test/content-blocks.test.mjs
// test/fixtures/wp/content-blocks.html is verbatim block markup from coywolf.com.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";

import "./ts-resolve.mjs";

const { renderRich, plainText, safeUrl, cleanStyle } = await import("../src/contentBlocks/rich.ts");
const R = await import("../src/contentBlocks/render.ts");
const { prepareContent, prepareWxr } = await import("../src/wpImport/prepare.ts");
const { convertPortableText, noteBlock, detailsBlock, quoteBlock } = await import("../src/wpImport/convert.ts");
const { markerHtml } = await import("../src/wpImport/markers.ts");
const { wxrGuestAuthors, groupGuests, bylineSlug, bioText, collectionFor, sameName } = await import("../src/wpImport/guests.ts");

const fixture = (name) => readFileSync(new URL(`./fixtures/wp/${name}`, import.meta.url), "utf8");
const keys = () => {
	let n = 0;
	return () => `k${++n}`;
};

// ── Rich text ────────────────────────────────────────────────────

test("rich text: paragraphs, line breaks, markdown-style links and bold", () => {
	assert.equal(renderRich("One & two <3\n\nSecond\nline"), "<p>One &amp; two &lt;3</p><p>Second<br>line</p>");
	assert.equal(renderRich("See [the guide](https://example.com/a?b=1&c=2) and **this**."), '<p>See <a href="https://example.com/a?b=1&amp;c=2">the guide</a> and <strong>this</strong>.</p>');
	assert.equal(renderRich("[bad](javascript:alert(1))"), "<p>[bad](javascript:alert(1))</p>");
	assert.equal(renderRich("Title &amp; more", { inline: true }), "Title &amp; more");
	assert.equal(renderRich("a\nb", { inline: true }), "a<br>b");
	assert.equal(renderRich(""), "");
	assert.equal(renderRich(null), "");
});

test("rich text: keeps WordPress's inline HTML, drops what isn't safe", () => {
	assert.equal(
		renderRich('Adding <strong><code>VideoObject</code></strong> <a href="/guides/x/" rel="sponsored nofollow bogus" onclick="x()">Schema</a> <abbr title="top-level domains">TLDs</abbr>'),
		'<p>Adding <strong><code>VideoObject</code></strong> <a href="/guides/x/" rel="sponsored nofollow">Schema</a> <abbr title="top-level domains">TLDs</abbr></p>',
	);
	assert.equal(renderRich('<a href="javascript:alert(1)">x</a><a href=" jav&#x09;ascript:alert(1)">y</a>'), "<p><a>x</a><a>y</a></p>");
	assert.equal(renderRich('<script>alert(1)</script>ok<style>p{}</style>'), "<p>ok</p>");
	assert.equal(renderRich('<img src="x" onerror="alert(1)"><img src="data:image/png;base64,AAAA">'), '<img src="x">');
	assert.equal(renderRich('<div class="x" style="position:fixed">in</div><iframe src="https://e.com"></iframe>'), "<p>in</p>");
	assert.equal(renderRich('<code style="color:green;font-size:90%;background:url(x)">c</code>'), '<p><code style="color:green;font-size:90%">c</code></p>');
	assert.equal(renderRich('"><svg onload=alert(1)>'), "<p>\"&gt;</p>");
	assert.equal(renderRich("<!-- comment -->text"), "<p>text</p>");
});

test("rich text: unbalanced tags are closed or dropped so the page around the block stays intact", () => {
	assert.equal(renderRich("<strong>open\n\nnext</strong> <em>x"), "<p><strong>open</strong></p><p>next <em>x</em></p>");
	assert.equal(renderRich("</p></div></aside>after"), "<p>after</p>");
	assert.equal(renderRich("<ul><li>one<li>two</ul>"), "<ul><li>one<li>two</li></li></ul>");
	assert.equal(renderRich("<p>a</p>\n\n\n\n<p>b</p>"), "<p>a</p><p>b</p>");
	assert.equal(renderRich("<blockquote>q"), "<blockquote>q</blockquote>");
	assert.equal(renderRich("<p>x</p><h2>T</h2>", { inline: true }), "xT", "block tags aren't allowed in inline fields");
});

test("safeUrl, cleanStyle and plainText", () => {
	assert.equal(safeUrl("https://example.com/"), "https://example.com/");
	assert.equal(safeUrl("/path#x"), "/path#x");
	assert.equal(safeUrl("mailto:a@b.c"), "mailto:a@b.c");
	assert.equal(safeUrl("JavaScript:x"), null);
	assert.equal(safeUrl("data:text/html,x"), null);
	assert.equal(cleanStyle("color: red; position: absolute; font-weight:700"), "color:red;font-weight:700");
	assert.equal(cleanStyle("color: expression(x)"), "");
	assert.equal(plainText('Chad <a href="x">via m</a> &amp; **co**'), "Chad via m & co");
});

// ── Blocks ───────────────────────────────────────────────────────

test("Note: an aside labelled by its title; hidden title labels it with aria-label; escapes the title", () => {
	const note = R.normalizeNote({ variant: "tip", title: "Pro <b>tip</b>", titleTag: "h3", body: "Text **bold**" });
	assert.equal(
		R.renderNoteHtml(note, "cw-note-k1"),
		'<aside class="cw-note cw-note--tip" aria-labelledby="cw-note-k1"><h3 class="cw-note__title" id="cw-note-k1">Pro <b>tip</b></h3><div class="cw-note__body"><p>Text <strong>bold</strong></p></div></aside>',
	);
	const hidden = R.renderNoteHtml(R.normalizeNote({ variant: "editor", hideTitle: true, body: "x" }), "id");
	assert.match(hidden, /^<aside class="cw-note cw-note--editor" aria-label="Editor&#39;s note"><div class="cw-note__body">/);
	const defaulted = R.normalizeNote({ variant: "nope", titleTag: "h1", body: "x" });
	assert.deepEqual([defaulted.variant, defaulted.titleTag], ["note", "p"]);
	assert.match(R.renderNoteHtml(defaulted, "i"), /<p class="cw-note__title" id="i">Note<\/p>/);
	assert.equal(R.renderNoteHtml(R.normalizeNote({}), "i"), "");
	assert.match(R.renderNoteHtml(R.normalizeNote({ title: '"><script>x</script>', body: "b" }), 'a"b'), /aria-labelledby="a&quot;b"/);
});

test("Details: native details/summary, open option, transcript style", () => {
	assert.equal(
		R.renderDetailsHtml(R.normalizeDetails({ summary: "More <em>info</em>", body: "Hidden", open: true })),
		'<details class="cw-details cw-details--details" open><summary class="cw-details__summary">More <em>info</em></summary><div class="cw-details__body"><p>Hidden</p></div></details>',
	);
	assert.match(R.renderDetailsHtml(R.normalizeDetails({ variant: "transcript", body: "<p>JH: Hi</p>" })), /^<details class="cw-details cw-details--transcript"><summary class="cw-details__summary">Read the transcript<\/summary>/);
	assert.equal(R.renderDetailsHtml(R.normalizeDetails({})), "");
});

test("Affiliate disclosure: the site's wording (affiliate or Amazon), the block's own, and an optional link", () => {
	const s = R.normalizeDisclosureSettings({ affiliateText: "Supported by [partnership links](https://coywolf.com/partnerships/).", linkUrl: "javascript:x" });
	assert.equal(s.linkUrl, "");
	assert.equal(s.amazonText, R.DEFAULT_DISCLOSURE.amazonText);
	assert.equal(
		R.renderDisclosureHtml(R.normalizeDisclosure({ kind: "affiliate" }), s),
		'<aside class="cw-disclosure cw-disclosure--affiliate" aria-label="Affiliate disclosure"><p class="cw-disclosure__text">Supported by <a href="https://coywolf.com/partnerships/">partnership links</a>.</p></aside>',
	);
	const linked = R.normalizeDisclosureSettings({ linkUrl: "/disclosures/", linkText: "How we earn <money>" });
	assert.match(R.renderDisclosureHtml(R.normalizeDisclosure({ kind: "amazon" }), linked), /As an Amazon Associate I earn from qualifying purchases\. <a class="cw-disclosure__link" href="\/disclosures\/">How we earn &lt;money&gt;<\/a><\/p><\/aside>$/);
	assert.match(R.renderDisclosureHtml(R.normalizeDisclosure({ kind: "amazon", text: "Our own words" }), linked), /aria-label="Amazon Associates disclosure"><p class="cw-disclosure__text">Our own words /);
});

test("Quote: figure with blockquote cite and a cited caption; unsafe source URLs are dropped", () => {
	assert.equal(
		R.renderQuoteHtml(R.normalizeQuote({ quote: "Line one\n\nLine two", citation: 'Chad <a href="https://m.social/@c">via m</a>', sourceUrl: "https://m.social/@c/1" })),
		'<figure class="cw-quote"><blockquote class="cw-quote__text" cite="https://m.social/@c/1"><p>Line one</p><p>Line two</p></blockquote><figcaption class="cw-quote__caption"><cite>Chad <a href="https://m.social/@c">via m</a></cite></figcaption></figure>',
	);
	assert.doesNotMatch(R.renderQuoteHtml(R.normalizeQuote({ quote: "q", sourceUrl: "javascript:alert(1)" })), /cite=/);
	assert.equal(R.renderQuoteHtml(R.normalizeQuote({ citation: "only" })), "");
});

test("the shared CSS is theme-agnostic (currentColor mixes) and has dark-mode accents", () => {
	assert.match(R.CONTENT_BLOCKS_CSS, /color-mix\(in srgb,currentColor/);
	assert.match(R.CONTENT_BLOCKS_CSS, /prefers-color-scheme:dark/);
	assert.ok(!R.CONTENT_BLOCKS_CSS.includes("</style"));
});

// ── WordPress import ─────────────────────────────────────────────

function importFixture(name, opts = {}) {
	const prepared = prepareContent(fixture(name));
	return { prepared, result: convertPortableText(gutenbergToPortableText(prepared.content), { key: keys(), ...opts }) };
}

test("coywolf.com disclosures, notes and quotes convert to Content Blocks, content exact", () => {
	const { prepared, result } = importFixture("content-blocks.html");
	assert.deepEqual(prepared.counts, {
		"coywolf-custom-blocks/ftc → disclosure": 1,
		"coywolf-custom-blocks/amazon → disclosure": 1,
		"genesis-custom-blocks/disclosure → disclosure": 1,
		"coywolf-custom-blocks/editorsnote → note": 1,
		"coywolf-custom-blocks/sidenote → note": 2,
		"coywolf-custom-blocks/blockquote → quote": 3,
	});
	const v = result.value;
	assert.deepEqual(v.map((b) => b._type), ["coywolf-disclosure", "coywolf-disclosure", "coywolf-disclosure", "coywolf-note", "coywolf-note", "coywolf-note", "coywolf-quote", "coywolf-quote", "coywolf-quote"]);
	assert.deepEqual(v.slice(0, 3).map((b) => b.kind), ["affiliate", "amazon", "affiliate"]);
	assert.ok(v[3].body.startsWith('<p><strong>On December 13, 2024, sub.club announced <a href="https://web.archive.org/web/20241217042218/https://mastodon.social/@subclub/113646793698065585">they are shutting down</a>.</strong></p> <p><q cite='));
	assert.equal(v[4].body, '<p>If you don\'t have a Fathom Analytics account, use <a href="https://usefathom.com/ref/AANN81" rel="sponsored">this link</a> to get $10 off.</p>');
	assert.equal(v[5].body, 'Google doesn\'t penalize sites or lower its rankings if it uses <code><strong>rel="sponsored"</strong></code>. Case in point, Coywolf Reviews uses them, and most of its reviews rank well in Google Search.');
	assert.equal(v[6].citation, 'Chad Podoski <a href="https://mastodon.social/@chadpod/116569643204260383">via mastodon.social</a>');
	assert.equal(v[6].sourceUrl, "https://mastodon.social/@chadpod/116569643204260383");
	assert.ok(v[6].quote.includes("velocity.\n\nI’d rather"));
	assert.equal(v[7].sourceUrl, undefined);
	assert.ok(v[7].quote.includes("<ol>"));
	// A cite field that lost its escapes (cite=u0022…u0022) still gives the URL, and the citation's markup is repaired.
	assert.equal(v[8].sourceUrl, "https://developers.google.com/search/docs/advanced/appearance/favicon-in-search");
	assert.match(v[8].citation, /^Guidelines section from <a href="https:\/\/developers\.google\.com\//);

	// Rendered: the sponsored rel, <q cite>, ordered lists and the code styling survive.
	const html = v.map((b) =>
		b._type === "coywolf-note" ? R.renderNoteHtml(R.normalizeNote(b), "n") : b._type === "coywolf-quote" ? R.renderQuoteHtml(R.normalizeQuote(b)) : "",
	);
	assert.match(html[3], /<h2 class="cw-note__title" id="n">📝 Editor's Note<\/h2><div class="cw-note__body"><p><strong>On December 13/);
	assert.match(html[3], /<q cite="https:\/\/web\.archive\.org\/web\/20241217042218\/https:\/\/mastodon\.social\/@subclub\/113646793698065585">Thank you/);
	assert.match(html[4], /rel="sponsored">this link<\/a>/);
	assert.match(html[6], /<blockquote class="cw-quote__text" cite="https:\/\/mastodon\.social\/@chadpod\/116569643204260383"><p>For security-critical software, .*<\/p><p>I’d rather/);
	assert.match(html[7], /<code style="color:green;font-size:90%">DefinedTerm<\/code>/);
	assert.match(html[7], /<ol><li>/);

	assert.equal(convertPortableText(v).changed, false, "converting twice changes nothing");
	assert.equal(prepareContent(prepared.content).changed, false, "preparing twice changes nothing");
});

test("0.10.0 markers (no fields, only WordPress's markup) still convert", () => {
	const sidenote = markerHtml("sidenote", {}, '<aside class="sidenote"><h2>&#x1F4CC; Sidenote</h2><p><a href="https://x.com/">Listen</a></p></aside>');
	const transcript = markerHtml("transcript", {}, '<details class="transcript"><summary>Read the audio transcript</summary><div class="transcript__body"><p>JH: Hi</p></div></details>');
	const details = markerHtml("details", {}, '<details class="wp-block-details" open><summary>Why?</summary>\n<p>Because.</p>\n</details>');
	const quote = markerHtml("blockquote", {}, '<figure class="wp-custom-blockquote"><blockquote cite="https://a.com/?x=1&amp;y=2"><p>Q</p></blockquote><figcaption><cite>Someone</cite></figcaption></figure>');
	const out = convertPortableText([sidenote, transcript, details, quote].map((html, i) => ({ _type: "htmlBlock", _key: `h${i}`, html })));
	assert.deepEqual(out.value.map((b) => b._type), ["coywolf-note", "coywolf-details", "coywolf-details", "coywolf-quote"]);
	assert.equal(out.value[0].body, '<p><a href="https://x.com/">Listen</a></p>');
	assert.deepEqual([out.value[1].variant, out.value[1].summary, out.value[1].body], ["transcript", "Read the audio transcript", "<p>JH: Hi</p>"]);
	assert.deepEqual([out.value[2].summary, out.value[2].body, out.value[2].open], ["Why?", "<p>Because.</p>", true]);
	assert.deepEqual([out.value[3].quote, out.value[3].citation, out.value[3].sourceUrl], ["<p>Q</p>", "Someone", "https://a.com/?x=1&y=2"]);
	assert.equal(out.value[0]._key, "h0", "keys are kept");
	// Unrecognized markup is left alone.
	assert.equal(noteBlock("sidenote", {}, "<p>other</p>"), null);
	assert.equal(detailsBlock("details", {}, "<div>x</div>"), null);
	assert.equal(quoteBlock({}, "<p>x</p>"), null);
});

// ── Guest authors ────────────────────────────────────────────────

const cdata = (text) => `<![CDATA[${text}]]>`;
const meta = (key, value) => `<wp:postmeta><wp:meta_key>${cdata(key)}</wp:meta_key><wp:meta_value>${cdata(value)}</wp:meta_value></wp:postmeta>`;
// Values verbatim from coywolf.com (post 3546 and its avatar attachment).
const GUEST_WXR = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel>
<item><title>${cdata("Why crypto is a waste of energy, full of crime, and isn't really decentralized")}</title><wp:post_id>3546</wp:post_id><wp:post_name>${cdata("why-crypto-is-a-waste-of-energy-full-of-crime-and-isnt-really-decentralized")}</wp:post_name><wp:post_type>${cdata("post")}</wp:post_type><content:encoded>${cdata("<p>x</p>")}</content:encoded>
${meta("_guest_author", "David Rosenthal")}${meta("_guest_author_url", "https://blog.dshr.org/")}${meta("_guest_author_bio", "David S. H. Rosenthal (born 1948) is a British-American computer scientist who co-developed Sun's NeWS windowing system, authored the X Window System's ICCCM, and was Nvidia's fourth employee and chief scientist. He later led the LOCKSS digital preservation project at Stanford, earning the 2025 Paul Evan Peters Award.")}${meta("_guest_author_avatar_id", "10671")}</item>
<item><title>Other</title><wp:post_id>12</wp:post_id><wp:post_name>other</wp:post_name><wp:post_type>${cdata("post")}</wp:post_type>${meta("_guest_author", "")}</item>
<item><title>Avatar</title><wp:post_id>10671</wp:post_id><wp:post_type>${cdata("attachment")}</wp:post_type><wp:attachment_url>${cdata("https://coywolf.com/wp-content/uploads/2022/02/david.s.h.rosenthal.jpg")}</wp:attachment_url></item>
</channel></rss>`;

test("guest authors are read from the export's post meta, with the avatar's URL", () => {
	const guests = prepareWxr(GUEST_WXR).guestAuthors;
	assert.equal(guests.length, 1, "an empty name means no guest");
	const [g] = guests;
	assert.deepEqual(
		{ postId: g.postId, postType: g.postType, slug: g.slug, name: g.name, url: g.url, avatarId: g.avatarId, avatarUrl: g.avatarUrl },
		{
			postId: 3546,
			postType: "post",
			slug: "why-crypto-is-a-waste-of-energy-full-of-crime-and-isnt-really-decentralized",
			name: "David Rosenthal",
			url: "https://blog.dshr.org/",
			avatarId: 10671,
			avatarUrl: "https://coywolf.com/wp-content/uploads/2022/02/david.s.h.rosenthal.jpg",
		},
	);
	assert.ok(g.bio.startsWith("David S. H. Rosenthal (born 1948)"));
	assert.deepEqual(wxrGuestAuthors(GUEST_WXR), [{ ...g, avatarUrl: "" }], "without attachments there's no avatar URL");
});

test("guests group into bylines by name, with a valid slug and the avatar's file name", () => {
	const [g] = wxrGuestAuthors(GUEST_WXR, new Map([[10671, "https://coywolf.com/wp-content/uploads/2022/02/david.s.h.rosenthal.jpg"]]));
	const groups = groupGuests([g, { ...g, slug: "second", name: " david  rosenthal ", url: "", bio: "" }]);
	assert.equal(groups.length, 1);
	assert.deepEqual(
		{ name: groups[0].name, slug: groups[0].slug, url: groups[0].url, avatarFile: groups[0].avatarFile, posts: groups[0].posts.length },
		{ name: "David Rosenthal", slug: "david-rosenthal", url: "https://blog.dshr.org/", avatarFile: "david.s.h.rosenthal.jpg", posts: 2 },
	);
	assert.equal(bylineSlug("José Ñúñez Jr."), "jose-nunez-jr");
	assert.equal(bylineSlug("3D Printing Co"), "d-printing-co");
	assert.equal(bylineSlug("文字"), "guest");
	assert.ok(sameName("David Rosenthal", "david rosenthal"));
	assert.equal(collectionFor("post"), "posts");
	assert.equal(collectionFor("page"), "pages");
	assert.equal(bioText("<p>One &amp; <strong>two</strong></p><p>Three</p>"), "One & two\nThree");
});
