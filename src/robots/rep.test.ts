/**
 * REP conformance tests, ported from Google's robots_test.cc
 * (https://github.com/google/robotstxt) via Coywolf SEO's PHP suite, plus
 * the RFC 9309 examples. Run: node --test src/robots/*.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import * as REP from "./rep.ts";

const rep = REP as typeof import("./rep.js");
const al = (robots: string, agent: string, url: string) => rep.oneAgentAllowed(robots, agent, url);

test("GoogleOnly_SystemTest", () => {
	const r1 = "user-agent: FooBot\ndisallow: /\n";
	assert.equal(al("", "FooBot", ""), true);
	assert.equal(al(r1, "", ""), true);
	assert.equal(al(r1, "FooBot", ""), false);
	assert.equal(al("", "", ""), true);
});

test("ID_LineSyntax_Line (missing colon)", () => {
	const u = "http://foo.bar/x/y";
	assert.equal(al("user-agent: FooBot\ndisallow: /\n", "FooBot", u), false);
	assert.equal(al("foo: FooBot\nbar: /\n", "FooBot", u), true);
	assert.equal(al("user-agent FooBot\ndisallow /\n", "FooBot", u), false);
});

test("ID_LineSyntax_Groups (group merging)", () => {
	const g =
		"allow: /foo/bar/\n\nuser-agent: FooBot\ndisallow: /\nallow: /x/\nuser-agent: BarBot\ndisallow: /\nallow: /y/\n\n\nallow: /w/\nuser-agent: BazBot\n\nuser-agent: FooBot\nallow: /z/\ndisallow: /\n";
	assert.equal(al(g, "FooBot", "http://foo.bar/x/b"), true);
	assert.equal(al(g, "FooBot", "http://foo.bar/z/d"), true);
	assert.equal(al(g, "FooBot", "http://foo.bar/y/c"), false);
	assert.equal(al(g, "BarBot", "http://foo.bar/y/c"), true);
	assert.equal(al(g, "BarBot", "http://foo.bar/w/a"), true);
	assert.equal(al(g, "BarBot", "http://foo.bar/z/d"), false);
	assert.equal(al(g, "BazBot", "http://foo.bar/z/d"), true);
	assert.equal(al(g, "FooBot", "http://foo.bar/foo/bar/"), false);
	assert.equal(al(g, "BarBot", "http://foo.bar/foo/bar/"), false);
	assert.equal(al(g, "BazBot", "http://foo.bar/foo/bar/"), false);
});

test("ID_LineSyntax_Groups_OtherRules", () => {
	const o1 = "User-agent: BarBot\nSitemap: https://foo.bar/sitemap\nUser-agent: *\nDisallow: /\n";
	assert.equal(al(o1, "FooBot", "http://foo.bar/"), false);
	assert.equal(al(o1, "BarBot", "http://foo.bar/"), false);
	const o2 = "User-agent: FooBot\nInvalid-Unknown-Line: unknown\nUser-agent: *\nDisallow: /\n";
	assert.equal(al(o2, "FooBot", "http://foo.bar/"), false);
	assert.equal(al(o2, "BarBot", "http://foo.bar/"), false);
});

test("ID_REPLineNamesCaseInsensitive", () => {
	for (const r of [
		"USER-AGENT: FooBot\nALLOW: /x/\nDISALLOW: /\n",
		"user-agent: FooBot\nallow: /x/\ndisallow: /\n",
		"uSeR-aGeNt: FooBot\nAlLoW: /x/\ndIsAlLoW: /\n",
	]) {
		assert.equal(al(r, "FooBot", "http://foo.bar/x/y"), true);
		assert.equal(al(r, "FooBot", "http://foo.bar/a/b"), false);
	}
});

test("ID_VerifyValidUserAgentsToObey", () => {
	assert.equal(rep.isValidUserAgentToObey("Foobot"), true);
	assert.equal(rep.isValidUserAgentToObey("Foobot-Bar"), true);
	assert.equal(rep.isValidUserAgentToObey("Foo_Bar"), true);
	for (const bad of ["", "ツ", "Foobot*", " Foobot ", "Foobot/2.1", "Foobot Bar"]) {
		assert.equal(rep.isValidUserAgentToObey(bad), false, bad);
	}
});

test("ID_UserAgentValueCaseInsensitive", () => {
	for (const name of ["FOO BAR", "foo bar", "FoO bAr"]) {
		const r = `User-Agent: ${name}\nAllow: /x/\nDisallow: /\n`;
		for (const agent of ["Foo", "foo"]) {
			assert.equal(al(r, agent, "http://foo.bar/x/y"), true);
			assert.equal(al(r, agent, "http://foo.bar/a/b"), false);
		}
	}
});

test("GoogleOnly_AcceptUserAgentUpToFirstSpace", () => {
	const sp = "User-Agent: *\nDisallow: /\nUser-Agent: Foo Bar\nAllow: /x/\nDisallow: /\n";
	assert.equal(al(sp, "Foo", "http://foo.bar/x/y"), true);
	assert.equal(al(sp, "Foo Bar", "http://foo.bar/x/y"), false);
});

test("ID_GlobalGroups_Secondary", () => {
	const global = "user-agent: *\nallow: /\nuser-agent: FooBot\ndisallow: /\n";
	const only = "user-agent: FooBot\nallow: /\nuser-agent: BarBot\ndisallow: /\nuser-agent: BazBot\ndisallow: /\n";
	const u = "http://foo.bar/x/y";
	assert.equal(al("", "FooBot", u), true);
	assert.equal(al(global, "FooBot", u), false);
	assert.equal(al(global, "BarBot", u), true);
	assert.equal(al(only, "QuxBot", u), true);
});

test("ID_AllowDisallow_Value_CaseSensitive", () => {
	assert.equal(al("user-agent: FooBot\ndisallow: /x/\n", "FooBot", "http://foo.bar/x/y"), false);
	assert.equal(al("user-agent: FooBot\ndisallow: /X/\n", "FooBot", "http://foo.bar/x/y"), true);
});

test("ID_LongestMatch", () => {
	const ux = "http://foo.bar/x/page.html";
	assert.equal(al("user-agent: FooBot\ndisallow: /x/page.html\nallow: /x/\n", "FooBot", ux), false);
	assert.equal(al("user-agent: FooBot\nallow: /x/page.html\ndisallow: /x/\n", "FooBot", ux), true);
	assert.equal(al("user-agent: FooBot\nallow: /x/page.html\ndisallow: /x/\n", "FooBot", "http://foo.bar/x/"), false);
	assert.equal(al("user-agent: FooBot\ndisallow: \nallow: \n", "FooBot", ux), true);
	assert.equal(al("user-agent: FooBot\ndisallow: /\nallow: /\n", "FooBot", ux), true);
	assert.equal(al("user-agent: FooBot\ndisallow: /x\nallow: /x/\n", "FooBot", "http://foo.bar/x"), false);
	assert.equal(al("user-agent: FooBot\ndisallow: /x\nallow: /x/\n", "FooBot", "http://foo.bar/x/"), true);
	assert.equal(al("user-agent: FooBot\ndisallow: /x/page.html\nallow: /x/page.html\n", "FooBot", ux), true);
	assert.equal(al("user-agent: FooBot\nallow: /page\ndisallow: /*.html\n", "FooBot", "http://foo.bar/page.html"), false);
	assert.equal(al("user-agent: FooBot\nallow: /page\ndisallow: /*.html\n", "FooBot", "http://foo.bar/page"), true);
	assert.equal(al("user-agent: FooBot\nallow: /x/page.\ndisallow: /*.html\n", "FooBot", ux), true);
	assert.equal(al("user-agent: FooBot\nallow: /x/page.\ndisallow: /*.html\n", "FooBot", "http://foo.bar/x/y.html"), false);
	const grp = "User-agent: *\nDisallow: /x/\nUser-agent: FooBot\nDisallow: /y/\n";
	assert.equal(al(grp, "FooBot", "http://foo.bar/x/page"), true);
	assert.equal(al(grp, "FooBot", "http://foo.bar/y/page"), false);
});

test("ID_Encoding", () => {
	assert.equal(
		al(
			"User-agent: FooBot\nDisallow: /\nAllow: /foo/bar?qux=taz&baz=http://foo.bar?tar&par\n",
			"FooBot",
			"http://foo.bar/foo/bar?qux=taz&baz=http://foo.bar?tar&par",
		),
		true,
	);
	const utf = "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/ツ\n";
	assert.equal(al(utf, "FooBot", "http://foo.bar/foo/bar/%E3%83%84"), true);
	assert.equal(al(utf, "FooBot", "http://foo.bar/foo/bar/ツ"), false);
	const enc = "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/%E3%83%84\n";
	assert.equal(al(enc, "FooBot", "http://foo.bar/foo/bar/%E3%83%84"), true);
	assert.equal(al(enc, "FooBot", "http://foo.bar/foo/bar/ツ"), false);
	const baz = "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/%62%61%7A\n";
	assert.equal(al(baz, "FooBot", "http://foo.bar/foo/bar/baz"), false);
	assert.equal(al(baz, "FooBot", "http://foo.bar/foo/bar/%62%61%7A"), true);
});

test("ID_SpecialCharacters", () => {
	const s1 = "User-agent: FooBot\nDisallow: /foo/bar/quz\nAllow: /foo/*/qux\n";
	assert.equal(al(s1, "FooBot", "http://foo.bar/foo/bar/quz"), false);
	assert.equal(al(s1, "FooBot", "http://foo.bar/foo/quz"), true);
	assert.equal(al(s1, "FooBot", "http://foo.bar/foo//quz"), true);
	assert.equal(al(s1, "FooBot", "http://foo.bar/foo/bax/quz"), true);
	const s2 = "User-agent: FooBot\nDisallow: /foo/bar$\nAllow: /foo/bar/qux\n";
	assert.equal(al(s2, "FooBot", "http://foo.bar/foo/bar"), false);
	assert.equal(al(s2, "FooBot", "http://foo.bar/foo/bar/qux"), true);
	assert.equal(al(s2, "FooBot", "http://foo.bar/foo/bar/"), true);
	assert.equal(al(s2, "FooBot", "http://foo.bar/foo/bar/baz"), true);
	const s3 = "User-agent: FooBot\n# Disallow: /\nDisallow: /foo/quz#qux\nAllow: /\n";
	assert.equal(al(s3, "FooBot", "http://foo.bar/foo/bar"), true);
	assert.equal(al(s3, "FooBot", "http://foo.bar/foo/quz"), false);
});

