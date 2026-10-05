// Run: node --test test/wp-import-general.test.mjs
// The WordPress import helpers any WordPress site uses: reusable blocks, dropped-block report,
// old-site media URLs, redirects (old slugs and redirect plugins) and co-author bylines.
import assert from "node:assert/strict";
import { test } from "node:test";

import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";

import "./ts-resolve.mjs";

const { prepareContent, prepareWxr, wxrReusableBlocks } = await import("../src/wpImport/prepare.ts");
const { convertPortableText } = await import("../src/wpImport/convert.ts");
const U = await import("../src/wpImport/urls.ts");
const R = await import("../src/wpImport/redirects.ts");
const { wxrGuestAuthors, groupGuests, postCredits } = await import("../src/wpImport/guests.ts");
const { validate } = await import("../src/redirects/rules.ts");
const { parseRedirectsImport } = await import("../src/redirects/transfer.ts");

const cdata = (text) => `<![CDATA[${text}]]>`;
const item = (fields, meta = {}, extra = "") =>
	`<item>${Object.entries(fields)
		.map(([k, v]) => `<${k}>${cdata(String(v))}</${k}>`)
		.join("")}${Object.entries(meta)
		.flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((value) => `<wp:postmeta><wp:meta_key>${cdata(k)}</wp:meta_key><wp:meta_value>${cdata(value)}</wp:meta_value></wp:postmeta>`))
		.join("")}${extra}</item>`;
const wxr = (head, items) => `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel>${head}${items.join("\n")}</channel></rss>`;

// ── Prepare: reusable blocks and dropped blocks ──

const PATTERN = '<!-- wp:heading -->\n<h2 class="wp-block-heading" id="sign-up">Sign up</h2>\n<!-- /wp:heading -->\n\n<!-- wp:paragraph -->\n<p>Join the list.</p>\n<!-- /wp:paragraph -->';

test("reusable blocks are inlined from the export, and their heading ids kept", () => {
	const content = '<!-- wp:paragraph -->\n<p>Intro</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:block {"ref":42} /-->';
	const out = prepareContent(content, { reusableBlocks: new Map([[42, PATTERN]]) });
	assert.equal(out.counts["core/block → inlined"], 1);
	assert.equal(out.counts["core/heading → anchor"], 1);
	const pt = convertPortableText(gutenbergToPortableText(out.content), { key: () => "k" }).value;
	assert.deepEqual(
		pt.map((b) => `${b.style ?? b._type}:${b.children?.map((c) => c.text).join("") ?? ""}`),
		["normal:Intro", "h2:Sign up", "normal:Join the list."],
	);
	assert.equal(pt[1].anchor, "sign-up");
	assert.equal(prepareContent(out.content, { reusableBlocks: new Map([[42, PATTERN]]) }).changed, false, "preparing again changes nothing");
});

test("a reusable block that isn't in the export, or that holds itself, can't loop", () => {
	const missing = prepareContent('<!-- wp:block {"ref":7} /-->', { reusableBlocks: new Map() });
	assert.equal(missing.counts["core/block → missing"], 1);
	assert.equal(missing.changed, false);
	const self = prepareContent('<!-- wp:block {"ref":1} /-->', { reusableBlocks: new Map([[1, '<!-- wp:block {"ref":1} /-->\n\n<!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph -->']]) });
	assert.ok(self.counts["core/block → inlined"] >= 1 && self.counts["core/block → inlined"] <= 6);
	assert.equal(self.counts["core/block → missing"], 1, "the innermost reference stays");
});

test("third-party self-closing blocks are counted as dropped and left alone", () => {
	const content = '<!-- wp:acme/newsletter-signup {"list":3} /-->\n\n<!-- wp:paragraph -->\n<p>Hi</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:latest-posts /-->';
	const out = prepareContent(content);
	assert.deepEqual(out.counts, { "acme/newsletter-signup → dropped": 1 });
	assert.equal(out.changed, false);
	assert.equal(out.content, content);
});

test("prepareWxr reads reusable blocks from the export and totals what it only counted", () => {
	const xml = wxr("", [
		item({ title: "Signup", "wp:post_id": 42, "wp:post_type": "wp_block", "content:encoded": PATTERN }),
		item({ title: "Post", "wp:post_id": 5, "wp:post_type": "post", "content:encoded": '<!-- wp:block {"ref":42} /-->' }),
		item({ title: "Other", "wp:post_id": 6, "wp:post_type": "post", "content:encoded": "<!-- wp:acme/widget /-->" }),
	]);
	assert.equal(wxrReusableBlocks(xml).get(42), PATTERN);
	const out = prepareWxr(xml);
	assert.equal(out.counts["core/block → inlined"], 1);
	assert.equal(out.counts["acme/widget → dropped"], 1, "unchanged entries are counted too");
	assert.deepEqual(out.posts.map((p) => p.id), [42, 5], "only changed entries are listed");
	assert.ok(out.xml.includes("Join the list."));
});

