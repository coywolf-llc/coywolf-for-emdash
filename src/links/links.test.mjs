// Link Manager unit tests: node --test src/links/links.test.mjs (Node 23.6+ strips the TypeScript types).
// Plain JS so tsc (Workers types only) doesn't need Node's types; a resolve hook maps the sources' ".js" imports to ".ts".
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(`${specifier.slice(0, -3)}.ts`, context);
			throw error;
		}
	},
});

const { extractLinks, extractEntryLinks, transformLinks, transformEntry, isInternal, resolveHref, isTrackable } = await import("./pt.ts");
const { classify, isBotWall, nextCheckAt, normalizeIgnore, ruleMatches, isIgnored, isPublicTarget, IgnoreRuleError } = await import("./classify.ts");
const { checkUrl, BudgetExhausted } = await import("./check.ts");

const deepFreeze = (v) => {
	if (v && typeof v === "object") {
		Object.freeze(v);
		for (const child of Object.values(v)) deepFreeze(child);
	}
	return v;
};

const doc = () =>
	deepFreeze([
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [
				{ _type: "link", _key: "l1", href: "https://example.com/a", blank: true },
				{ _type: "link", _key: "l2", href: "/about/" },
				{ _type: "comment", _key: "c1", text: "not a link" },
			],
			children: [
				{ _type: "span", _key: "s1", text: "Read ", marks: [] },
				{ _type: "span", _key: "s2", text: "this", marks: ["strong", "l1"] },
				{ _type: "span", _key: "s3", text: " article", marks: ["l1"] },
				{ _type: "span", _key: "s4", text: " and ", marks: [] },
				{ _type: "span", _key: "s5", text: "about us", marks: ["l2", "em", "c1"] },
			],
		},
		{ _type: "image", _key: "i1", asset: { _ref: "m1", url: "/_emdash/api/media/file/x.jpg" }, link: { href: "https://example.com/a", blank: false }, alt: "x" },
		{ _type: "image", _key: "i2", asset: { _ref: "m2", url: "/media/y.jpg" }, link: "https://legacy.example.org/" },
		{ _type: "buttons", _key: "bt", buttons: [{ _type: "button", _key: "b", text: "Buy", url: "https://shop.example.net/p" }] },
		{ _type: "embed", _key: "e1", url: "https://www.youtube.com/watch?v=abc" },
		{ _type: "iframe", _key: "f1", src: "https://maps.example.com/embed" },
		{
			_type: "columns",
			_key: "col",
			columns: [
				{
					_type: "column",
					_key: "c",
					content: [
						{
							_type: "block",
							_key: "nb",
							markDefs: [{ _type: "link", _key: "n1", href: "https://example.com/a" }],
							children: [{ _type: "span", _key: "ns", text: "nested", marks: ["n1"] }],
						},
					],
				},
			],
		},
		{
			_type: "table",
			_key: "t",
			rows: [
				{
					_type: "tableRow",
					_key: "r",
					cells: [
						{
							_type: "tableCell",
							_key: "tc",
							markDefs: [{ _type: "link", _key: "tl", href: "mailto:hi@example.com" }],
							content: [{ _type: "span", _key: "ts", text: "mail", marks: ["tl"] }],
						},
					],
				},
			],
		},
	]);

// ── Extraction ───────────────────────────────────────────────────

test("extracts link marks with anchor text, linked images, buttons, embeds and nested blocks", () => {
	const links = extractLinks(doc());
	const summary = links.map((l) => `${l.kind}:${l.href}:${l.anchor}`);
	assert.deepEqual(summary, [
		"text:https://example.com/a:this article",
		"text:/about/:about us",
		"image:https://example.com/a:",
		"image:https://legacy.example.org/:",
		"button:https://shop.example.net/p:",
		"embed:https://www.youtube.com/watch?v=abc:",
		"iframe:https://maps.example.com/embed:",
		"text:https://example.com/a:nested",
	]);
});

