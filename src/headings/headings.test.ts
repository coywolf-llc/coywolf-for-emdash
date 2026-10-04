// Run: node --import ./src/headings/test-hooks.mjs --test src/headings/headings.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { blockText, slugify, uniqueSlug, validAnchor } from "./slug.js";
import { stampContent } from "./stamp.js";
import { buildTocTree, countToc } from "./toc.js";
import { normalizeSettings, withLegacyBreadcrumbs } from "./settings.js";

const h = (key: string, style: string, text: string, extra: Record<string, unknown> = {}) => ({
	_type: "block",
	_key: key,
	style,
	children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
	markDefs: [],
	...extra,
});
const p = (key: string, text: string) => h(key, "normal", text);
const opts = { anchors: true, toc: true, prefix: "jump-" };

test("slugify mirrors sanitize_title", () => {
	assert.equal(slugify("Hello, World!"), "hello-world");
	assert.equal(slugify("Don't Panic"), "dont-panic");
	assert.equal(slugify("  Café   au lait "), "cafe-au-lait");
	assert.equal(slugify("Price & Plans — 2026"), "price-plans-2026");
	assert.equal(slugify("snake_case words"), "snake-case-words");
	assert.equal(slugify("日本語 見出し"), "日本語-見出し");
	assert.equal(slugify("!!!"), "");
	assert.ok(slugify("a".repeat(200)).length <= 80);
});

test("uniqueSlug prefixes and de-duplicates", () => {
	const taken = new Set<string>();
	assert.equal(uniqueSlug("Intro", taken), "jump-intro");
	assert.equal(uniqueSlug("Intro", taken), "jump-intro-2");
	assert.equal(uniqueSlug("Intro", taken), "jump-intro-3");
	assert.equal(uniqueSlug("???", taken), "jump-section");
	assert.equal(uniqueSlug("2026 plans", new Set(), ""), "h-2026-plans");
	assert.equal(uniqueSlug("Intro", new Set(), "sec-"), "sec-intro");
});

test("validAnchor rejects unsafe ids", () => {
	assert.ok(validAnchor("jump-intro"));
	assert.ok(!validAnchor('x" onclick="y'));
	assert.ok(!validAnchor("1abc"));
	assert.ok(!validAnchor(""));
	assert.ok(!validAnchor(42));
});

test("blockText reads nested marks trees", () => {
	const node = { children: [{ _type: "@span", children: [{ _type: "@text", text: "Bold " }] }, { _type: "@text", text: "tail" }] };
	assert.equal(blockText(node), "Bold tail");
});

test("stamping adds unique anchors and TOC headings (breadcrumb blocks are left to Breadcrumb Nav)", () => {
	const content = {
		title: "My Post",
		body: [
			{ _type: "coywolf-toc", _key: "t" },
			{ _type: "coywolf-breadcrumbs", _key: "b" },
			h("a", "h2", "Intro"),
			p("x", "text"),
			h("b2", "h3", "Intro"),
			h("c", "h1", "Title"),
			h("d", "h2", ""),
		],
		other: "not portable text",
	};
	const out = stampContent(content, opts);
	assert.ok(out);
	const body = out.body as Record<string, unknown>[];
	assert.equal(body[2].anchor, "jump-intro");
	assert.equal(body[4].anchor, "jump-intro-2");
	assert.equal(body[5].anchor, undefined, "H1 is not anchored");
	assert.equal(body[6].anchor, undefined, "empty heading is skipped");
	assert.deepEqual(body[0]._headings, [
		{ level: 2, id: "jump-intro", text: "Intro" },
		{ level: 3, id: "jump-intro-2", text: "Intro" },
	]);
	assert.equal(body[1]._title, undefined);
	assert.equal(out.other, "not portable text");
	// Input untouched.
	assert.equal((content.body[2] as Record<string, unknown>).anchor, undefined);
});