test("GoogleOnly_IndexHTMLisDirectory", () => {
	const idx = "User-Agent: *\nAllow: /allowed-slash/index.html\nDisallow: /\n";
	assert.equal(al(idx, "foobot", "http://foo.com/allowed-slash/"), true);
	assert.equal(al(idx, "foobot", "http://foo.com/allowed-slash/index.htm"), false);
	assert.equal(al(idx, "foobot", "http://foo.com/allowed-slash/index.html"), true);
	assert.equal(al(idx, "foobot", "http://foo.com/anyother-url"), false);
});

test("GoogleOnly_LineTooLong", () => {
	const maxLine = 2083 * 8;
	const maxLen = maxLine - "/x/".length - "disallow: ".length + 1;
	const longline = "/x/" + "a".repeat(Math.max(0, maxLen - 3));
	const rt = `user-agent: FooBot\ndisallow: ${longline}/qux\n`;
	assert.equal(al(rt, "FooBot", "http://foo.bar/fux"), true);
	assert.equal(al(rt, "FooBot", `http://foo.bar${longline}/fux`), false);

	const maxLen2 = maxLine - "/x/".length - "allow: ".length + 1;
	let la = "/x/";
	let lb = "/x/";
	while (la.length < maxLen2) {
		la += "a";
		lb += "b";
	}
	const rt2 = `user-agent: FooBot\ndisallow: /\nallow: ${la}/qux\nallow: ${lb}/qux\n`;
	assert.equal(al(rt2, "FooBot", "http://foo.bar/"), false);
	assert.equal(al(rt2, "FooBot", `http://foo.bar${la}/qux`), true);
	assert.equal(al(rt2, "FooBot", `http://foo.bar${lb}/fux`), true);
});

