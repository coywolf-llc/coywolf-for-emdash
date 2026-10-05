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

// ── Media host ───────────────────────────────────────────────────

const { setImageCdn, setSavedImageCdn, imageCdn, cdnOriginalUrl, parseCdnUrl, cdnRedirectUrl, normalizeMediaHost, mimeForExt } = await import("../src/images/lib.ts");

function withHost(option, saved, fn) {
	setImageCdn(option);
	setSavedImageCdn(saved);
	try {
		fn();
	} finally {
		setImageCdn(null);
		setSavedImageCdn(null);
	}
}

test("normalizes media hosts to https origins and refuses anything else", () => {
	assert.equal(normalizeMediaHost("media.example.com"), "https://media.example.com");
	assert.equal(normalizeMediaHost(" https://Media.Example.com/ "), "https://media.example.com");
	assert.equal(normalizeMediaHost("http://media.example.com"), null);
	assert.equal(normalizeMediaHost("https://media.example.com/images"), null);
	assert.equal(normalizeMediaHost("https://media.example.com:8443"), null);
	assert.equal(normalizeMediaHost("https://user@media.example.com"), null);
	assert.equal(normalizeMediaHost("localhost"), null);
	assert.equal(normalizeMediaHost("javascript:alert(1)"), null);
	assert.equal(normalizeMediaHost(""), null);
	withHost("http://media.example.com", null, () => assert.equal(imageCdn(), null));
	withHost("not a host", null, () => assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.webp", { width: 100 }), "/media/ABC-100w.webp"));
});

test("the saved host wins over the option", () => {
	withHost("https://media.example.com", "https://img.example.com", () => assert.equal(imageCdn(), "https://img.example.com"));
	withHost("https://media.example.com", null, () => assert.equal(imageCdn(), "https://media.example.com"));
	withHost(null, null, () => assert.equal(imageCdn(), null));
});

test("builds media-host URLs when a host is set", () => {
	withHost("https://media.example.com/", null, () => {
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.jpg", { width: 440, height: 231 }), "https://media.example.com/s/440x231/ABC.jpg");
		assert.equal(cleanImagePath("https://example.com/_emdash/api/media/file/ABC.png", { width: 800, format: "avif" }), "https://media.example.com/s/800/ABC.png");
		assert.equal(cleanImagePath("/_emdash/api/media/file/ABC.jpg", { width: 9000 }), null);
		assert.equal(cleanImagePath("/theme/logo.png", { width: 100 }), null);
		assert.equal(cdnOriginalUrl("/_emdash/api/media/file/18E5PEHBYCAWPT0B358WYBF02C.webp"), "https://media.example.com/18E5PEHBYCAWPT0B358WYBF02C.webp");
		assert.equal(cdnOriginalUrl("https://media.example.com/s/440x231/ABC.jpg"), "https://media.example.com/ABC.jpg");
		assert.equal(cdnOriginalUrl("/theme/logo.png"), null);
	});
	withHost(null, null, () => assert.equal(cdnOriginalUrl("/_emdash/api/media/file/ABC.webp"), null));
});

test("parses media-host URLs", () => {
	withHost("https://media.example.com", null, () => {
		assert.deepEqual(parseCdnUrl("https://media.example.com/ABC.webp"), { id: "ABC", ext: "webp", width: undefined, height: undefined });
		assert.deepEqual(parseCdnUrl("https://media.example.com/s/440x231/ABC.jpg"), { id: "ABC", ext: "jpg", width: 440, height: 231 });
		assert.deepEqual(parseCdnUrl("https://media.example.com/s/800/ABC.png?v=1"), { id: "ABC", ext: "png", width: 800, height: undefined });
		assert.equal(parseCdnUrl("https://media.example.com/s/9999/ABC.png"), null);
		assert.equal(parseCdnUrl("https://media.example.com/s/0x10/ABC.png"), null);
		assert.equal(parseCdnUrl("https://media.example.com/other/ABC.png"), null);
		assert.equal(parseCdnUrl("https://media.example.com.evil.com/ABC.png"), null);
		assert.equal(parseCdnUrl("https://other.example.com/ABC.png"), null);
		assert.equal(parseCdnUrl("/media/ABC-1x1.webp"), null);
		const url = cleanImagePath("/_emdash/api/media/file/ID_1.webp", { width: 640, height: 336 });
		assert.deepEqual(parseCdnUrl(url), { id: "ID_1", ext: "webp", width: 640, height: 336 });
	});
	withHost(null, null, () => assert.equal(parseCdnUrl("https://media.example.com/ABC.webp"), null));
});

test("old Worker-route URLs redirect to the same size on the media host", () => {
	withHost("https://media.example.com", null, () => {
		assert.equal(cdnRedirectUrl(parseImagePath("/media/ABC-600x315.webp"), "ABC.jpg"), "https://media.example.com/s/600x315/ABC.jpg");
		assert.equal(cdnRedirectUrl(parseImagePath("/media/ABC-400w.avif"), "ABC.png"), "https://media.example.com/s/400/ABC.png");
		assert.equal(cdnRedirectUrl({ width: 10 }, "../x.png"), null);
		assert.equal(cdnRedirectUrl({ width: 10 }, "a/b.png"), null);
	});
	withHost(null, null, () => assert.equal(cdnRedirectUrl({ width: 10 }, "ABC.png"), null));
});

test("knows original MIME types by extension", () => {
	assert.equal(mimeForExt("JPG"), "image/jpeg");
	assert.equal(mimeForExt("gif"), "image/gif");
	assert.equal(mimeForExt("svg"), "image/svg+xml");
	assert.equal(mimeForExt("bin"), undefined);
});
