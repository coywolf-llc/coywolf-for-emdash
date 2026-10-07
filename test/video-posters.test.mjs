// Run: node --test test/video-posters.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { mirrorPoster, posterKey, resetMirroredPosters } = await import("../src/videos/poster.ts");

const UID = "a67dcf0925d0747f8c5419df6400c2b5";
const SRC = `https://customer-x.cloudflarestream.com/${UID}/thumbnails/thumbnail.jpg?time=3s&width=1600`;

function bucket(initial = {}) {
	const objects = new Map(Object.entries(initial));
	return {
		objects,
		heads: 0,
		async head(key) {
			this.heads++;
			return objects.has(key) ? {} : null;
		},
		async put(key, value, options) {
			objects.set(key, { value, options });
		},
	};
}
const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });

test("poster keys are flat, stable and differ by poster time", async () => {
	const key = await posterKey(UID, SRC);
	assert.match(key, /^cwposter-[0-9a-f]{32}-[0-9a-f]{12}\.jpg$/);
	assert.equal(key, await posterKey(UID, SRC));
	assert.notEqual(key, await posterKey(UID, SRC.replace("time=3s", "time=4s")));
});

test("a poster is copied once, then served from the bucket", async () => {
	resetMirroredPosters();
	const b = bucket();
	let fetches = 0;
	const fetcher = async () => (fetches++, image());
	const [one, two] = await Promise.all([mirrorPoster(b, "k.jpg", SRC, fetcher), mirrorPoster(b, "k.jpg", SRC, fetcher)]);
	assert.ok(one && two);
	assert.equal(fetches, 1, "concurrent renders share one copy");
	assert.equal(b.objects.get("k.jpg").options.httpMetadata.contentType, "image/jpeg");
	assert.ok(await mirrorPoster(b, "k.jpg", SRC, fetcher));
	assert.equal(fetches, 1);
	assert.equal(b.heads, 1, "remembered in the isolate");
});

test("a poster already in the bucket isn't fetched", async () => {
	resetMirroredPosters();
	const b = bucket({ "k.jpg": {} });
	assert.ok(await mirrorPoster(b, "k.jpg", SRC, async () => assert.fail("fetched")));
});

test("a failed copy falls back and is retried later", async () => {
	resetMirroredPosters();
	const b = bucket();
	assert.equal(await mirrorPoster(b, "k.jpg", SRC, async () => new Response("nope", { status: 404 })), false);
	assert.equal(await mirrorPoster(b, "k.jpg", SRC, async () => new Response("<html>", { headers: { "content-type": "text/html" } })), false);
	assert.equal(await mirrorPoster(b, "k.jpg", SRC, async () => Promise.reject(new Error("timeout"))), false);
	await new Promise((r) => setTimeout(r, 0));
	assert.ok(await mirrorPoster(b, "k.jpg", SRC, async () => image()));
	assert.ok(b.objects.has("k.jpg"));
});

test("warming requests every size as AVIF and WebP", async () => {
	const { warmSizes } = await import("../src/videos/poster.ts");
	const seen = [];
	await warmSizes(["https://m/s/480/k.jpg", "https://m/s/800/k.jpg"], async (url, init) => {
		seen.push(`${url} ${init.headers.accept}`);
		return new Response("x");
	});
	assert.deepEqual(seen.sort(), [
		"https://m/s/480/k.jpg image/avif",
		"https://m/s/480/k.jpg image/webp",
		"https://m/s/800/k.jpg image/avif",
		"https://m/s/800/k.jpg image/webp",
	]);
});

