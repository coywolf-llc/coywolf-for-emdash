import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore -- Node's type stripping needs the .ts extension.
import { IndexNowBatcher, KEY_PATTERN, buildPayload, generateKey, keyFromPath } from "./indexnow.ts";
// @ts-ignore -- Node's type stripping needs the .ts extension.
import { buildLlmsTxt } from "./llms.ts";

/** A batcher whose deferred tasks we run by hand. */
function harness(windowMs = 3000) {
	const tasks: (() => Promise<void>)[] = [];
	const sleeps: number[] = [];
	const sent: string[][] = [];
	const batcher = new IndexNowBatcher({
		windowMs,
		defer: (task: () => Promise<void>) => tasks.push(task),
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
	});
	const send = async (urls: string[]) => {
		sent.push(urls);
	};
	return { batcher, tasks, sleeps, sent, send };
}

test("URLs added within the window go out once, deduped", async () => {
	const h = harness();
	h.batcher.add("https://e.com/a", h.send);
	h.batcher.add(["https://e.com/b", "https://e.com/a"], h.send);
	h.batcher.add("https://e.com/a", h.send);
	assert.equal(h.tasks.length, 1, "only one flush is scheduled");
	assert.equal(h.batcher.size, 2);
	await h.tasks[0]();
	assert.deepEqual(h.sleeps, [3000]);
	assert.deepEqual(h.sent, [["https://e.com/a", "https://e.com/b"]]);
	assert.equal(h.batcher.size, 0);
});

test("a new batch starts after a flush", async () => {
	const h = harness(10);
	h.batcher.add("https://e.com/a", h.send);
	await h.tasks[0]();
	h.batcher.add("https://e.com/a", h.send);
	assert.equal(h.tasks.length, 2);
	await h.tasks[1]();
	assert.deepEqual(h.sent, [["https://e.com/a"], ["https://e.com/a"]]);
});

test("the most recent sender is used; empty adds schedule nothing", async () => {
	const h = harness();
	const other: string[][] = [];
	h.batcher.add([], h.send);
	h.batcher.add("", h.send);
	assert.equal(h.tasks.length, 0);
	h.batcher.add("https://e.com/a", h.send);
	h.batcher.add("https://e.com/b", async (urls: string[]) => {
		other.push(urls);
	});
	await h.tasks[0]();
	assert.deepEqual(h.sent, []);
	assert.deepEqual(other, [["https://e.com/a", "https://e.com/b"]]);
});

test("payload keeps only same-host URLs and points at the key file", () => {
	const payload = buildPayload("https://example.com", "abc12345", ["https://example.com/a", "https://other.com/x", "https://example.com/a", "nonsense"]);
	assert.deepEqual(payload, {
		host: "example.com",
		key: "abc12345",
		keyLocation: "https://example.com/abc12345.txt",
		urlList: ["https://example.com/a"],
	});
	assert.equal(buildPayload("https://example.com", "abc12345", ["https://other.com/"]), null);
});

test("keys", () => {
	const key = generateKey();
	assert.match(key, /^[0-9a-f]{32}$/);
	assert.ok(KEY_PATTERN.test(key));
	assert.equal(keyFromPath(`/${key}.txt`), key);
	assert.equal(keyFromPath("/robots.txt"), null);
	assert.equal(keyFromPath("/a/b.txt"), null);
});

test("llms.txt layout: H1, summary, sections, Optional overflow, cap", () => {
	const entries = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i}`, url: `https://e.com/${prefix}/${i}/index.html.md` }));
	const body = buildLlmsTxt({
		name: "Example [Site]",
		siteUrl: "https://e.com",
		summary: "",
		intro: "",
		markdownLinks: true,
		sections: [
			{ label: "Posts", entries: [{ title: "Hello (world)", url: "https://e.com/hello/index.html.md", note: "An excerpt" }, ...entries(102, "p")] },
			{ label: "Pages", entries: entries(2, "g") },
		],
		maxEntries: 104,
	});
	const lines = body.split("\n");
	assert.equal(lines[0], "# Example \\[Site\\]");
	assert.equal(lines[2], "> A curated, agent-readable index of this site's public content.");
	assert.ok(body.includes("- [Hello (world)](https://e.com/hello/index.html.md): An excerpt\n"));
	assert.ok(body.includes("\n## Posts\n"));
	assert.ok(body.includes("\n## Pages\n"));
	assert.ok(body.includes("\n## Optional\n"));
	assert.equal((body.match(/^- \[/gm) ?? []).length, 104);
});