test("GoogleOnly_DocumentationChecks", () => {
	const base = "http://foo.bar";
	const check = (robots: string, cases: Record<string, boolean>) => {
		for (const [p, want] of Object.entries(cases)) assert.equal(al(robots, "FooBot", base + p), want, `${robots.split("\n")[2]} ${p}`);
	};
	check("user-agent: FooBot\ndisallow: /\nallow: /fish\n", {
		"/bar": false, "/fish": true, "/fish.html": true, "/fish/salmon.html": true, "/fishheads": true,
		"/fishheads/yummy.html": true, "/fish.html?id=anything": true, "/Fish.asp": false, "/catfish": false, "/?id=fish": false,
	});
	check("user-agent: FooBot\ndisallow: /\nallow: /fish*\n", {
		"/bar": false, "/fish": true, "/fish.html": true, "/fish/salmon.html": true, "/fishheads": true,
		"/fishheads/yummy.html": true, "/fish.html?id=anything": true, "/Fish.bar": false, "/catfish": false, "/?id=fish": false,
	});
	check("user-agent: FooBot\ndisallow: /\nallow: /fish/\n", {
		"/fish/": true, "/fish/salmon": true, "/fish/?salmon": true, "/fish/salmon.html": true,
		"/fish/?id=anything": true, "/fish": false, "/fish.html": false, "/Fish/Salmon.html": false,
	});
	check("user-agent: FooBot\ndisallow: /\nallow: /*.php\n", {
		"/bar": false, "/filename.php": true, "/folder/filename.php": true, "/folder/filename.php?parameters": true,
		"//folder/any.php.file.html": true, "/filename.php/": true, "/index?f=filename.php/": true, "/php/": false,
		"/index?php": false, "/windows.PHP": false,
	});
	check("user-agent: FooBot\ndisallow: /\nallow: /*.php$\n", {
		"/bar": false, "/filename.php": true, "/folder/filename.php": true, "/filename.php?parameters": false,
		"/filename.php/": false, "/filename.php5": false, "/php/": false, "/filename?php": false, "/aaaphpaaa": false,
		"//windows.PHP": false,
	});
	check("user-agent: FooBot\ndisallow: /\nallow: /fish*.php\n", {
		"/fish.php": true, "/fishheads/catfish.php?parameters": true, "/Fish.PHP": false,
	});
	const ex = "http://example.com";
	assert.equal(al("user-agent: FooBot\nallow: /p\ndisallow: /\n", "FooBot", `${ex}/page`), true);
	assert.equal(al("user-agent: FooBot\nallow: /folder\ndisallow: /folder\n", "FooBot", `${ex}/folder/page`), true);
	assert.equal(al("user-agent: FooBot\nallow: /page\ndisallow: /*.htm\n", "FooBot", `${ex}/page.htm`), false);
	assert.equal(al("user-agent: FooBot\nallow: /$\ndisallow: /\n", "FooBot", `${ex}/`), true);
	assert.equal(al("user-agent: FooBot\nallow: /$\ndisallow: /\n", "FooBot", `${ex}/page.html`), false);
});

