/**
 * Unit tests for the Wikidata client: the SPARQL details query, parsing its
 * results, and how non-OK answers (429, maxlag) are handled.
 * Run: node --test test/*.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-ignore -- Node runs the .ts source directly; tsc doesn't need to resolve it.
import * as L from "./logic.ts";
// @ts-ignore -- as above.
import * as W from "./wikidata.ts";

const logic = L as typeof import("./logic.js");
const wikidata = W as typeof import("./wikidata.js");
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
const UA = "CoywolfPack/0.0.0 (https://example.com) EmDash";

/** A fetcher that records requests and answers with the given responses in turn. */
function fakeFetch(...responses: Response[]) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetcher = async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const next = responses.shift();
		if (!next) throw new Error("unexpected request");
		return next;
	};
	return { fetcher, calls };
}

/** Run `fn` with console.warn captured. */
async function warnings<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: unknown; warned: unknown[][] }> {
	const warned: unknown[][] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => void warned.push(args);
	try {
		return { result: await fn(), warned };
	} catch (error) {
		return { error, warned };
	} finally {
		console.warn = original;
	}
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });

test("detailsQuery takes only Q-ids, once each, and the sitelink only for a plain language code", () => {
	const q = logic.detailsQuery(["Q90", "Q90", "q5", "P31", "Q1 } . ?x ?y ?z", "Q42"], "en");
	assert.match(q, /VALUES \?item \{ wd:Q90 wd:Q42 \}/);
	assert.doesNotMatch(q, /\?x|P31 \}|q5/);
	assert.match(q, /schema:isPartOf <https:\/\/en\.wikipedia\.org\/>/);
	assert.match(q, /FILTER\(\?r != wikibase:DeprecatedRank\)/);
	assert.match(q, /SELECT \?item \?class \?website \?rank \?title/);
	assert.match(q, /ps:P856 \?website ; wikibase:rank \?rank \. FILTER\(\?rank != wikibase:DeprecatedRank\)/);
	assert.doesNotMatch(logic.detailsQuery(["Q1"], "e>n"), /wikipedia/);
});

test("parseSparqlDetails gives the same details the wbgetentities parser did (recorded Q90, Q42, Q95, Q1, Q2)", () => {
	const parsed = logic.parseSparqlDetails(fixture("wikidata-details.sparql.json"), "en");
	const expected: Record<string, { p31: string[] }> = fixture("wikidata-details.expected.json");
	// SPARQL rows have no statement order, and P31 order doesn't matter to verification.
	const sorted = (o: Record<string, { p31: string[] }>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v, p31: [...v.p31].sort() }]));
	assert.deepEqual(sorted(parsed!), sorted(expected));
});

test("parseSparqlDetails keeps Q-ids and http(s) websites only, and rejects non-SPARQL bodies", () => {
	const row = (fields: Record<string, string>) => Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { type: "uri", value }]));
	const E = "http://www.wikidata.org/entity/";
	const out = logic.parseSparqlDetails(
		{
			results: {
				bindings: [
					row({ item: `${E}Q7`, class: `${E}Q5` }),
					row({ item: `${E}Q7`, class: `${E}Q5` }),
					row({ item: `${E}Q7`, class: "http://www.wikidata.org/.well-known/genid/abc" }),
					row({ item: `${E}Q7`, website: "ftp://example.com/" }),
					row({ item: `${E}Q7`, website: "https://example.com/" }),
					row({ item: `${E}Q7`, title: "A/B: C d" }),
					row({ item: `${E}L1`, class: `${E}Q5` }),
					row({ item: `${E}Q8` }),
				],
			},
		},
		"en",
	);
	assert.deepEqual(out, {
		Q7: { p31: ["Q5"], wikipedia: "https://en.wikipedia.org/wiki/A/B:_C_d", website: "https://example.com/" },
		Q8: { p31: [], wikipedia: "", website: "" },
	});
	assert.equal(logic.parseSparqlDetails({ error: "nope" }, "en"), null);
	assert.equal(logic.parseSparqlDetails(null, "en"), null);
});

test("parseSparqlDetails picks one website regardless of row order: preferred rank, then https, then the smallest URL", () => {
	const E = "http://www.wikidata.org/entity/";
	const R = "http://wikiba.se/ontology#";
	const site = (qid: string, website: string, rank = "NormalRank") => ({ item: { type: "uri", value: `${E}${qid}` }, website: { type: "uri", value: website }, rank: { type: "uri", value: `${R}${rank}` } });
	const rows = [
		site("Q1", "https://zzz.example/"),
		site("Q1", "http://preferred.example/", "PreferredRank"),
		site("Q1", "https://aaa.example/"),
		site("Q2", "http://aaa.example/"),
		site("Q2", "https://zzz.example/"),
		site("Q3", "https://b.example/"),
		site("Q3", "https://a.example/"),
	];
	const pick = (bindings: unknown[]) => Object.fromEntries(Object.entries(logic.parseSparqlDetails({ results: { bindings } }, "en")!).map(([k, v]) => [k, v.website]));
	const expected = { Q1: "http://preferred.example/", Q2: "https://zzz.example/", Q3: "https://a.example/" };
	assert.deepEqual(pick(rows), expected);
	assert.deepEqual(pick([...rows].reverse()), expected);
	// The recorded Q90 lists two websites with the http one first: the https one is kept.
	assert.equal(logic.parseSparqlDetails(fixture("wikidata-details.sparql.json"), "en")!.Q90.website, "https://www.paris.fr/");
});