// ── Old-site media URLs ──

const HEAD = `<link>https://example.com</link><wp:base_site_url>https://example.com/wp</wp:base_site_url><wp:base_blog_url>https://example.com</wp:base_blog_url>`;

test("the old site's hosts and install folder come from the export", () => {
	const site = U.wxrSite(wxr(HEAD, []));
	assert.deepEqual(site.hosts.sort(), ["example.com", "www.example.com"]);
	assert.deepEqual(site.prefixes, ["/wp"]);
	assert.equal(site.homeUrl, "https://example.com");
	assert.deepEqual(U.parseHosts("cdn.example.net, https://www.example.com/blog"), ["cdn.example.net", "www.cdn.example.net", "www.example.com", "example.com"]);
});

test("finding old URLs: absolute, protocol-relative, relative, Jetpack CDN, install folder; not other sites", () => {
	const re = U.siteUrlPattern(["example.com", "www.example.com"], ["/wp"]);
	const html = [
		'<img src="https://example.com/wp-content/uploads/2020/05/a-300x200.jpg" srcset="https://example.com/wp-content/uploads/2020/05/a-300x200.jpg 300w, //www.example.com/wp-content/uploads/2020/05/a-1024x683.jpg 1024w">',
		'<a href="/wp-content/uploads/2021/01/guide.pdf">PDF</a>.',
		'<img src="https://i0.wp.com/example.com/wp-content/uploads/2019/02/b.png?resize=300%2C200&ssl=1">',
		'<img src="https://example.com/wp/wp-content/themes/acme/logo.svg">',
		'<img src="https://other.com/wp-content/uploads/x.jpg"> see /wp-content/plugins/foo/icon.png, ok',
	].join("\n");
	const found = U.findSiteUrls({ blocks: [{ html }], title: "x" }, re);
	assert.deepEqual([...found.keys()].sort(), [
		"//www.example.com/wp-content/uploads/2020/05/a-1024x683.jpg",
		"/wp-content/plugins/foo/icon.png",
		"/wp-content/uploads/2021/01/guide.pdf",
		"https://example.com/wp-content/uploads/2020/05/a-300x200.jpg",
		"https://example.com/wp/wp-content/themes/acme/logo.svg",
		"https://i0.wp.com/example.com/wp-content/uploads/2019/02/b.png?resize=300%2C200&ssl=1",
	]);
	assert.equal(found.get("https://example.com/wp-content/uploads/2020/05/a-300x200.jpg"), 2);
});

test("size variants, -scaled, -rotated and edits share their original's name", () => {
	for (const name of ["photo.jpg", "Photo-scaled.JPG", "photo-1024x683.jpg", "photo-scaled-300x200.jpg", "photo-e1589912345678.jpg", "photo-e1589912345678-150x150.jpg", "photo-rotated.jpg"]) {
		assert.equal(U.originalName(name), "photo.jpg", name);
	}
	assert.equal(U.originalName("logo-2x.png"), "logo-2x.png");
	assert.equal(U.originalName("1920x1080.png"), "1920x1080.png");
});