test("TestGetPathParamsQuery", () => {
	const cases: [string, string][] = [
		["", "/"], ["http://www.example.com", "/"], ["http://www.example.com/", "/"], ["http://www.example.com/a", "/a"],
		["http://www.example.com/a/", "/a/"], ["http://www.example.com/a/b?c=http://d.e/", "/a/b?c=http://d.e/"],
		["http://www.example.com/a/b?c=d&e=f#fragment", "/a/b?c=d&e=f"], ["example.com", "/"], ["example.com/", "/"],
		["example.com/a", "/a"], ["example.com/a/", "/a/"], ["example.com/a/b?c=d&e=f#fragment", "/a/b?c=d&e=f"],
		["a", "/"], ["a/", "/"], ["/a", "/a"], ["a/b", "/b"], ["example.com?a", "/?a"], ["example.com/a;b#c", "/a;b"],
		["//a/b/c", "/b/c"],
	];
	for (const [input, want] of cases) assert.equal(rep.pathParamsQuery(input), want, input);
});

test("TestMaybeEscapePattern", () => {
	assert.equal(rep.escapePattern("http://www.example.com"), "http://www.example.com");
	assert.equal(rep.escapePattern("/a/b/c"), "/a/b/c");
	assert.equal(rep.escapePattern(rep.toBytes("á")), "%C3%A1");
	assert.equal(rep.escapePattern("%aa"), "%AA");
});