test("rendering never waits: an unlisted poster comes from Stream while it's copied after the response", async () => {
	resetMirroredPosters();
	const { mediaPoster } = await import("../src/videos/poster.ts");
	const b = bucket();
	// The bucket answers only when released, after the render has returned.
	let release;
	const gate = new Promise((r) => (release = r));
	const head = b.head.bind(b);
	b.head = async (key) => (await gate, head(key));
	const deferred = [];
	const listed = new Set();
	const warmed = [];
	const fetcher = async (url, init) => {
		if (init?.headers?.accept) return (warmed.push(url), new Response("x"));
		return image();
	};
	const deps = { cdn: "https://media.example.com", bucket: b, listed, list: async (k) => void listed.add(k), defer: (p) => deferred.push(p), fetcher };
	assert.equal(await mediaPoster(UID, SRC, deps), null, "Stream's poster for this render");
	assert.equal(deferred.length, 1);
	assert.equal(await mediaPoster(UID, SRC, deps), null);
	assert.equal(deferred.length, 1, "one copy per isolate");
	assert.equal(listed.size, 0, "the copy is still waiting on the bucket");
	release();
	await Promise.all(deferred);
	const key = await posterKey(UID, SRC);
	assert.ok(listed.has(key), "listed once copied");
	assert.equal(warmed.length, 6, "a new copy is resized at each size, AVIF and WebP");
	const media = await mediaPoster(UID, SRC, deps);
	assert.equal(media.full, `https://media.example.com/s/1200/${key}`);
	assert.match(media.srcset, /\/s\/400\/.* 400w, .*\/s\/800\/.* 800w, .*\/s\/1200\/.* 1200w$/);
});

test("a listed poster is served from the media host without touching the bucket", async () => {
	resetMirroredPosters();
	const { mediaPoster } = await import("../src/videos/poster.ts");
	const key = await posterKey(UID, SRC);
	const b = bucket();
	const deps = { cdn: "https://m", bucket: b, listed: new Set([key]), list: async () => assert.fail("listed again"), defer: () => assert.fail("deferred work") };
	const media = await mediaPoster(UID, SRC, deps);
	assert.equal(media.src, `https://m/s/800/${key}`);
	assert.equal(b.heads, 0);
});

test("a poster already in the bucket is listed but not warmed again", async () => {
	resetMirroredPosters();
	const { mediaPoster } = await import("../src/videos/poster.ts");
	const key = await posterKey(UID, SRC);
	const b = bucket({ [key]: {} });
	const deferred = [];
	const listed = new Set();
	const deps = { cdn: "https://m", bucket: b, listed, list: async (k) => void listed.add(k), defer: (p) => deferred.push(p), fetcher: async () => assert.fail("fetched") };
	await mediaPoster(UID, SRC, deps);
	await Promise.all(deferred);
	assert.ok(listed.has(key));
});

test("listing a poster appends once, keeps other keys and stops at the cap", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { listPoster, POSTERS_OPTION, MAX_LISTED_POSTERS } = await import("../src/videos/poster.ts");
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT, revision INTEGER)");
	const db = { prepare: (sql) => ({ bind: (...args) => ({ run: async () => sqlite.prepare(sql).run(...args) }) }) };
	const read = () => JSON.parse(sqlite.prepare("SELECT value FROM options WHERE name = ?").get(POSTERS_OPTION).value);
	const set = (value) => sqlite.prepare("UPDATE options SET value = ? WHERE name = ?").run(value, POSTERS_OPTION);
	await listPoster(db, "a.jpg");
	await listPoster(db, "b.jpg");
	await listPoster(db, "a.jpg");
	assert.deepEqual(read(), ["a.jpg", "b.jpg"]);
	set(JSON.stringify(Array.from({ length: MAX_LISTED_POSTERS }, (_, i) => `k${i}`)));
	await listPoster(db, "c.jpg");
	assert.equal(read().length, MAX_LISTED_POSTERS);
	set("not json");
	await listPoster(db, "d.jpg");
	assert.deepEqual(read(), ["d.jpg"]);
});

test("a Stream poster shown while its copy is made marks the request, through locals or the isolate count", async () => {
	resetMirroredPosters();
	const { markPendingPoster, pendingPosterRenders, renderedPendingPoster, PENDING_POSTER_LOCAL } = await import("../src/videos/poster.ts");
	const locals = {};
	const before = pendingPosterRenders();
	assert.equal(renderedPendingPoster(locals, before), false);
	markPendingPoster(locals);
	assert.equal(locals[PENDING_POSTER_LOCAL], true);
	assert.equal(renderedPendingPoster(locals, before), true);
	assert.equal(pendingPosterRenders(), before, "flagged on locals, not counted");

	// A theme calling hostedPosterImage() without locals is still noticed.
	const other = {};
	const start = pendingPosterRenders();
	markPendingPoster();
	assert.equal(renderedPendingPoster(other, start), true);
	assert.equal(renderedPendingPoster(other, pendingPosterRenders()), false);
});
