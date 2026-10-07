/**
 * Unit tests for AI Enrichment's pure logic.
 * Run: node --test test/*.test.mjs (or node --test src/ai/*.test.ts)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as L from "./logic.ts";

const logic = L as typeof import("./logic.js");

test("decodeJson tolerates fences, prose, and trailing text", () => {
	assert.deepEqual(logic.decodeJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
	assert.deepEqual(logic.decodeJson('Here you go: {"a":2} hope that helps'), { a: 2 });
	assert.equal(logic.decodeJson("no json here"), null);
	assert.deepEqual(logic.decodeJson({ already: true }), { already: true });
});

test("parseMentions validates shape, types, duplicates, and the 12 cap", () => {
	const rows = [
		{ surface: "NYC", name: "New York City", type: "Place", description: "A city", primary: true },
		{ name: "new york city", type: "Place" }, // duplicate (case-insensitive)
		{ name: "Widget", type: "Gadget", description: "<b>thing</b>" }, // unknown type → Thing, tags stripped
		{ type: "Person" }, // no name
		"junk",
		...Array.from({ length: 20 }, (_, i) => ({ name: `E${i}`, type: "Organization" })),
	];
	const out = logic.parseMentions(JSON.stringify(rows));
	assert.equal(out.length, 12);
	assert.deepEqual(out[0], { surface: "NYC", name: "New York City", type: "Place", description: "A city", primary: true });
	assert.equal(out[1].type, "Thing");
	assert.equal(out[1].description, "thing");
	assert.equal(out[1].primary, false);
	assert.deepEqual(logic.parseMentions("not json"), []);
	assert.equal(logic.parseMentions('{"entities":[{"name":"X","type":"Thing"}]}').length, 1);
});

test("parseChoices keeps only QID strings", () => {
	assert.deepEqual(logic.parseChoices('{"A":"q42","B":null,"C":"https://wikidata.org/Q1","D":7}'), { A: "Q42", B: null, C: null, D: null });
	assert.deepEqual(logic.parseChoices("[1,2]"), {});
});

test("cleanDescription strips quotes and labels and caps at 155 on a word", () => {
	assert.equal(logic.cleanDescription('"Meta description: A short summary."'), "A short summary.");
	const long = "word ".repeat(60);
	const out = logic.cleanDescription(long);
	assert.ok([...out].length <= 155, `length ${[...out].length}`);
	assert.ok(out.endsWith("…"));
	assert.ok(!out.includes("wor…"));
	assert.equal(logic.cleanDescription(""), "");
});

test("parseImageText validates and normalizes", () => {
	const r = logic.parseImageText('{"alt_text":"Image of a dog running.","title":"Dog Running","caption":"A dog.","description":"x"}');
	assert.deepEqual(r, { alt: "A dog running.", caption: "A dog.", title: "Dog Running" });
	assert.equal(logic.parseImageText('{"alt_text":"","title":"Divider","caption":""}').alt, "");
	assert.throws(() => logic.parseImageText(""), /empty response/);
	assert.throws(() => logic.parseImageText("nope"), /could not be parsed/);
	assert.throws(() => logic.parseImageText('{"caption":"only"}'), /usable/);
});

const human = { p31: ["Q5"], wikipedia: "", website: "" };
const city = { p31: ["Q515"], wikipedia: "https://en.wikipedia.org/wiki/Paris", website: "https://paris.fr" };
const disamb = { p31: ["Q4167410"], wikipedia: "", website: "" };

test("grounding: candidates, choices restricted to real candidates", () => {
	const mentions = [
		{ surface: "", name: "Paris", type: "Place", description: "", primary: true },
		{ surface: "", name: "Mercury", type: "Thing", description: "planet", primary: false },
		{ surface: "", name: "Nobody", type: "Person", description: "", primary: false },
	] as const;
	const { mentions: grounded, ambiguous } = logic.attachCandidates([...mentions], [
		[{ id: "Q90", label: "Paris", description: "capital of France" }],
		[
			{ id: "Q308", label: "Mercury", description: "planet" },
			{ id: "Q925", label: "mercury", description: "element" },
		],
		[],
	]);
	assert.equal(grounded[0].qid, "Q90");
	assert.deepEqual(ambiguous, [1]);
	assert.equal(grounded[2].qid, "");
	// A hallucinated QID is ignored; a listed one is accepted.
	assert.equal(logic.applyChoices(grounded, ambiguous, { Mercury: "Q999" })[1].qid, "");
	assert.equal(logic.applyChoices(grounded, ambiguous, { Mercury: "Q308" })[1].qid, "Q308");
});

test("verifyEntities drops disambiguation pages and Person/human mismatches", () => {
	const m = (name: string, type: string, qid: string) => ({ surface: "", name, type, description: "", primary: false, qid, candidates: [] }) as never;
	const out = logic.verifyEntities(
		[m("Ada Lovelace", "Person", "Q7259"), m("Paris", "Place", "Q90"), m("Paris Hilton", "Place", "Q47899"), m("A Band", "Person", "Q1"), m("Mercury", "Thing", "Q2"), m("Unresolved", "Thing", ""), m("Dup", "Place", "Q90")],
		{ Q7259: human, Q90: city, Q47899: human, Q1: { p31: ["Q215380"], wikipedia: "", website: "" }, Q2: disamb },
	);
	assert.deepEqual(
		out.map((e) => e.qid),
		["Q7259", "Q90"],
	);
	assert.equal(out[1].website, "https://paris.fr");
});

test("parseSearch reads a wbsearchentities response", () => {
	assert.deepEqual(logic.parseSearch({ search: [{ id: "Q1", label: "Universe", description: "all" }, { id: "P31" }, {}] }), [{ id: "Q1", label: "Universe", description: "all" }]);
});

test("entityNodes builds about/mentions with sameAs", () => {
	const nodes = logic.entityNodes([
		{ name: "Paris", type: "Place", description: "City", qid: "Q90", wikipedia: "https://en.wikipedia.org/wiki/Paris", website: "", primary: true },
		{ name: "X", type: "Thing", description: "", qid: "Q1", wikipedia: "", website: "", primary: false },
		{ name: "Bad", type: "Thing", description: "", qid: "nope", wikipedia: "", website: "", primary: false },
	]);
	assert.deepEqual(nodes.about, [{ "@type": "Place", name: "Paris", sameAs: ["https://www.wikidata.org/wiki/Q90", "https://en.wikipedia.org/wiki/Paris"], description: "City" }]);
	assert.deepEqual(nodes.mentions, [{ "@type": "Thing", name: "X", sameAs: "https://www.wikidata.org/wiki/Q1" }]);
});

test("Portable Text → plain text", () => {
	const pt = [
		{ _type: "block", children: [{ _type: "span", text: "Hello " }, { _type: "span", text: "world." }] },
		{ _type: "image", asset: { _ref: "x" }, caption: "A caption" },
		{ _type: "columns", columns: [{ content: [{ _type: "block", children: [{ text: "Nested." }] }] }] },
	];
	assert.equal(logic.portableTextToPlain(pt), "Hello world.\n\nA caption\n\nNested.");
	const text = logic.entryPlainText({ body: pt, excerpt: "<p>Intro</p>", count: 3 }, [
		{ slug: "excerpt", type: "text" },
		{ slug: "body", type: "portableText" },
		{ slug: "count", type: "number" },
	]);
	assert.ok(text.startsWith(" Intro") || text.startsWith("Intro"));
	assert.ok(text.includes("Hello world."));
	assert.equal(logic.entryPlainText({ body: pt }, [{ slug: "body", type: "portableText" }], 5), "Hello");
});

test("normalizeName and nameMatches ignore case, diacritics, and punctuation", () => {
	assert.equal(logic.normalizeName("  Café-Müller, Inc. "), "cafe muller inc");
	const c = { id: "Q1", label: "Beyoncé", description: "", aliases: ["Beyoncé Knowles"] };
	assert.equal(logic.nameMatches({ name: "beyonce", surface: "" }, c), true);
	assert.equal(logic.nameMatches({ name: "Queen B", surface: "Beyoncé Knowles" }, c), true);
	assert.equal(logic.nameMatches({ name: "Beyoncé tour", surface: "" }, c), false);
});

test("attachCandidates drops search hits whose label/alias doesn't match, even a single one", () => {
	const m = [
		{ surface: "", name: "Acme Widgets", type: "Organization", description: "", primary: true },
		{ surface: "the Met", name: "Metropolitan Museum of Art", type: "Organization", description: "", primary: false },
	] as never;
	const { mentions, ambiguous } = logic.attachCandidates(m, [
		[{ id: "Q5", label: "Acme Corporation", description: "fictional company" }],
		[
			{ id: "Q160236", label: "Metropolitan Museum of Art", description: "art museum" },
			{ id: "Q99", label: "Metropolitan Opera", description: "opera company", aliases: ["the Met"] },
		],
	]);
	assert.equal(mentions[0].qid, "");
	assert.equal(mentions[0].candidates.length, 0);
	assert.deepEqual(ambiguous, [1]); // both match (label and alias): the model must choose
});

test("parseSearch keeps aliases and the matched text", () => {
	const out = logic.parseSearch({ search: [{ id: "Q1", label: "A", aliases: ["Alpha"], match: { type: "alias", text: "Alef" } }] });
	assert.deepEqual(out[0].aliases, ["Alpha", "Alef"]);
});

test("verifyEntities uses the Wikidata label as the name and rejects unverifiable items", () => {
	const g = (name: string, type: string, qid: string, label: string) =>
		({ surface: "", name, type, description: "", primary: true, qid, candidates: [{ id: qid, label, description: "" }] }) as never;
	const out = logic.verifyEntities([g("nyc", "Place", "Q60", "New York City"), g("Ghost", "Thing", "Q404", "Ghost")], {
		Q60: { p31: ["Q515"], wikipedia: "", website: "" },
	});
	assert.deepEqual(
		out.map((e) => e.name),
		["New York City"],
	); // Q404 wasn't returned by Wikidata: dropped
});

test("typeCompatible: Person needs Q5; Organization/Place reject creative works; Organization rejects places", () => {
	assert.equal(logic.typeCompatible("Person", []), false);
	assert.equal(logic.typeCompatible("Person", ["Q5"]), true);
	assert.equal(logic.typeCompatible("Organization", ["Q482994"]), false); // album, not the band
	assert.equal(logic.typeCompatible("Organization", ["Q515"]), false); // city
	assert.equal(logic.typeCompatible("Organization", ["Q4830453"]), true); // business
	assert.equal(logic.typeCompatible("Organization", []), false);
	assert.equal(logic.typeCompatible("Place", ["Q11424"]), false); // film
	assert.equal(logic.typeCompatible("Place", ["Q515"]), true);
	assert.equal(logic.typeCompatible("Thing", ["Q11424"]), true); // a film is a fine Thing
	assert.equal(logic.typeCompatible("Thing", ["Q5"]), false);
	assert.equal(logic.typeCompatible("Thing", ["Q4167410"]), false);
});