test("parser: line endings, BOM, sitemap", () => {
	const counts = (body: string) => {
		const { directives } = rep.parse(body);
		const valid = directives.filter((d: { type: string }) => d.type !== "unknown").length;
		return { valid, unknown: directives.length - valid, last: directives.at(-1)?.line ?? 0 };
	};
	for (const body of [
		"User-Agent: foo\nAllow: /some/path\nUser-Agent: bar\n\n\nDisallow: /\n",
		"User-Agent: foo\r\nAllow: /some/path\r\nUser-Agent: bar\r\n\r\n\r\nDisallow: /\r\n",
		"User-Agent: foo\rAllow: /some/path\rUser-Agent: bar\r\r\rDisallow: /\r",
		"User-Agent: foo\nAllow: /some/path\nUser-Agent: bar\n\n\nDisallow: /",
		"User-Agent: foo\nAllow: /some/path\r\nUser-Agent: bar\n\r\n\nDisallow: /",
	]) {
		const c = counts(body);
		assert.equal(c.valid, 4);
		assert.equal(c.last, 6);
	}
	assert.deepEqual(counts("﻿User-Agent: foo\nAllow: /AnyValue\n").unknown, 0);
	assert.deepEqual(counts("﻿User-Agent: foo\nAllow: /AnyValue\n").valid, 2);
	// (Google's partial-BOM cases are about raw byte streams; robots.txt arrives here as decoded text.)
	const mid = counts("User-Agent: foo\n﻿Allow: /AnyValue\n");
	assert.equal(mid.valid, 1);
	assert.equal(mid.unknown, 1);
	const sitemap = (body: string) => rep.parse(body).directives.find((d: { type: string }) => d.type === "sitemap")?.value;
	assert.equal(sitemap("User-Agent: foo\nAllow: /some/path\nUser-Agent: bar\n\n\nSitemap: http://foo.bar/sitemap.xml\n"), "http://foo.bar/sitemap.xml");
	assert.equal(sitemap("Sitemap: http://foo.bar/sitemap.xml\nUser-Agent: foo\nAllow: /some/path\nUser-Agent: bar\n\n\n"), "http://foo.bar/sitemap.xml");
});

test("RFC 9309 §2.2.1: groups naming the same agent are merged", () => {
	const r = "User-agent: ExampleBot\nDisallow: /foo\n\nUser-agent: *\nDisallow: /\n\nUser-agent: ExampleBot\nDisallow: /bar\n";
	assert.equal(al(r, "ExampleBot", "https://example.com/foo/x"), false);
	assert.equal(al(r, "ExampleBot", "https://example.com/bar/x"), false);
	assert.equal(al(r, "ExampleBot", "https://example.com/baz"), true);
	assert.equal(al(r, "OtherBot", "https://example.com/baz"), false);
	// One group with several user-agent lines.
	const multi = "User-agent: a\nUser-agent: b\nDisallow: /x\n";
	assert.equal(al(multi, "a", "/x"), false);
	assert.equal(al(multi, "b", "/x"), false);
	assert.equal(al(multi, "c", "/x"), true);
});