test("stamping is idempotent", () => {
	const content = { title: "T", body: [{ _type: "coywolf-toc", _key: "t" }, h("a", "h2", "One"), h("b", "h2", "One")] };
	const once = stampContent(content, opts);
	assert.ok(once);
	assert.equal(stampContent(once, opts), null);
});

test("anchors stay stable when the editor drops them and the heading is reworded", () => {
	const saved = stampContent({ body: [h("a", "h2", "Pricing"), h("b", "h2", "FAQ")] }, opts);
	assert.ok(saved);
	// Editor round trip: anchor field gone, first heading renamed, a new heading inserted before it.
	const edited = { body: [h("n", "h2", "FAQ"), h("a", "h2", "Plans and pricing"), h("b", "h2", "FAQ")] };
	const out = stampContent(edited, { ...opts, previous: saved });
	assert.ok(out);
	const body = out.body as Record<string, unknown>[];
	assert.equal(body[1].anchor, "jump-pricing", "kept by _key despite new text");
	assert.equal(body[2].anchor, "jump-faq", "kept by _key");
	assert.equal(body[0].anchor, "jump-faq-2", "new heading slugs around existing anchors");
});

test("anchors fall back to text matching when keys change", () => {
	const saved = stampContent({ body: [h("a", "h2", "Setup")] }, { ...opts, prefix: "old-" });
	assert.ok(saved);
	const out = stampContent({ body: [h("z", "h2", "Setup")] }, { ...opts, previous: saved });
	assert.equal((out?.body as Record<string, unknown>[])[0].anchor, "old-setup");
});

test("invalid stored anchors are replaced", () => {
	const out = stampContent({ body: [h("a", "h2", "Hi", { anchor: '"><script>' })] }, opts);
	assert.equal((out?.body as Record<string, unknown>[])[0].anchor, "jump-hi");
});

test("TOC tree nests by level and tolerates skipped levels", () => {
	const flat = [
		{ level: 2, id: "a", text: "A" },
		{ level: 4, id: "a1", text: "A1" },
		{ level: 3, id: "a2", text: "A2" },
		{ level: 2, id: "b", text: "B" },
		{ level: 5, id: "deep", text: "Deep" },
		{ level: 3, id: "b1", text: "B1" },
	];
	const tree = buildTocTree(flat, [2, 3, 4]);
	assert.deepEqual(
		tree.map((n) => [n.id, n.children.map((c) => [c.id, c.children.map((g) => g.id)])]),
		[
			["a", [["a1", []], ["a2", []]]],
			["b", [["b1", []]]],
		],
	);
	assert.equal(countToc(tree), 5);
	assert.deepEqual(
		buildTocTree(flat, [3]).map((n) => n.id),
		["a2", "b1"],
	);
	assert.deepEqual(
		buildTocTree([{ level: 3, id: "x", text: "X" }, { level: 2, id: "y", text: "Y" }], [2, 3]).map((n) => n.id),
		["x", "y"],
	);
});

test("TOC title can be hidden; levels can be H2 only", () => {
	assert.equal(normalizeSettings({}).toc.showTitle, true);
	assert.equal(normalizeSettings({ toc: { showTitle: false } }).toc.showTitle, false);
	assert.deepEqual(normalizeSettings({ toc: { levels: [2] } }).toc.levels, [2]);
	assert.equal("breadcrumbs" in normalizeSettings({ breadcrumbs: { homeLabel: "Start" } }), false);
});

test("saving Headings settings keeps the legacy breadcrumb sub-object for Breadcrumb Nav", () => {
	const legacy = { separator: "chevron", homeLabel: "Start" };
	const next = normalizeSettings({ prefix: "sec-" });
	assert.deepEqual(withLegacyBreadcrumbs({ prefix: "jump-", breadcrumbs: legacy }, next), { ...next, breadcrumbs: legacy });
	assert.deepEqual(withLegacyBreadcrumbs({ prefix: "jump-" }, next), next);
	assert.deepEqual(withLegacyBreadcrumbs(null, next), next);
});