test("planning: attachments map to their media file (variants to the original); other files are missing until imported", () => {
	const media = [
		{ id: "m1", filename: "photo-scaled.jpg", url: "/_emdash/api/media/file/01A.jpg" },
		{ id: "m2", filename: "guide.pdf", url: "/_emdash/api/media/file/01B.pdf" },
		{ id: "m3", filename: "dup.png", url: "/_emdash/api/media/file/01C.png" },
		{ id: "m4", filename: "dup.png", url: "/_emdash/api/media/file/01D.png" },
	];
	const attachments = [
		"https://example.com/wp-content/uploads/2020/05/photo-scaled.jpg",
		"https://example.com/wp-content/uploads/2021/01/guide.pdf",
		"https://example.com/wp-content/uploads/2022/03/dup.png",
	];
	const found = new Map([
		["https://example.com/wp-content/uploads/2020/05/photo-1024x683.jpg", 3],
		["https://example.com/wp-content/uploads/2020/05/photo.jpg", 1],
		["/wp-content/uploads/2021/01/guide.pdf", 1],
		["https://example.com/wp-content/uploads/2023/07/never-attached.zip", 1],
		["https://example.com/wp-content/themes/acme/logo.svg", 1],
		["https://example.com/wp-content/uploads/2022/03/dup.png", 1],
		// Same name as an attachment, different month: not that attachment.
		["https://example.com/wp-content/uploads/2018/01/guide.pdf", 1],
	]);
	const plans = U.planSiteUrls(found, media, attachments);
	const by = Object.fromEntries(plans.map((p) => [p.url, p]));
	assert.equal(by["https://example.com/wp-content/uploads/2020/05/photo-1024x683.jpg"].target, "/_emdash/api/media/file/01A.jpg");
	assert.equal(by["https://example.com/wp-content/uploads/2020/05/photo-1024x683.jpg"].note, "Size of photo-scaled.jpg");
	assert.equal(by["https://example.com/wp-content/uploads/2020/05/photo.jpg"].target, "/_emdash/api/media/file/01A.jpg");
	assert.equal(by["/wp-content/uploads/2021/01/guide.pdf"].status, "matched");
	assert.equal(by["https://example.com/wp-content/uploads/2023/07/never-attached.zip"].status, "missing");
	assert.equal(by["https://example.com/wp-content/themes/acme/logo.svg"].status, "missing");
	assert.equal(by["https://example.com/wp-content/uploads/2022/03/dup.png"].status, "ambiguous");
	assert.equal(by["https://example.com/wp-content/uploads/2018/01/guide.pdf"].status, "missing");
	assert.equal(by["/wp-content/uploads/2021/01/guide.pdf"].path, "/wp-content/uploads/2021/01/guide.pdf");

	// Files imported in this session (by path) match, and without the export uploads match by name.
	const after = U.planSiteUrls(found, media, attachments, { "/wp-content/themes/acme/logo.svg": "/_emdash/api/media/file/01E.svg" });
	assert.equal(after.find((p) => p.url.endsWith("logo.svg")).target, "/_emdash/api/media/file/01E.svg");
	const loose = U.planSiteUrls(found, media, null);
	assert.equal(loose.find((p) => p.url.endsWith("2018/01/guide.pdf")).status, "matched");

	const map = U.rewriteMap(plans);
	assert.equal(Object.keys(map).length, 3);
	const redirects = U.uploadRedirects(plans);
	assert.deepEqual(
		redirects.map((r) => r.source),
		["/wp-content/uploads/2020/05/photo-1024x683.jpg", "/wp-content/uploads/2020/05/photo.jpg", "/wp-content/uploads/2021/01/guide.pdf"],
	);
	for (const r of redirects) validate(r);
	assert.deepEqual(parseRedirectsImport(JSON.stringify(redirects)).map((r) => r.source), redirects.map((r) => r.source));
});

test("rewriting replaces only mapped URLs, everywhere in Portable Text, and keeps untouched values identical", () => {
	const map = {
		"https://example.com/wp-content/uploads/2020/05/a-300x200.jpg": "/_emdash/api/media/file/A.jpg",
		"/wp-content/uploads/2021/01/guide.pdf": "/_emdash/api/media/file/B.pdf",
	};
	const untouched = { _type: "block", children: [{ _type: "span", text: "plain" }] };
	const blocks = [
		{ _type: "htmlBlock", html: '<img src="https://example.com/wp-content/uploads/2020/05/a-300x200.jpg"><img src="https://example.com/wp-content/uploads/2020/05/a-300x200.jpg.webp">' },
		{ _type: "block", markDefs: [{ _type: "link", href: "/wp-content/uploads/2021/01/guide.pdf" }], children: [{ _type: "span", text: "See /wp-content/uploads/2021/01/guide.pdf." }] },
		{ _type: "coywolf-testimonial", photo: "https://other.com/wp-content/uploads/2020/05/a-300x200.jpg" },
		untouched,
	];
	const { value, count } = U.rewriteSiteUrls(blocks, map);
	assert.equal(count, 3);
	assert.equal(value[0].html, '<img src="/_emdash/api/media/file/A.jpg"><img src="https://example.com/wp-content/uploads/2020/05/a-300x200.jpg.webp">');
	assert.equal(value[1].markDefs[0].href, "/_emdash/api/media/file/B.pdf");
	assert.equal(value[1].children[0].text, "See /_emdash/api/media/file/B.pdf.");
	assert.equal(value[2], blocks[2], "another site's URL is left");
	assert.equal(value[3], untouched);
	const none = U.rewriteSiteUrls(blocks, {});
	assert.equal(none.value, blocks);
	assert.equal(none.count, 0);
});