test("RFC 9309 §2.2.2 / §5.2 examples: longest match, Allow on ties, * and $", () => {
	const r = "User-Agent: *\nDisallow: *.gif$\nDisallow: /example/\nAllow: /publications/\n\nUser-Agent: foobot\nDisallow:/\nAllow:/example/page.html\nAllow:/example/allowed.gif\n";
	assert.equal(al(r, "foobot", "/example/page.html"), true);
	assert.equal(al(r, "foobot", "/example/allowed.gif"), true);
	assert.equal(al(r, "foobot", "/example/other.html"), false);
	assert.equal(al(r, "barbot", "/x/y.gif"), false);
	assert.equal(al(r, "barbot", "/x/y.gif?q"), true);
	assert.equal(al(r, "barbot", "/example/z"), false);
	assert.equal(al(r, "barbot", "/publications/a"), true);
	// /robots.txt itself is always fetchable in practice; the matcher just reports rules.
	assert.equal(al("User-agent: *\nAllow: /a\nDisallow: /a\n", "x", "/a"), true);
});

test("evaluate() reports the deciding line", () => {
	const v = rep.evaluate("User-agent: *\nDisallow: /private/\nAllow: /private/ok\n", ["GPTBot"], "https://x.test/private/secret");
	assert.equal(v.allowed, false);
	assert.equal(v.matchedDirective, "disallow");
	assert.equal(v.matchedValue, "/private/");
	assert.equal(v.matchedLine, 2);
	assert.equal(v.scope, "global");
});

test("matches() normalizes both sides (rule tester)", () => {
	const cases: [string, string, boolean][] = [
		["/fish", "/fish", true], ["/fish", "/fish.html", true], ["/fish", "/Fish.asp", false], ["/fish", "/catfish", false],
		["/fish/", "/fish", false], ["/*.php", "/x.php?p", true], ["/*.php$", "/x.php?p", false], ["/fish*.php", "/Fish.PHP", false],
	];
	for (const [p, path, want] of cases) assert.equal(rep.matches(p, path), want, `${p} ${path}`);
	assert.equal(rep.matches("/caf%c3%a9", "/café"), true);
});

test("tokens with digits and dots match their own groups (MJ12bot, archive.org_bot)", () => {
	const r = "User-agent: MJ12bot\nDisallow: /\n\nUser-agent: archive.org_bot\nDisallow: /private/\n\nUser-agent: MJ\nAllow: /\n";
	assert.equal(al(r, "MJ12bot", "/page"), false);
	assert.equal(al(r, "archive.org_bot", "/private/x"), false);
	assert.equal(al(r, "archive.org_bot", "/public"), true);
	assert.equal(al(r, "MJ", "/page"), true);
	assert.equal(rep.extractProductToken("MJ12bot/1.4"), "MJ12bot");
});

test("tester path encoding: a typed /café matches /caf%C3%A9 rules", () => {
	const r = "User-agent: *\nDisallow: /café\n";
	assert.equal(rep.evaluate(r, ["x"], "/café", { encodePath: true }).allowed, false);
	assert.equal(rep.evaluate(r, ["x"], "https://example.com/caf%c3%a9", { encodePath: true }).allowed, false);
	assert.equal(rep.evaluate(r, ["x"], "/cafe", { encodePath: true }).allowed, true);
	assert.equal(rep.evaluate("User-agent: *\nDisallow: /a%20b\n", ["x"], "/a b", { encodePath: true }).allowed, false);
	// Google's contract (no encoding) is unchanged.
	assert.equal(rep.evaluate(r, ["x"], "/café").allowed, true);
});
