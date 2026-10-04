/**
 * Generation, rule rendering, the bundled directory and the Radar merge.
 * Run: node --test src/robots/*.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import * as BOTS from "./bots.ts";
// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import * as REP from "./rep.ts";
// @ts-expect-error -- Node's type stripping needs the real .ts extension.
import * as RULES from "./rules.ts";

const rules = RULES as typeof import("./rules.js");
const rep = REP as typeof import("./rep.js");
const bots = BOTS as typeof import("./bots.js");
type RobotsRule = import("./rules.js").RobotsRule;
type BotEntry = import("./bots.js").BotEntry;

const site = { siteUrl: "https://example.com" };
const rule = (r: Partial<RobotsRule>): RobotsRule => ({
	id: "r",
	name: "Rule",
	enabled: true,
	agents: ["*"],
	directive: "disallow",
	kind: "entire_site",
	...r,
});
const config = (r: RobotsRule[], extra: Partial<import("./rules.js").RobotsConfig> = {}) => ({ ...rules.DEFAULT_CONFIG, rules: r, ...extra });

test("rule kinds render like Coywolf SEO", () => {
	const d = (r: Partial<RobotsRule>) => rules.directives(rule(r)).map((l) => `${l.directive}: ${l.value}`);
	assert.deepEqual(d({ kind: "entire_site" }), ["Disallow: /"]);
	assert.deepEqual(d({ kind: "folder", path: "private" }), ["Disallow: /private/"]);
	assert.deepEqual(d({ kind: "prefix", path: "/draft" }), ["Disallow: /draft"]);
	assert.deepEqual(d({ kind: "single_page", path: "/a.html", strict: true }), ["Disallow: /a.html$"]);
	assert.deepEqual(d({ kind: "exact_url", path: "/search" }), ["Disallow: /search$"]);
	assert.deepEqual(d({ kind: "filetype", ext: ".pdf" }), ["Disallow: /*.pdf$"]);
	assert.deepEqual(d({ kind: "filetype_in_folder", path: "/dl", ext: "zip" }), ["Disallow: /dl/*.zip$"]);
	assert.deepEqual(d({ kind: "contains", path: "/preview=" }), ["Disallow: /*preview="]);
	assert.deepEqual(d({ kind: "any_depth", path: "/print/" }), ["Disallow: /*/print/"]);
	assert.deepEqual(d({ kind: "query_any" }), ["Disallow: /*?"]);
	assert.deepEqual(d({ kind: "query_param", path: "?utm_source" }), ["Disallow: /*?utm_source=", "Disallow: /*&utm_source="]);
	assert.deepEqual(d({ kind: "wildcard_prefix", path: "/pa_" }), ["Disallow: /pa_*"]);
	assert.deepEqual(d({ kind: "allow_exception", path: "/members", allow: "/members/hi" }), ["Disallow: /members/", "Allow: /members/hi"]);
	assert.deepEqual(d({ kind: "folder", path: "/x/", directive: "allow" }), ["Allow: /x/"]);
	assert.deepEqual(d({ kind: "custom", path: "/a b#c" }), ["Disallow: /abc"]);
});

test("validation", () => {
	assert.throws(() => rules.validateRule(rule({ name: " " })), /name/);
	assert.throws(() => rules.validateRule(rule({ agents: ["Bad Bot"] })), /token/);
	assert.throws(() => rules.validateRule(rule({ kind: "folder", path: "" })), /path/);
	assert.throws(() => rules.validateRule(rule({ kind: "custom", path: "x" })), /start with/);
	assert.throws(() => rules.validateRule(rule({ kind: "filetype", ext: "p.d" })), /extension/);
	rules.validateRule(rule({ agents: ["GPTBot", "archive.org_bot", "*"] }));
});