test("downloads come from the URL's own site, or the old site for relative URLs", () => {
	assert.equal(U.sourceUrl("/wp-content/uploads/a b.jpg", "https://example.com"), "https://example.com/wp-content/uploads/a%20b.jpg");
	assert.equal(U.sourceUrl("https://i0.wp.com/example.com/wp-content/uploads/b.png?resize=300", "https://x.test"), "https://example.com/wp-content/uploads/b.png");
	assert.equal(U.sourceUrl("//www.example.com/wp-content/uploads/c.png", ""), "https://www.example.com/wp-content/uploads/c.png");
	assert.equal(U.sourceUrl("http://example.com/wp-content/uploads/d.png", ""), "http://example.com/wp-content/uploads/d.png");
});

// ── Redirects ──

const HOSTS = ["example.com", "www.example.com"];

test("PHP serialize reads Rank Math's sources (multibyte strings included)", () => {
	assert.deepEqual(R.phpUnserialize('a:2:{i:0;a:3:{s:7:"pattern";s:8:"old-page";s:10:"comparison";s:5:"exact";s:6:"ignore";s:0:"";}i:1;a:2:{s:7:"pattern";s:7:"café/x";s:10:"comparison";s:5:"start";}}'), [
		{ pattern: "old-page", comparison: "exact", ignore: "" },
		{ pattern: "café/x", comparison: "start" },
	]);
	assert.deepEqual(R.phpUnserialize('a:2:{s:1:"a";b:1;s:1:"b";N;}'), { a: true, b: null });
	assert.equal(R.phpUnserialize('a:1:{i:0;s:9:"short";}'), undefined, "a wrong length isn't read");
	assert.equal(R.phpUnserialize("not serialized"), undefined);
});

test("Redirection rows: URL and regex rules, 410s, absolute targets on the old site become paths; the rest is skipped with a reason", () => {
	const out = R.redirectionRules(
		[
			{ url: "/old/", action_data: "https://www.example.com/new/", action_code: "301", action_type: "url", match_type: "url", regex: "0", status: "enabled" },
			{ url: "^/blog/(.*)", action_data: "/news/$1", action_code: "302", action_type: "url", match_type: "url", regex: "1", status: "enabled" },
			{ url: "/gone", action_data: "", action_code: "410", action_type: "error", match_type: "url", regex: "0", status: "enabled" },
			{ url: "/nf", action_data: "", action_code: "404", action_type: "error", match_type: "url", regex: "0", status: "enabled" },
			{ url: "/off", action_data: "/x", action_code: "301", action_type: "url", match_type: "url", regex: "0", status: "disabled" },
			{ url: "/login-only", action_data: "a:1:{}", action_code: "301", action_type: "url", match_type: "login", regex: "0", status: "enabled" },
			{ url: "/q?x=1", action_data: "/y", action_code: "301", action_type: "url", match_type: "url", regex: "0", status: "enabled" },
			{ url: "/away", action_data: "https://elsewhere.org/", action_code: "308", action_type: "url", match_type: "url", regex: "0", status: "enabled" },
		],
		HOSTS,
	);
	assert.deepEqual(out.rules, [
		{ source: "/old/", target: "/new/", type: 301, isRegex: false, note: "Redirection" },
		{ source: "^/blog/(.*)", target: "/news/$1", type: 302, isRegex: true, note: "Redirection" },
		{ source: "/gone", target: "", type: 410, isRegex: false, note: "Redirection" },
		{ source: "/away", target: "https://elsewhere.org/", type: 308, isRegex: false, note: "Redirection" },
	]);
	assert.deepEqual(out.skipped.map((s) => s.source), ["/nf", "/login-only", "/q?x=1"]);
	for (const r of out.rules) validate(r);
});

