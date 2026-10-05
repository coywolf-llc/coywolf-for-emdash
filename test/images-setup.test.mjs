// Run: node --test test/images-setup.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { planMediaHostSetup, mediaHostRules, isOurRule, zoneCandidates, hostnameOf, sendableRule } = await import("../src/images/setup.ts");
const { checkItems } = await import("../src/images/cloudflare.ts");

const HOST = "media.example.com";
const input = { host: `https://${HOST}`, zoneName: "example.com", bucket: "example-media" };
const unrelated = {
	id: "r1",
	version: "3",
	last_updated: "2026-01-01T00:00:00Z",
	ref: "keep",
	description: "Strip utm params",
	expression: 'http.request.uri.query contains "utm_"',
	action: "rewrite",
	action_parameters: { uri: { query: { value: "" } } },
	enabled: true,
};

test("the rules match what was set up by hand for wellbeing.io", () => {
	const [crop, width] = mediaHostRules(HOST);
	assert.equal(crop.description, "media.example.com: /s/<W>x<H>/<file> → cropped resize (Coywolf Pack clean image URLs)");
	assert.equal(crop.expression, '(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*x*/*")');
	assert.equal(
		crop.action_parameters.uri.path.expression,
		'wildcard_replace(http.request.uri.path, "/s/*x*/*", "/cdn-cgi/image/width=${1},height=${2},fit=cover,format=auto,quality=85/${3}")',
	);
	assert.equal(width.description, "media.example.com: /s/<W>/<file> → resize to width (Coywolf Pack clean image URLs)");
	assert.equal(width.expression, '(http.host eq "media.example.com" and http.request.uri.path wildcard "/s/*/*" and not http.request.uri.path wildcard "/s/*x*/*")');
	assert.equal(width.action_parameters.uri.path.expression, 'wildcard_replace(http.request.uri.path, "/s/*/*", "/cdn-cgi/image/width=${1},format=auto,quality=85/${2}")');
	assert.equal(crop.action, "rewrite");
});

test("a fresh zone needs all three steps", () => {
	const plan = planMediaHostSetup({ transformations: "off", domains: [], rules: null }, input);
	assert.deepEqual(plan.steps.map((s) => [s.id, s.action]), [["transformations", "enable"], ["domain", "add"], ["rules", "add"]]);
	assert.equal(plan.done, false);
	assert.equal(plan.host, HOST);
	assert.deepEqual(plan.rules, mediaHostRules(HOST));
});

test("a finished setup needs nothing", () => {
	const rules = [unrelated, ...mediaHostRules(HOST).map((r, i) => ({ ...r, id: `x${i}`, version: "1" }))];
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: HOST, enabled: true }], rules }, input);
	assert.equal(plan.done, true);
	assert.deepEqual(plan.steps.map((s) => s.action), ["none", "none", "none"]);
	assert.deepEqual(plan.rules, []);
});

test("keeps unrelated rules (without read-only fields) and appends ours", () => {
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: "MEDIA.example.com", enabled: false }], rules: [unrelated] }, input);
	assert.deepEqual(plan.steps.map((s) => [s.id, s.action]), [["transformations", "none"], ["domain", "enable"], ["rules", "add"]]);
	assert.equal(plan.rules.length, 3);
	assert.deepEqual(plan.rules[0], sendableRule(unrelated));
	assert.equal(plan.rules[0].id, "r1");
	assert.equal(plan.rules[0].version, undefined);
	assert.equal(plan.rules[0].last_updated, undefined);
	assert.match(plan.steps[2].label, /1 other rule stay/);
});

test("replaces only our outdated rules, in place; other hosts' rules stay", () => {
	const old = { ...mediaHostRules(HOST)[0], id: "old", expression: '(http.host eq "media.example.com")' };
	const otherHost = { ...mediaHostRules("media.other.com")[0], id: "other" };
	const after = { ...unrelated, id: "r2", description: "Later rule" };
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: HOST }], rules: [unrelated, old, otherHost, after] }, input);
	assert.deepEqual(plan.steps.map((s) => s.action), ["none", "none", "update"]);
	assert.deepEqual(
		plan.rules.map((r) => r.id ?? r.description),
		["r1", mediaHostRules(HOST)[0].description, mediaHostRules(HOST)[1].description, "other", "r2"],
	);
	assert.ok(isOurRule(old, HOST));
	assert.ok(!isOurRule(otherHost, HOST));
	assert.ok(!isOurRule(unrelated, HOST));
});

test("a disabled rule of ours counts as outdated", () => {
	const rules = mediaHostRules(HOST).map((r, i) => ({ ...r, enabled: i === 0 ? false : true }));
	const plan = planMediaHostSetup({ transformations: "on", domains: [{ domain: HOST, enabled: true }], rules }, input);
	assert.equal(plan.steps[2].action, "update");
	assert.equal(plan.rules.length, 2);
});

test("zone candidates and host names", () => {
	assert.deepEqual(zoneCandidates("media.example.com"), ["example.com"]);
	assert.deepEqual(zoneCandidates("media.blog.example.co.uk"), ["blog.example.co.uk", "example.co.uk", "co.uk"]);
	assert.equal(hostnameOf("https://Media.Example.com/"), "media.example.com");
});

test("check results read plainly", () => {
	const good = checkItems({
		file: "ABC.webp",
		original: { status: 200, type: "image/webp" },
		resized: { status: 200, type: "image/avif", cfResized: "internal=ok/- q=0 n=10", cache: "HIT" },
	});
	assert.deepEqual(good.map((i) => [i.id, i.ok]), [["reachable", true], ["original", true], ["resize", true], ["cached", true]]);
	const noRules = checkItems({ file: "ABC.webp", original: { status: 200, type: "image/webp" }, resized: { status: 404, type: "text/html", cfResized: null, cache: null } });
	assert.deepEqual(noRules.map((i) => i.ok), [true, true, false, false]);
	assert.match(noRules[2].detail, /rewrite rules/);
	const down = checkItems({ file: "ABC.webp", original: { error: "DNS lookup failed" }, resized: { error: "DNS lookup failed" } });
	assert.deepEqual(down.map((i) => i.ok), [false, false, false, false]);
});
