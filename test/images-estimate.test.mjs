// Run: node --test test/images-estimate.test.mjs
// Stored image sizes: the cost estimate and traffic calculator shown on the Clean Image URLs page.
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const E = await import("../src/images/variants-estimate.ts");

test("each image is planned like the generator: widths below the original, AVIF only up to 1,200 pixels", () => {
	assert.deepEqual(E.planImage(1000, 600), { sizes: 3, files: 6, transforms: 6, bytes: 2 * (25_000 + 50_000 + 75_000) });
	// 2000×3000: 800 wide is 1200 tall (AVIF made); 1200 and 1600 wide are taller than 1,200 (WebP only).
	assert.equal(E.planImage(2000, 3000).transforms, 2 + 2 + 2 + 1 + 1);
	assert.deepEqual(E.planImage(300, 200), { sizes: 0, files: 0, transforms: 0, bytes: 0 });
});

test("library summary: only eligible images; one-time transformations only for images without their sizes", () => {
	const rows = [
		{ mime_type: "image/jpeg", width: 1000, height: 600, size: 1, current: 0 },
		{ mime_type: "image/png", width: 1000, height: 600, size: 1, current: 1 },
		{ mime_type: "image/gif", width: 1000, height: 600, size: 1, current: 0 },
		{ mime_type: "image/jpeg", width: null, height: null, size: 1, current: 0 },
		{ mime_type: "image/jpeg", width: 2000, height: 1000, size: 30 * 1024 * 1024, current: 0 },
	];
	const s = E.summarizeLibrary(rows);
	assert.deepEqual({ images: s.images, done: s.done, sizes: s.sizes, files: s.files, transforms: s.transforms, filesLeft: s.filesLeft }, { images: 2, done: 1, sizes: 6, files: 12, transforms: 6, filesLeft: 6 });
});

test("costs: one-time range around the free 5,000, storage, monthly at most", () => {
	assert.deepEqual(E.oneTimeCost(4000), { min: 0, max: 2 });
	assert.deepEqual(E.oneTimeCost(25_000), { min: 10, max: 12.5 });
	assert.ok(Math.abs(E.storageCost(2e9) - 0.03) < 1e-9);
	assert.equal(E.monthlyWithoutMax(5000), 0);
	assert.equal(E.monthlyWithoutMax(15_000), 5);
	assert.equal(E.paybackMonths(12.5, 5), 3);
	assert.equal(E.paybackMonths(2, 5), 1, "the first month");
	assert.equal(E.paybackMonths(0, 0), 1, "nothing to pay");
	assert.equal(E.paybackMonths(5, 0), null, "never");
});

test("traffic: distinct pages from views, crawlers' floor, about three sizes per image shown", () => {
	const base = { pages: 1000, images: 2000, sizes: 8000, bytes: 0, crawlers: false };
	const none = E.trafficEstimate({ ...base, views: 0 });
	assert.deepEqual({ p: none.pagesVisited, w: none.withoutTransforms, c: none.withoutCost }, { p: 0, w: 0, c: 0 });
	const some = E.trafficEstimate({ ...base, views: 1000 });
	assert.equal(some.pagesVisited, Math.round(1000 * (1 - Math.exp(-1))));
	assert.equal(some.imagesShown, Math.round(2000 * some.pagesVisited / 1000));
	assert.equal(some.withoutTransforms, some.imagesShown * 3 + some.pagesVisited);
	const crawled = E.trafficEstimate({ ...base, views: 10, crawlers: true });
	assert.equal(crawled.pagesVisited, 800, "search engines fetch at least 80% of pages");
	const lots = E.trafficEstimate({ ...base, views: 1e7, crawlers: true });
	assert.equal(lots.pagesVisited, 1000);
	assert.equal(lots.withoutTransforms, 2000 * 3 + 1000);
	assert.equal(lots.withoutCost, (7000 - 5000) * 0.0005);
	assert.equal(lots.withTransforms, 1000);
	assert.equal(lots.withCost, 0);
	assert.equal(lots.savings, lots.withoutCost);
	const small = E.trafficEstimate({ ...base, sizes: 2000, views: 1e7 });
	assert.equal(small.withoutTransforms, 2000 * 1 + 1000, "capped by the sizes images have");
	assert.equal(E.trafficEstimate({ ...base, pages: 0, views: 100 }).withoutTransforms, 0);
});
