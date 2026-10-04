import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { buildOrQuery, queryTerms, rankByCoverage, MAX_OR_TERMS } = await import("../src/search/fallback.ts");
const { decide, currentWindow, MemoryWindowCounter, isLimitedPath, limitClient } = await import("../src/search/ratelimit-core.ts");

test("OR query: bare prefix terms joined with OR", () => {
	assert.equal(buildOrQuery("coyote wolf hybrid"), "coyote* OR wolf* OR hybrid*");
});

test("OR query: lower-cases, strips punctuation and quotes, de-duplicates", () => {
	assert.equal(buildOrQuery('"Red Wolf" red-wolves, (pack)'), "red* OR wolf* OR wolves* OR pack*");
});

test("OR query: drops stopwords and one-letter words unless nothing else is left", () => {
	assert.equal(buildOrQuery("the history of a wolf pack"), "history* OR wolf* OR pack*");
	assert.equal(buildOrQuery("to be or it"), "to* OR be* OR or* OR it*"); // all stopwords: keep them
	assert.equal(buildOrQuery("to be or not"), "not"); // one word left: plain query, EmDash escapes it
	assert.equal(buildOrQuery("x 7 wolves"), "7* OR wolves*");
});

test("OR query: null when a fallback can't add anything", () => {
	assert.equal(buildOrQuery(""), null);
	assert.equal(buildOrQuery("   "), null);
	assert.equal(buildOrQuery("wolf"), null);
	assert.equal(buildOrQuery("the wolf"), "wolf"); // one meaningful word, without the stopword
	assert.equal(buildOrQuery("a b"), null); // nothing usable
	assert.equal(buildOrQuery("cats OR dogs"), null); // the visitor wrote operators
	assert.equal(buildOrQuery("wolf NOT coyote"), null);
});

test("OR query: lower-case operator words are just words", () => {
	assert.equal(buildOrQuery("near wolf dens"), "near* OR wolf* OR dens*");
});

test("OR query: never contains quotes, parentheses or column filters (EmDash passes it through)", () => {
	const q = buildOrQuery('title:"x" (a OR b) ^start NEAR/3 * -- \\ ; DROP');
	assert.equal(q, null); // contains upper-case operators
	const q2 = buildOrQuery('title:"wolves" ^start * -- \\ ; drop');
	assert.ok(q2);
	assert.match(q2, /^[\p{L}\p{N}* ]+(?: OR [\p{L}\p{N}*]+)*$/u);
	assert.ok(!/["():^\;-]/.test(q2));
});

test("OR query: caps the number of terms", () => {
	const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
	assert.equal(buildOrQuery(words).split(" OR ").length, MAX_OR_TERMS);
});

test("OR query: keeps non-Latin words", () => {
	assert.equal(buildOrQuery("loup coyote 狼"), "loup* OR coyote* OR 狼*");
	assert.deepEqual(queryTerms("Éclair éclair ÉCLAIR"), ["éclair"]);
});

test("coverage ranking: more of the visitor's words first, then BM25", () => {
	const results = [
		{ id: "a", title: "Wolf facts", snippet: "about the <mark>wolf</mark>", score: 9 },
		{ id: "b", title: "Coyote and wolf", snippet: "a <mark>coyote</mark> met a <mark>wolf</mark>", score: 2 },
		{ id: "c", title: "Coyotes", snippet: "", score: 5 },
		{ id: "d", title: "Wolf pack", snippet: "", score: 3 },
	];
	assert.deepEqual(
		rankByCoverage(results, "coyote wolf").map((r) => r.id),
		["b", "a", "c", "d"],
	);
});

test("rate limit window: fixed one-minute windows", () => {
	assert.deepEqual(currentWindow(125_000), { start: 120_000, resetAt: 180_000 });
	assert.deepEqual(currentWindow(120_000), { start: 120_000, resetAt: 180_000 });
});

test("rate limit decide: allows up to the limit, then 429 with Retry-After until the window resets", () => {
	assert.deepEqual(decide(0, 2, 120_500), { allowed: true, count: 1, retryAfter: 60 });
	assert.deepEqual(decide(1, 2, 150_000), { allowed: true, count: 2, retryAfter: 30 });
	assert.deepEqual(decide(2, 2, 179_100), { allowed: false, count: 2, retryAfter: 1 });
	assert.equal(decide(1000, 0, 0).allowed, true); // 0 = off
});

test("rate limit memory counter: per client, resets each window", () => {
	const counter = new MemoryWindowCounter();
	const t = 60_000;
	assert.equal(counter.hit("a", 3, t).allowed, true);
	assert.equal(counter.hit("a", 3, t + 1).allowed, true);
	assert.equal(counter.hit("a", 3, t + 2).allowed, true);
	const denied = counter.hit("a", 3, t + 30_000);
	assert.equal(denied.allowed, false);
	assert.equal(denied.retryAfter, 30);
	assert.equal(counter.hit("b", 3, t + 30_000).allowed, true); // another client
	assert.equal(counter.hit("a", 3, t + 60_000).allowed, true); // next window
});

test("rate limit memory counter: bounded size", () => {
	const counter = new MemoryWindowCounter(100);
	for (let i = 0; i < 1000; i++) counter.hit(`ip${i}`, 10, 0);
	assert.ok(counter.size <= 100);
	counter.hit("late", 10, 60_000);
	assert.ok(counter.size <= 100);
});

test("rate limit paths: public search endpoints only", () => {
	assert.ok(isLimitedPath("/_emdash/api/search"));
	assert.ok(isLimitedPath("/_emdash/api/search/"));
	assert.ok(isLimitedPath("/_emdash/api/search/suggest"));
	assert.ok(isLimitedPath("/_emdash/api/plugins/coywolf-pack/search/query"));
	assert.ok(!isLimitedPath("/_emdash/api/search/rebuild"));
	assert.ok(!isLimitedPath("/_emdash/api/search/stats"));
	assert.ok(!isLimitedPath("/_emdash/api/search/enable"));
	assert.ok(!isLimitedPath("/search"));
});

test("rate limit binding: the binding decides, keyed by the client hash", async () => {
	const seen = [];
	const binding = { limit: async ({ key }) => (seen.push(key), { success: seen.length <= 2 }) };
	const memory = new MemoryWindowCounter();
	const opts = { limit: 1, now: 0, memory, binding };
	assert.deepEqual(await limitClient("h1", opts), { allowed: true, retryAfter: 60 });
	assert.equal((await limitClient("h1", opts)).allowed, true); // binding's limit, not the memory limit of 1
	assert.deepEqual(await limitClient("h1", opts), { allowed: false, retryAfter: 60 });
	assert.deepEqual(seen, ["h1", "h1", "h1"]);
	assert.equal(memory.size, 0); // memory counter unused
});

test("rate limit binding: errors fall back to the memory counter", async () => {
	const binding = { limit: async () => { throw new Error("unavailable"); } };
	const memory = new MemoryWindowCounter();
	const opts = { limit: 1, now: 0, memory, binding };
	assert.equal((await limitClient("h", opts)).allowed, true);
	assert.equal((await limitClient("h", opts)).allowed, false);
});

test("rate limit without a binding: memory counter, 0 turns it off", async () => {
	const memory = new MemoryWindowCounter();
	assert.equal((await limitClient("h", { limit: 1, now: 0, memory })).allowed, true);
	assert.deepEqual(await limitClient("h", { limit: 1, now: 45_000, memory }), { allowed: false, retryAfter: 15 });
	assert.equal((await limitClient("h", { limit: 0, now: 0, memory })).allowed, true);
});