test("skips mailto, tel, javascript, fragments and media asset URLs", () => {
	assert.equal(isTrackable("mailto:a@b.c"), false);
	assert.equal(isTrackable("tel:123"), false);
	assert.equal(isTrackable("javascript:alert(1)"), false);
	assert.equal(isTrackable("#top"), false);
	assert.equal(isTrackable("ftp://x"), false);
	assert.equal(isTrackable("//cdn.example.com/x"), true);
	assert.ok(!extractLinks(doc()).some((l) => l.href.includes("/media/")));
});

test("extracts from URL fields and only listed fields", () => {
	const data = { body: doc(), website: "https://site.example/", other: [{ _type: "embed", url: "https://ignored.example/" }] };
	const links = extractEntryLinks(data, [
		{ slug: "body", type: "portableText" },
		{ slug: "website", type: "url" },
	]);
	assert.ok(links.some((l) => l.kind === "field" && l.href === "https://site.example/"));
	assert.ok(!links.some((l) => l.href.includes("ignored")));
});

test("internal vs external", () => {
	assert.equal(isInternal("/about/", "https://wellbeing.io"), true);
	assert.equal(isInternal("https://www.wellbeing.io/x", "https://wellbeing.io"), true);
	assert.equal(isInternal("https://example.com/", "https://wellbeing.io"), false);
	assert.equal(resolveHref("/a#frag", "https://wellbeing.io")?.href, "https://wellbeing.io/a");
});

// ── Transforms ───────────────────────────────────────────────────

test("replace rewrites every matching href without mutating the input and keeps other marks", () => {
	const input = doc();
	const before = JSON.stringify(input);
	const { value, changed } = transformLinks(input, (h) => h === "https://example.com/a", { type: "replace", to: "https://example.com/b" });
	assert.equal(JSON.stringify(input), before, "input unchanged");
	assert.equal(changed, 3);
	assert.deepEqual(value[0].markDefs[0], { _type: "link", _key: "l1", href: "https://example.com/b", blank: true });
	assert.deepEqual(value[0].children[1].marks, ["strong", "l1"]);
	assert.deepEqual(value[1].link, { href: "https://example.com/b", blank: false });
	assert.equal(value[6].columns[0].content[0].markDefs[0].href, "https://example.com/b");
	// Untouched subtrees are shared, not copied.
	assert.equal(value[2], input[2]);
	assert.equal(value[7], input[7]);
	assert.equal(extractLinks(value).filter((l) => l.href === "https://example.com/a").length, 0);
});

test("unlink removes the mark def and its key from spans, keeping text and other marks", () => {
	const input = doc();
	const { value, changed, skipped } = transformLinks(input, (h) => h === "/about/", { type: "unlink" });
	assert.equal(changed, 1);
	assert.equal(skipped, 0);
	assert.deepEqual(
		value[0].markDefs.map((d) => d._key),
		["l1", "c1"],
	);
	assert.deepEqual(value[0].children[4], { _type: "span", _key: "s5", text: "about us", marks: ["em", "c1"] });
	assert.equal(value[0].children[1], input[0].children[1], "other spans shared");
	assert.equal(input[0].markDefs.length, 3, "input unchanged");
});

test("unlink drops image links and button URLs but leaves embeds and iframes", () => {
	const input = doc();
	const a = transformLinks(input, (h) => h === "https://example.com/a", { type: "unlink" });
	assert.equal(a.changed, 3);
	assert.equal("link" in a.value[1], false);
	assert.equal(a.value[1].alt, "x");
	assert.equal(a.value[6].columns[0].content[0].children[0].marks.length, 0);
	const b = transformLinks(input, (h) => h === "https://shop.example.net/p", { type: "unlink" });
	assert.equal("url" in b.value[3].buttons[0], false);
	assert.equal(b.value[3].buttons[0].text, "Buy");
	const c = transformLinks(input, (h) => h === "https://maps.example.com/embed", { type: "unlink" });
	assert.equal(c.changed, 0);
	assert.equal(c.skipped, 1);
	assert.equal(c.value, input, "nothing changed, same reference");
});

