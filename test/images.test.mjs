// Run: node --test test/images.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { cleanImagePath, parseImagePath, mediaFile } = await import("../src/images/lib.ts");

test("builds clean paths for media-library files", () => {
	assert.equal(cleanImagePath("/_emdash/api/media/file/01M44MRR9G4JZH2SQTGN4Y4G0D.webp", { width: 600, height: 315 }), "/media/01M44MRR9G4JZH2SQTGN4Y4G0D-600x315.webp");
	assert.equal(cleanImagePath("https://example.com/_emdash/api/media/file/ABC.jpeg", { width: 400 }), "/media/ABC-400w.webp");
	assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.png", { width: 800, height: 420, format: "avif" }), "/media/ABC-800x420.avif");
});

test("refuses anything else", () => {
	assert.equal(cleanImagePath("/theme/images/logo.png", { width: 100 }), null);
	assert.equal(cleanImagePath("https://cdn.example.com/x.webp", { width: 100 }), null);
	assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 0 }), null);
	assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 9000 }), null);
	assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 100, format: "svg" }), null);
	assert.equal(mediaFile("/_emdash/api/media/file/../secret.webp"), null);
});

test("parses clean paths and round-trips", () => {
	assert.deepEqual(parseImagePath("/media/ABC-600x315.webp"), { id: "ABC", width: 600, height: 315, format: "webp" });
	assert.deepEqual(parseImagePath("/media/ABC-400w.jpg"), { id: "ABC", width: 400, height: undefined, format: "jpg" });
	assert.equal(parseImagePath("/media/ABC-600x315.svg"), null);
	assert.equal(parseImagePath("/media/ABC-99999x1.webp"), null);
	assert.equal(parseImagePath("/media/../x-1x1.webp"), null);
	assert.equal(parseImagePath("/media/ABC.webp"), null);
	const p = cleanImagePath("/_emdash/api/media/file/ID_1.webp", { width: 640, height: 336 });
	assert.deepEqual(parseImagePath(p), { id: "ID_1", width: 640, height: 336, format: "webp" });
});
