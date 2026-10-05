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
