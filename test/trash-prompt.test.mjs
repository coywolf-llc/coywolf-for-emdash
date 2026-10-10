// Run: node --test test/trash-prompt.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { removalFromRequest, watchContentRemovals, collectRemovals } = await import("../src/admin/trash-prompt-core.ts");

test("trash and unpublish requests are removals; locale queries are ignored", () => {
	assert.deepEqual(removalFromRequest("DELETE", "/_emdash/api/content/posts/01JABC"), { id: "posts:01JABC", reason: "deleted" });
	assert.deepEqual(removalFromRequest("delete", "/_emdash/api/content/posts/01JABC?locale=fr"), { id: "posts:01JABC", reason: "deleted" });
	assert.deepEqual(removalFromRequest("POST", "https://example.com/_emdash/api/content/pages/9/unpublish?locale=en"), {
		id: "pages:9",
		reason: "unpublished",
	});
});

test("permanent deletes, restores, reads, and other routes are not", () => {
	assert.equal(removalFromRequest("DELETE", "/_emdash/api/content/posts/1/permanent"), null);
	assert.equal(removalFromRequest("POST", "/_emdash/api/content/posts/1/restore"), null);
	assert.equal(removalFromRequest("GET", "/_emdash/api/content/posts/1"), null);
	assert.equal(removalFromRequest("PUT", "/_emdash/api/content/posts/1"), null);
	assert.equal(removalFromRequest("DELETE", "/_emdash/api/content/posts/1/unpublish"), null);
	assert.equal(removalFromRequest("DELETE", "/_emdash/api/content/posts/1/schedule"), null);
	assert.equal(removalFromRequest("DELETE", "/_emdash/api/media/1"), null);
	assert.equal(removalFromRequest("DELETE", "/_emdash/api/content/posts"), null);
});

function fakeHost(status = 200) {
	const calls = [];
	const response = new Response("{}", { status });
	const host = {
		fetch(input, init) {
			calls.push({ input, init, self: this });
			return Promise.resolve(response);
		},
	};
	return { host, calls, response };
}

test("the wrapper returns the original Response, wraps once, and reports removals", async () => {
	const { host, calls, response } = fakeHost();
	const seen = [];
	assert.equal(watchContentRemovals((r) => seen.push(r), host), true);
	assert.equal(watchContentRemovals((r) => seen.push(r), host), false);
	const result = await host.fetch("/_emdash/api/content/posts/7", { method: "DELETE" });
	assert.equal(result, response);
	assert.equal(result.bodyUsed, false);
	assert.equal(calls[0].self, host);
	await host.fetch(new Request("http://x/_emdash/api/content/posts/8/unpublish", { method: "POST" }));
	await host.fetch("/_emdash/api/content/posts/9");
	assert.deepEqual(seen, [
		{ id: "posts:7", reason: "deleted" },
		{ id: "posts:8", reason: "unpublished" },
	]);
});

test("failed requests aren't reported, and a throwing callback never breaks the request", async () => {
	const failing = fakeHost(500);
	const seen = [];
	watchContentRemovals((r) => seen.push(r), failing.host);
	await failing.host.fetch("/_emdash/api/content/posts/7", { method: "DELETE" });
	assert.deepEqual(seen, []);

	const ok = fakeHost();
	watchContentRemovals(() => {
		throw new Error("boom");
	}, ok.host);
	assert.equal(await ok.host.fetch("/_emdash/api/content/posts/7", { method: "DELETE" }), ok.response);
});

test("network errors still reject as before", async () => {
	const host = { fetch: () => Promise.reject(new TypeError("offline")) };
	watchContentRemovals(() => {}, host);
	await assert.rejects(host.fetch("/x"), /offline/);
});

/** Manual timers: run() fires everything due, in order. */
function fakeTimers() {
	let now = 0;
	let next = 1;
	const timers = new Map();
	return {
		setTimer: (fn, ms) => {
			const id = next++;
			timers.set(id, { fn, at: now + ms });
			return id;
		},
		clearTimer: (id) => timers.delete(id),
		async advance(ms) {
			const until = now + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await new Promise((r) => setImmediate(r));
			}
			now = until;
		},
	};
}

const item = (id, reason = "deleted") => ({ id, collection: id.split(":")[0], url: `/${id}`, title: id, reason, at: "" });

test("bulk trash: one look after the burst, one prompt with every recorded entry", async () => {
	const timers = fakeTimers();
	let looks = 0;
	const ready = [];
	const add = collectRemovals({
		...timers,
		fetchPending: async () => {
			looks++;
			return [item("posts:1"), item("posts:2"), item("posts:old")];
		},
		onReady: (items) => ready.push(items.map((i) => i.id)),
	});
	add({ id: "posts:1", reason: "deleted" });
	await timers.advance(300);
	add({ id: "posts:2", reason: "deleted" });
	await timers.advance(699);
	assert.equal(looks, 0);
	await timers.advance(1);
	assert.equal(looks, 1);
	assert.deepEqual(ready, [["posts:1", "posts:2"]]);
});

test("unpublish recorded late: retried until it shows up", async () => {
	const timers = fakeTimers();
	let looks = 0;
	const ready = [];
	const add = collectRemovals({
		...timers,
		fetchPending: async () => (++looks < 3 ? [] : [item("posts:5", "unpublished")]),
		onReady: (items) => ready.push(items.map((i) => i.id)),
	});
	add({ id: "posts:5", reason: "unpublished" });
	await timers.advance(700);
	assert.equal(looks, 1);
	await timers.advance(600);
	assert.equal(looks, 2);
	await timers.advance(1500);
	assert.equal(looks, 3);
	assert.deepEqual(ready, [["posts:5"]]);
});

test("drafts (never recorded) give up quietly after the retries", async () => {
	const timers = fakeTimers();
	let looks = 0;
	const ready = [];
	const add = collectRemovals({ ...timers, fetchPending: async () => (looks++, []), onReady: (items) => ready.push(items) });
	add({ id: "posts:draft", reason: "deleted" });
	await timers.advance(10_000);
	assert.equal(looks, 3);
	assert.deepEqual(ready, []);
});

test("feature off or no permission (null) or a failed read: no prompt, no retries", async () => {
	for (const fetchPending of [async () => null, async () => Promise.reject(new Error("403"))]) {
		const timers = fakeTimers();
		let looks = 0;
		const ready = [];
		const add = collectRemovals({ ...timers, fetchPending: () => (looks++, fetchPending()), onReady: (items) => ready.push(items) });
		add({ id: "posts:1", reason: "deleted" });
		await timers.advance(10_000);
		assert.equal(looks, 1);
		assert.deepEqual(ready, []);
	}
});