test("userAgent follows the Wikimedia policy, with the repository as contact when the site has no URL", () => {
	assert.equal(logic.userAgent("1.2.3", "https://example.com"), "CoywolfPack/1.2.3 (https://example.com) EmDash");
	assert.equal(logic.userAgent("1.2.3", undefined), "CoywolfPack/1.2.3 (https://github.com/coywolf-llc/coywolf-pack) EmDash");
	assert.equal(logic.userAgent("1.2.3", ""), "CoywolfPack/1.2.3 (https://github.com/coywolf-llc/coywolf-pack) EmDash");
});

test("entityDetails makes one SPARQL request to query.wikidata.org", async () => {
	const { fetcher, calls } = fakeFetch(json(fixture("wikidata-details.sparql.json")));
	const details = await wikidata.entityDetails(fetcher, ["Q90", "Q42", "Q95", "Q1", "Q2", "bogus"], "en", UA);
	assert.equal(calls.length, 1);
	const url = new URL(calls[0].url);
	assert.equal(url.origin + url.pathname, `https://${wikidata.WIKIDATA_QUERY_HOST}/sparql`);
	assert.equal(url.searchParams.get("format"), "json");
	assert.match(url.searchParams.get("query")!, /wd:Q90 wd:Q42 wd:Q95 wd:Q1 wd:Q2 \}/);
	const headers = calls[0].init?.headers as Record<string, string>;
	assert.equal(headers["user-agent"], UA);
	assert.equal(headers.accept, "application/sparql-results+json");
	assert.deepEqual(Object.keys(details!).sort(), ["Q1", "Q2", "Q42", "Q90", "Q95"]);
	// Nothing to look up: no request.
	assert.deepEqual(await wikidata.entityDetails(fakeFetch().fetcher, ["P31"], "en", UA), {});
});

test("a non-OK answer is logged with its status and Retry-After; a 500 means 'didn't answer'", async () => {
	const { result, warned } = await warnings(() => wikidata.entityDetails(fakeFetch(new Response("down", { status: 503, headers: { "retry-after": "30" } })).fetcher, ["Q1"], "en", UA));
	assert.equal(result, null);
	assert.equal(warned.length, 1);
	assert.match(String(warned[0][0]), /query\.wikidata\.org.*HTTP 503/);
	assert.deepEqual(warned[0][1], { retryAfter: "30" });
	// Search: an empty result that isn't cached, so the next run asks again.
	const search = fakeFetch(new Response("down", { status: 502 }), json({ search: [{ id: "Q64", label: "Berlin" }] }));
	const first = await warnings(() => wikidata.searchCandidates(search.fetcher, "Berlin-uncached", "en", UA));
	assert.deepEqual(first.result, []);
	assert.match(String(first.warned[0][0]), /www\.wikidata\.org.*HTTP 502/);
	assert.deepEqual(await wikidata.searchCandidates(search.fetcher, "Berlin-uncached", "en", UA), [{ id: "Q64", label: "Berlin", description: "" }]);
});

test("HTTP 429 defers the job until Retry-After instead of failing it", async () => {
	const sparql = await warnings(() => wikidata.entityDetails(fakeFetch(new Response("slow down", { status: 429, headers: { "retry-after": "120" } })).fetcher, ["Q1"], "en", UA));
	assert.ok(sparql.error instanceof wikidata.WikidataBusyError);
	assert.equal((sparql.error as InstanceType<typeof wikidata.WikidataBusyError>).retryAfterMs, 120_000);
	assert.deepEqual(sparql.warned[0][1], { retryAfter: "120" });
	const search = await warnings(() => wikidata.searchCandidates(fakeFetch(new Response("", { status: 429 })).fetcher, "Paris-429", "en", UA));
	assert.ok(search.error instanceof wikidata.WikidataBusyError);
	assert.equal((search.error as InstanceType<typeof wikidata.WikidataBusyError>).retryAfterMs, 60_000, "no Retry-After: a minute");
});

test("api.php calls send maxlag=5, and a maxlag answer defers like a 429", async () => {
	const lagged = json({ error: { code: "maxlag", info: "Waiting for a database server: 6 seconds lagged." } }, { headers: { "retry-after": "5" } });
	const { fetcher, calls } = fakeFetch(lagged);
	const { error, warned } = await warnings(() => wikidata.searchCandidates(fetcher, "Paris-lag", "fr", UA));
	const url = new URL(calls[0].url);
	assert.equal(url.host, wikidata.WIKIDATA_HOST);
	assert.equal(url.searchParams.get("maxlag"), "5");
	assert.equal(url.searchParams.get("action"), "wbsearchentities");
	assert.equal(url.searchParams.get("language"), "fr");
	assert.ok(error instanceof wikidata.WikidataBusyError);
	assert.equal((error as InstanceType<typeof wikidata.WikidataBusyError>).retryAfterMs, 5_000);
	assert.match(String(warned[0][0]), /maxlag/);
});

test("retryAfterMs reads seconds or an HTTP date, within 5 seconds to an hour", () => {
	const now = Date.parse("2026-10-07T12:00:00Z");
	assert.equal(wikidata.retryAfterMs("30", now), 30_000);
	assert.equal(wikidata.retryAfterMs("Wed, 07 Oct 2026 12:02:00 GMT", now), 120_000);
	assert.equal(wikidata.retryAfterMs(null, now), 60_000);
	assert.equal(wikidata.retryAfterMs("soon", now), 60_000);
	assert.equal(wikidata.retryAfterMs("0", now), 5_000);
	assert.equal(wikidata.retryAfterMs("86400", now), 3_600_000);
});