test("Rank Math rows: each source becomes a rule (exact, start, end, contains, regex)", () => {
	const sources = 'a:5:{i:0;a:2:{s:7:"pattern";s:3:"old";s:10:"comparison";s:5:"exact";}i:1;a:2:{s:7:"pattern";s:6:"guide/";s:10:"comparison";s:5:"start";}i:2;a:2:{s:7:"pattern";s:4:".php";s:10:"comparison";s:3:"end";}i:3;a:2:{s:7:"pattern";s:4:"temp";s:10:"comparison";s:8:"contains";}i:4;a:2:{s:7:"pattern";s:12:"^tag/(.+)/?$";s:10:"comparison";s:5:"regex";}}';
	const out = R.rankMathRules(
		[
			{ sources, url_to: "https://example.com/new/", header_code: "301", status: "active" },
			{ sources: 'a:1:{i:0;a:2:{s:7:"pattern";s:4:"dead";s:10:"comparison";s:5:"exact";}}', url_to: "", header_code: "410", status: "active" },
			{ sources: 'a:1:{i:0;a:2:{s:7:"pattern";s:4:"skip";s:10:"comparison";s:5:"exact";}}', url_to: "/x", header_code: "301", status: "inactive" },
		],
		HOSTS,
	);
	assert.deepEqual(
		out.rules.map((r) => [r.source, r.isRegex, r.target, r.type]),
		[
			["/old", false, "/new/", 301],
			["^/guide/", true, "/new/", 301],
			["\\.php$", true, "/new/", 301],
			["temp", true, "/new/", 301],
			["^/tag/(.+)/?$", true, "/new/", 301],
			["/dead", false, "", 410],
		],
	);
	assert.ok("/guide/intro".match(new RegExp(out.rules[1].source)));
	for (const r of out.rules) validate(r);
});

test("Yoast and Coywolf SEO rules", () => {
	const yoast = R.yoastRules(
		[
			{ origin: "old-post/", url: "new-post/", type: 301, format: "plain" },
			{ origin: "^cat/(.*)", url: "/topics/$1", type: 307, format: "regex" },
			{ origin: "removed", url: "", type: 451, format: "plain" },
		],
		HOSTS,
	);
	assert.deepEqual(yoast.rules.map((r) => [r.source, r.target, r.type, r.isRegex]), [
		["/old-post/", "/new-post/", 301, false],
		["^/cat/(.*)", "/topics/$1", 307, true],
		["/removed", "", 410, false],
	]);
	const cw = R.coywolfSeoRules([{ source: "/a", target: "https://example.com/b/", type: "301", is_regex: "0" }], HOSTS);
	assert.deepEqual(cw.rules, [{ source: "/a", target: "/b/", type: 301, isRegex: false, note: "Coywolf SEO" }]);
});

test("old slugs redirect to the entry's current permalink, unless another entry uses the old URL", () => {
	const xml = wxr(HEAD, [
		item({ title: "Renamed", link: "https://example.com/2020/05/new-name/", "wp:post_name": "new-name", "wp:post_type": "post", "wp:status": "publish" }, { _wp_old_slug: ["first-name", "second-name", "new-name"] }),
		item({ title: "Taken", link: "https://example.com/2020/05/second-name/", "wp:post_name": "second-name", "wp:post_type": "post", "wp:status": "publish" }),
		item({ title: "Draft", link: "https://example.com/?p=9", "wp:post_name": "draft", "wp:post_type": "post", "wp:status": "draft" }, { _wp_old_slug: "older" }),
		item({ title: "Child", link: "https://example.com/about/team/", "wp:post_name": "team", "wp:post_type": "page", "wp:status": "publish" }, { _wp_old_slug: "staff" }),
	]);
	const out = R.wxrOldSlugRules(xml);
	assert.deepEqual(out.rules.map((r) => [r.source, r.target]), [
		["/2020/05/first-name/", "/2020/05/new-name/"],
		["/about/staff/", "/about/team/"],
	]);
	assert.deepEqual(out.skipped.map((s) => s.source), ["/2020/05/second-name/"]);
	for (const r of out.rules) validate(r);
	// A person's rule beats an old slug for the same source.
	const merged = R.mergeRedirects([{ source: "/2020/05/first-name", target: "/elsewhere/", type: 301, isRegex: false }], out.rules);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].target, "/elsewhere/");
});

// ── Co-authors and guest authors ──

const AUTHORS_HEAD = `<wp:author><wp:author_login>${cdata("jane")}</wp:author_login><wp:author_display_name>${cdata("Jane Doe")}</wp:author_display_name></wp:author>
<wp:author><wp:author_login>sam</wp:author_login><wp:author_display_name>${cdata("Sam Lee")}</wp:author_display_name></wp:author>
<wp:term><wp:term_taxonomy>${cdata("author")}</wp:term_taxonomy><wp:term_slug>${cdata("pat-writer")}</wp:term_slug><wp:term_name>${cdata("Pat Writer")}</wp:term_name><wp:termmeta><wp:meta_key>${cdata("user_url")}</wp:meta_key><wp:meta_value>${cdata("https://pat.example")}</wp:meta_value></wp:termmeta><wp:termmeta><wp:meta_key>${cdata("description")}</wp:meta_key><wp:meta_value>${cdata("<p>Writes things.</p>")}</wp:meta_value></wp:termmeta></wp:term>`;