test("no rules: EmDash's defaults (admin blocked, media and sitemap kept)", () => {
	const txt = rules.generate(config([]), site);
	assert.match(txt, /User-agent: \*\nAllow: \/_emdash\/api\/media\/\nDisallow: \/_emdash\//);
	assert.match(txt, /Sitemap: https:\/\/example\.com\/sitemap\.xml\n$/);
	assert.equal(rep.oneAgentAllowed(txt, "Googlebot", "/_emdash/admin"), false);
	assert.equal(rep.oneAgentAllowed(txt, "Googlebot", "/_emdash/api/media/file/a.jpg"), true);
	assert.equal(rep.oneAgentAllowed(txt, "Googlebot", "/a-post/"), true);
});

test("bots named in rules still get EmDash's admin block; fully blocked bots don't get the media Allow", () => {
	const txt = rules.generate(
		config([
			rule({ name: "Block AI training crawlers", agents: ["GPTBot", "CCBot"] }),
			rule({ name: "Allow search engines", agents: ["Googlebot"], directive: "allow" }),
			rule({ name: "No drafts for Bing", agents: ["bingbot"], kind: "folder", path: "/drafts/" }),
		]),
		site,
	);
	for (const bot of ["GPTBot", "CCBot"]) {
		assert.equal(rep.oneAgentAllowed(txt, bot, "/"), false, bot);
		assert.equal(rep.oneAgentAllowed(txt, bot, "/_emdash/api/media/file/a.jpg"), false, `${bot} media`);
	}
	assert.equal(rep.oneAgentAllowed(txt, "Googlebot", "/post/"), true);
	assert.equal(rep.oneAgentAllowed(txt, "Googlebot", "/_emdash/admin"), false);
	assert.equal(rep.oneAgentAllowed(txt, "Googlebot", "/_emdash/api/media/file/a.jpg"), true);
	assert.equal(rep.oneAgentAllowed(txt, "bingbot", "/drafts/x"), false);
	assert.equal(rep.oneAgentAllowed(txt, "bingbot", "/_emdash/api/content"), false);
	assert.equal(rep.oneAgentAllowed(txt, "SomeOtherBot", "/drafts/x"), true);
	assert.equal(rep.oneAgentAllowed(txt, "SomeOtherBot", "/_emdash/"), false);
	assert.match(txt, /# Block AI training crawlers\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: \/\n/);
	const emdashGroup = txt.slice(txt.indexOf("# EmDash"));
	assert.ok(!emdashGroup.includes("GPTBot"));
	assert.ok(emdashGroup.includes("User-agent: Googlebot") && emdashGroup.includes("User-agent: bingbot"));
});

test("blocking everyone keeps media closed too", () => {
	const txt = rules.generate(config([rule({ name: "Closed", agents: ["*"] })]), site);
	assert.equal(rep.oneAgentAllowed(txt, "AnyBot", "/_emdash/api/media/file/a.jpg"), false);
	assert.equal(rep.oneAgentAllowed(txt, "AnyBot", "/"), false);
	assert.ok(!txt.includes("Allow: /_emdash/api/media/"));
});

test("disabled rules, comments off, sitemaps and extra lines", () => {
	const txt = rules.generate(
		config([rule({ name: "Off", enabled: false, agents: ["GPTBot"] })], {
			comments: false,
			includeSitemap: false,
			allowMedia: false,
			sitemaps: ["/news-sitemap.xml", "https://cdn.example.com/s.xml", ""],
			extra: "Content-Signal: search=yes, ai-train=no",
		}),
		site,
	);
	assert.ok(!txt.includes("GPTBot"));
	assert.ok(!txt.includes("#"));
	assert.ok(!txt.includes("/sitemap.xml\n"));
	assert.ok(!txt.includes("Allow:"));
	assert.match(txt, /Content-Signal: search=yes, ai-train=no\n\nSitemap: https:\/\/example\.com\/news-sitemap\.xml\nSitemap: https:\/\/cdn\.example\.com\/s\.xml\n$/);
});

test("presets only use verified tokens from the bundled directory", () => {
	const data = JSON.parse(readFileSync(new URL("./data/bots.json", import.meta.url), "utf8")) as { bots: BotEntry[] };
	const verified = new Set(data.bots.filter((b) => b.status === "verified").map((b) => b.token));
	for (const preset of rules.PRESETS) for (const agent of preset.agents) assert.ok(verified.has(agent), `${preset.name}: ${agent}`);
});

test("bundled directory: valid tokens, sources on verified entries, key crawlers verified", () => {
	const data = JSON.parse(readFileSync(new URL("./data/bots.json", import.meta.url), "utf8")) as { bots: BotEntry[] };
	assert.ok(data.bots.length > 650);
	const slugs = new Set<string>();
	const tokens = new Set<string>();
	for (const b of data.bots) {
		assert.ok(!tokens.has(b.token.toLowerCase()), `duplicate token ${b.token}`);
		tokens.add(b.token.toLowerCase());
	}
	for (const b of data.bots) {
		assert.ok(!slugs.has(b.slug), `duplicate ${b.slug}`);
		slugs.add(b.slug);
		assert.match(b.token, /^[A-Za-z0-9._-]+$/, b.slug);
		assert.match(b.token, /[A-Za-z]/, b.slug);
		if (b.evidence === "operator-docs") assert.doesNotMatch(b.sourceUrl ?? "", /^https?:\/\/[^/]+\/?$/, `${b.slug}: homepage isn't documentation`);
		if (b.status === "verified") assert.ok(b.verifiedAt, `${b.slug} verifiedAt`);
		if (b.evidence === "operator-docs") assert.match(b.sourceUrl ?? "", /^https?:\/\//, `${b.slug} source`);
	}
	const byToken = (t: string) => data.bots.find((b) => b.token === t && b.status === "verified") ?? data.bots.find((b) => b.token === t);
	for (const t of [
		"GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "Google-Extended", "Googlebot",
		"bingbot", "Applebot", "Applebot-Extended", "PerplexityBot", "Perplexity-User", "CCBot", "Bytespider", "Amazonbot",
		"meta-externalagent", "DuckAssistBot", "YandexBot", "Baiduspider",
	]) {
		assert.equal(byToken(t)?.status, "verified", t);
	}
	for (const t of ["anthropic-ai", "cohere-ai", "FacebookBot"]) assert.equal(byToken(t)?.status, "unverified", t);
});

test("deriveToken from Radar patterns", () => {
	assert.equal(bots.deriveToken(["Barkrowler/"], "Barkrowler"), "Barkrowler");
	assert.equal(bots.deriveToken(["meta-externaltest/1\\.1"], "Meta-ExternalTest"), "meta-externaltest");
	assert.equal(bots.deriveToken(["Advailo Kuma"], "Advailo Kuma"), null);
	assert.equal(bots.deriveToken([], "AccessSparkBot"), "AccessSparkBot");
	assert.equal(bots.deriveToken(["http://yandex.com/bots"], "Yandex Bot"), null);
});

test("mergeRadar stores only differences and adds new bots unverified", () => {
	const base: BotEntry[] = [
		{ slug: "gptbot", name: "GPTBot", operator: "OpenAI", category: "AI_CRAWLER", description: "d", token: "GPTBot", status: "verified", evidence: "operator-docs", origin: "radar" },
		{ slug: "gone", name: "Gone", operator: "X", category: "OTHER", description: "", token: "GoneBot", status: "verified", evidence: "user-agent", origin: "radar" },
		{ slug: "ccbot", name: "CCBot", operator: "Common Crawl", category: "AI_CRAWLER", description: "", token: "CCBot", status: "verified", evidence: "operator-docs", origin: "curated" },
	];
	const radar = [
		{ slug: "gptbot", name: "GPTBot", operator: "OpenAI", category: "AI_CRAWLER", description: "d", userAgentPatterns: ["GPTBot"] },
		{ slug: "newbot", name: "New Bot", operator: "N", category: "AI_SEARCH", description: "new", userAgentPatterns: ["NewBot/"] },
	];
	const first = bots.mergeRadar(base, [], radar, "2026-10-03");
	assert.equal(first.added, 1);
	assert.equal(first.delisted, 1); // "gone" left Radar; the curated CCBot is not Radar's to delist.
	assert.deepEqual(first.writes.map((w) => w.slug).sort(), ["gone", "newbot"]);
	const merged = bots.mergeDirectory(base, first.writes);
	const nb = merged.find((b) => b.slug === "newbot");
	assert.equal(nb?.token, "NewBot");
	assert.equal(nb?.status, "unverified");
	assert.equal(merged.find((b) => b.slug === "gone")?.delisted, true);

	// Same data next week: nothing to write.
	const second = bots.mergeRadar(base, first.writes, radar, "2026-10-10");
	assert.equal(second.writes.length, 0);

	// Radar recategorizes GPTBot: one overlay write, token untouched.
	const third = bots.mergeRadar(base, first.writes, [{ ...radar[0], category: "AI_SEARCH" }, radar[1]], "2026-10-17");
	assert.equal(third.updated, 1);
	const after = bots.mergeDirectory(base, [...first.writes, ...third.writes]);
	const g = after.find((b) => b.slug === "gptbot");
	assert.equal(g?.category, "AI_SEARCH");
	assert.equal(g?.token, "GPTBot");
	assert.equal(g?.status, "verified");
});

test("whole-site blocks in any spelling drop the media Allow; /$ doesn't", () => {
	for (const v of ["/", "/*", "*", "/**", "/*$"]) assert.equal(rules.blocksWholeSite(v), true, v);
	assert.equal(rules.blocksWholeSite("/$"), false);
	assert.equal(rules.blocksWholeSite("/private/"), false);
	for (const v of ["/*", "*"]) {
		const txt = rules.generate(config([rule({ name: "Block", agents: ["GPTBot"], kind: "custom", path: v })]), site);
		assert.equal(rep.oneAgentAllowed(txt, "GPTBot", "/_emdash/api/media/file/a.jpg"), false, v);
		assert.ok(!txt.slice(txt.indexOf("# EmDash")).includes("GPTBot"), v);
	}
	const home = rules.generate(config([rule({ name: "Home", agents: ["GPTBot"], kind: "custom", path: "/$" })]), site);
	assert.equal(rep.oneAgentAllowed(home, "GPTBot", "/_emdash/api/media/file/a.jpg"), true);
	assert.equal(rep.oneAgentAllowed(home, "GPTBot", "/_emdash/admin"), false);
});

test("line breaks can't inject directives", () => {
	const txt = rules.generate(
		config(
			[
				rule({
					name: "Evil\nUser-agent: *\nDisallow: /",
					description: "x\r\nAllow: /",
					agents: ["GPTBot\nDisallow: /", "Good"],
					kind: "folder",
					path: "/a\nAllow: /b",
				}),
			],
			{ sitemaps: ["/s.xml\nUser-agent: *\nDisallow: /", "https://x.test/a.xml\r\nDisallow: /"] },
		),
		{ siteUrl: "https://example.com\nDisallow: /" },
	);
	for (const line of txt.split("\n")) {
		assert.ok(!/^Disallow: \/$/.test(line), `injected: ${line}`);
		assert.ok(!/^User-agent: \*$/.test(line) || txt.includes("# EmDash"), line);
	}
	assert.ok(!txt.includes("\r"));
	assert.equal(rep.oneAgentAllowed(txt, "Bingbot", "/post"), true);
	assert.match(txt, /Sitemap: https:\/\/example\.comDisallow:\/s\.xmlUser-agent:\*Disallow:\//);
});

test("Radar entries merged by token count as their primary entry", () => {
	const base: BotEntry[] = [
		{ slug: "a", name: "A", operator: "", category: "OTHER", description: "", token: "ABot", status: "verified", evidence: "user-agent", origin: "radar", mergedSlugs: ["a-2"] },
	];
	const r = bots.mergeRadar(base, [], [{ slug: "a-2", name: "A two", userAgentPatterns: ["ABot"] }], "2026-10-03");
	assert.equal(r.writes.length, 0);
	assert.equal(r.added, 0);
	assert.equal(r.delisted, 0);
});