test("transformEntry returns only changed fields", () => {
	const data = deepFreeze({ body: doc(), website: "https://example.com/a", title: "T" });
	const fields = [
		{ slug: "body", type: "portableText" },
		{ slug: "website", type: "url" },
	];
	const r = transformEntry(data, fields, (h) => h === "https://example.com/a", { type: "replace", to: "/new/" });
	assert.deepEqual(Object.keys(r.patch).sort(), ["body", "website"]);
	assert.equal(r.patch.website, "/new/");
	assert.equal(r.changed, 4);
	const u = transformEntry(data, fields, (h) => h === "https://example.com/a", { type: "unlink" });
	assert.equal(u.skipped, 1, "URL fields can't be unlinked");
	assert.equal("website" in u.patch, false);
});

// ── Classification ───────────────────────────────────────────────

test("status classes", () => {
	assert.equal(classify([{ url: "https://a.test/", code: 200 }], false).status, "ok");
	assert.equal(classify([{ url: "https://a.test/x", code: 404 }], false).status, "broken");
	assert.equal(classify([{ url: "https://a.test/x", code: 500 }], false).status, "broken");
	assert.equal(classify([], false, "Timed out after 10 seconds").status, "error");
	const r = classify(
		[
			{ url: "http://a.test/x", code: 301 },
			{ url: "https://a.test/y", code: 200 },
		],
		false,
	);
	assert.equal(r.status, "redirect");
	assert.equal(r.finalUrl, "https://a.test/y");
	// A trailing-slash-only redirect isn't worth reporting.
	assert.equal(
		classify(
			[
				{ url: "https://a.test/x", code: 301 },
				{ url: "https://a.test/x/", code: 200 },
			],
			false,
		).status,
		"ok",
	);
	const broken = classify(
		[
			{ url: "https://a.test/x", code: 302 },
			{ url: "https://a.test/gone", code: 410 },
		],
		false,
	);
	assert.equal(broken.status, "broken");
	assert.match(broken.note, /302.*410/);
});

test("bot walls are Blocked, not Broken", () => {
	for (const code of [403, 429, 999]) {
		assert.equal(isBotWall(code, new Headers()), true);
		assert.equal(classify([{ url: "https://linkedin.test/", code }], true).status, "blocked");
	}
	assert.equal(isBotWall(503, new Headers({ "cf-mitigated": "challenge" })), true);
	assert.equal(isBotWall(202, new Headers({ "x-amzn-waf-action": "challenge" })), true);
	assert.equal(isBotWall(404, new Headers()), false);
	assert.equal(isBotWall(503, new Headers({ server: "cloudflare" })), false);
});

test("recheck schedule: problems daily, the rest weekly", () => {
	const now = Date.UTC(2026, 0, 1);
	const day = 86_400_000;
	assert.equal(nextCheckAt("broken", now), new Date(now + day).toISOString());
	assert.equal(nextCheckAt("error", now), new Date(now + day).toISOString());
	assert.equal(nextCheckAt("ok", now), new Date(now + 7 * day).toISOString());
	assert.equal(nextCheckAt("blocked", now), new Date(now + 7 * day).toISOString());
});

test("ignore rules", () => {
	const rule = (type, value) => ({ id: "x", type, value: normalizeIgnore(type, value) });
	assert.equal(normalizeIgnore("domain", "https://www.LinkedIn.com/in/x"), "linkedin.com");
	assert.equal(ruleMatches(rule("domain", "linkedin.com"), "https://uk.linkedin.com/in/x"), true);
	assert.equal(ruleMatches(rule("domain", "linkedin.com"), "https://notlinkedin.com/"), false);
	assert.equal(ruleMatches(rule("url", "https://Example.com/a/"), "https://example.com/a"), true);
	assert.equal(ruleMatches(rule("wildcard", "https://example.com/visit/*"), "https://example.com/visit/partner?x=1"), true);
	assert.equal(ruleMatches(rule("wildcard", "https://example.com/visit/*"), "https://example.com/other"), false);
	assert.equal(ruleMatches(rule("regex", "^https://amzn\\.to/"), "https://amzn.to/abc"), true);
	assert.throws(() => normalizeIgnore("regex", "("), IgnoreRuleError);
	assert.throws(() => normalizeIgnore("domain", "not a domain"), IgnoreRuleError);
	assert.equal(isIgnored([rule("domain", "a.test"), rule("url", "https://b.test/x")], "https://b.test/x/"), true);
	assert.equal(isIgnored([], "https://b.test/x/"), false);
});