test("Co-Authors Plus and PublishPress Authors: every author in order, guests with their profile; a post by its own user alone is skipped", () => {
	const authorTerm = (slug, name) => `<category domain="author" nicename="${slug}">${cdata(name)}</category>`;
	const xml = wxr(AUTHORS_HEAD, [
		item({ title: "Guest Kim", "wp:post_id": 50, "wp:post_name": "cap-kim-guest", "wp:post_type": "guest-author", "wp:status": "publish" }, { "cap-display_name": "Kim Guest", "cap-user_login": "kim-guest", "cap-website": "https://kim.example", "cap-description": "Kim <b>bio</b>", _thumbnail_id: "77" }),
		item({ title: "Avatar", "wp:post_id": 77, "wp:post_type": "attachment", "wp:attachment_url": "https://example.com/wp-content/uploads/kim.jpg" }),
		item({ title: "Two authors", "wp:post_id": 1, "wp:post_name": "two-authors", "wp:post_type": "post", "wp:status": "publish", "dc:creator": "jane" }, {}, authorTerm("cap-jane", "jane") + authorTerm("cap-kim-guest", "kim-guest")),
		item({ title: "Solo", "wp:post_id": 2, "wp:post_name": "solo", "wp:post_type": "post", "wp:status": "publish", "dc:creator": "jane" }, {}, authorTerm("cap-jane", "jane")),
		item({ title: "Reassigned", "wp:post_id": 3, "wp:post_name": "reassigned", "wp:post_type": "post", "wp:status": "publish", "dc:creator": "jane" }, {}, authorTerm("cap-sam", "sam")),
		item({ title: "PublishPress", "wp:post_id": 4, "wp:post_name": "pp", "wp:post_type": "page", "wp:status": "publish", "dc:creator": "jane" }, {}, authorTerm("pat-writer", "Pat Writer")),
		item({ title: "Guest plugin", "wp:post_id": 5, "wp:post_name": "guest", "wp:post_type": "post", "wp:status": "publish", "dc:creator": "jane" }, { _guest_author: "Alex Visitor", _guest_author_url: "https://alex.example" }, authorTerm("cap-jane", "jane")),
	]);
	const attachments = new Map([[77, "https://example.com/wp-content/uploads/kim.jpg"]]);
	const guests = wxrGuestAuthors(xml, attachments);
	assert.deepEqual(postCredits(guests), [
		{ collection: "posts", slug: "two-authors", title: "Two authors", names: ["Jane Doe", "Kim Guest"] },
		{ collection: "posts", slug: "reassigned", title: "Reassigned", names: ["Sam Lee"] },
		{ collection: "pages", slug: "pp", title: "PublishPress", names: ["Pat Writer"] },
		{ collection: "posts", slug: "guest", title: "Guest plugin", names: ["Alex Visitor"] },
	]);
	const kim = guests.find((g) => g.name === "Kim Guest");
	assert.deepEqual([kim.url, kim.bio, kim.avatarUrl, kim.source], ["https://kim.example", "Kim bio", "https://example.com/wp-content/uploads/kim.jpg", "co-authors"]);
	const pat = guests.find((g) => g.name === "Pat Writer");
	assert.deepEqual([pat.url, pat.bio], ["https://pat.example", "Writes things."]);
	assert.equal(guests.find((g) => g.name === "Alex Visitor").source, "guest-author");
	const groups = groupGuests(guests);
	assert.deepEqual(groups.map((g) => g.name), ["Jane Doe", "Kim Guest", "Sam Lee", "Pat Writer", "Alex Visitor"]);
	assert.equal(groups.find((g) => g.name === "Kim Guest").avatarFile, "kim.jpg");
});

test("an export without author terms or guest meta has no credits", () => {
	const xml = wxr("", [item({ title: "Plain", "wp:post_id": 1, "wp:post_name": "plain", "wp:post_type": "post", "wp:status": "publish", "dc:creator": "jane" })]);
	assert.deepEqual(wxrGuestAuthors(xml), []);
});