test("private and local targets are refused", () => {
	for (const u of ["http://localhost/", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://printer.local/"]) {
		assert.equal(isPublicTarget(new URL(u)), false, u);
	}
	assert.equal(isPublicTarget(new URL("https://example.com/")), true);
	assert.equal(isPublicTarget(new URL("http://8.8.8.8/")), true);
});

// ── Checker (fetch stubbed) ──────────────────────────────────────

const stub = (routes) => {
	const calls = [];
	const fetcher = async (url, init) => {
		calls.push(`${init.method} ${url}`);
		const r = routes[`${init.method} ${url}`] ?? routes[url];
		if (!r) throw new Error("getaddrinfo ENOTFOUND");
		if (r === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
		// A plain Response-like object: real fetch can surface statuses (999) the Response constructor rejects.
		return { status: r.status, headers: new Headers(r.headers ?? {}), body: null };
	};
	return { fetcher, calls };
};

test("checker: HEAD ok, redirect chain recorded, GET fallback, budget", async () => {
	let s = stub({ "https://a.test/": { status: 200 } });
	assert.equal((await checkUrl(new URL("https://a.test/"), { left: 10 }, { fetcher: s.fetcher })).status, "ok");
	assert.deepEqual(s.calls, ["HEAD https://a.test/"]);

	s = stub({
		"https://a.test/old": { status: 301, headers: { location: "/new" } },
		"https://a.test/new": { status: 200 },
	});
	const r = await checkUrl(new URL("https://a.test/old"), { left: 10 }, { fetcher: s.fetcher });
	assert.equal(r.status, "redirect");
	assert.deepEqual(
		r.chain.map((h) => h.code),
		[301, 200],
	);

	s = stub({ "HEAD https://a.test/x": { status: 405 }, "GET https://a.test/x": { status: 200 } });
	assert.equal((await checkUrl(new URL("https://a.test/x"), { left: 10 }, { fetcher: s.fetcher })).status, "ok");
	assert.deepEqual(s.calls, ["HEAD https://a.test/x", "GET https://a.test/x"]);

	s = stub({ "https://a.test/gone": { status: 404 } });
	assert.equal((await checkUrl(new URL("https://a.test/gone"), { left: 10 }, { fetcher: s.fetcher })).status, "broken");

	s = stub({ "https://linkedin.test/": { status: 999 } });
	assert.equal((await checkUrl(new URL("https://linkedin.test/"), { left: 10 }, { fetcher: s.fetcher })).status, "blocked");

	s = stub({});
	const dns = await checkUrl(new URL("https://nope.test/"), { left: 10 }, { fetcher: s.fetcher });
	assert.equal(dns.status, "error");
	assert.match(dns.note, /DNS/);

	s = stub({ "https://slow.test/": "timeout" });
	assert.match((await checkUrl(new URL("https://slow.test/"), { left: 10 }, { fetcher: s.fetcher })).note, /Timed out/);

	s = stub({ "https://a.test/r": { status: 302, headers: { location: "http://127.0.0.1/admin" } } });
	assert.equal((await checkUrl(new URL("https://a.test/r"), { left: 10 }, { fetcher: s.fetcher })).status, "error");

	s = stub({ "HEAD https://a.test/x": { status: 405 } });
	await assert.rejects(checkUrl(new URL("https://a.test/x"), { left: 1 }, { fetcher: s.fetcher }), BudgetExhausted);
});
