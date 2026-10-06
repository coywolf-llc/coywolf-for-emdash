// Run: node --test test/video-display.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { SHOW_DEFAULTS, parseTags, playerConfig, resolveShow } = await import("../src/videos/lib.ts");
const { relativeDate, videoDateText } = await import("../src/videos/date.ts");
const {
	DISPLAY_DEFAULTS,
	LIKE_ICON_PATHS,
	VIDEO_CSS,
	captionHtml,
	displayVars,
	likeIconSvg,
	metaHtml,
	normalizeDisplay,
	renderVideoPreviewHtml,
	schemeClass,
} = await import("../src/videos/render.ts");

const UID = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-10-06T12:00:00Z");

// ── Show/hide inheritance ────────────────────────────────────────

test("block show/hide: Show and Hide win, empty follows the site, older booleans count unless the site follows its defaults", () => {
	assert.equal(resolveShow("show", false, false), true);
	assert.equal(resolveShow("hide", true, true), false);
	assert.equal(resolveShow("", true, false), true);
	assert.equal(resolveShow(undefined, false, false), false);
	assert.equal(resolveShow(false, true, false), false, "an older toggle's false still hides");
	assert.equal(resolveShow(true, false, false), true);
	assert.equal(resolveShow(false, true, true), true, "follow site defaults ignores older booleans");
	assert.equal(resolveShow("nonsense", true, false), true);
});

test("playerConfig: new blocks follow the site defaults (all on, like Video Manager)", () => {
	const cfg = playerConfig({ uid: UID });
	assert.deepEqual(
		[cfg.showName, cfg.showDescription, cfg.showPlays, cfg.showLikes, cfg.showLikeCount, cfg.showDate],
		[true, true, true, true, true, true],
	);
	const off = { ...SHOW_DEFAULTS, showPlays: false, showLikeCount: false };
	const site = playerConfig({ uid: UID }, off);
	assert.deepEqual([site.showPlays, site.showLikeCount, site.showLikes], [false, false, true]);
	assert.equal(playerConfig({ uid: UID, showPlays: "show" }, off).showPlays, true, "a block's Show overrides the site");
});

test("playerConfig: blocks saved with the old toggles render as before", () => {
	const old = { uid: UID, showName: false, showDescription: false, showPlays: true, showLikes: true, showDate: true };
	const cfg = playerConfig(old);
	assert.deepEqual([cfg.showName, cfg.showDescription, cfg.showPlays, cfg.showLikes, cfg.showDate], [false, false, true, true, true]);
	const followed = playerConfig(old, { ...SHOW_DEFAULTS, followSiteDefaults: true });
	assert.deepEqual([followed.showName, followed.showDescription], [true, true]);
});

test("playerConfig: the GIF preset still shows nothing under the video", () => {
	const gif = playerConfig({ preset: "gif", showPlays: "show", showName: true });
	assert.deepEqual([gif.showName, gif.showPlays, gif.showLikes, gif.showLikeCount, gif.showDate], [false, false, false, false, false]);
});

// ── Settings ─────────────────────────────────────────────────────

test("normalizeDisplay: defaults for missing or invalid values, clamped ranges", () => {
	assert.deepEqual(normalizeDisplay(null), DISPLAY_DEFAULTS);
	assert.deepEqual(normalizeDisplay({ nonsense: 1 }), DISPLAY_DEFAULTS);
	const d = normalizeDisplay({ radius: 99, borderWidth: -3, titleSize: 9, metaSize: "big", likeIcon: "rocket", scheme: "dark", titleColor: "red", likeBg: "#FFF", titleWeight: "650", descWeight: "300" });
	assert.equal(d.radius, 48);
	assert.equal(d.borderWidth, 0);
	assert.equal(d.titleSize, 4);
	assert.equal(d.metaSize, DISPLAY_DEFAULTS.metaSize);
	assert.equal(d.likeIcon, "heart");
	assert.equal(d.scheme, "dark");
	assert.equal(d.titleColor, "", "not a hex color");
	assert.equal(d.likeBg, "#FFF");
	assert.equal(d.titleWeight, "");
	assert.equal(d.descWeight, "300");
});

test("displayVars: nothing for the defaults, so sites look as they did", () => {
	assert.deepEqual(displayVars(DISPLAY_DEFAULTS), []);
	assert.deepEqual(displayVars(DISPLAY_DEFAULTS, "not-a-color"), []);
	assert.equal(schemeClass("auto"), "");
	assert.equal(schemeClass("dark"), "cw-video--dark");
});

test("displayVars: one custom property per changed setting", () => {
	const d = normalizeDisplay({
		radius: 0,
		border: true,
		borderWidth: 2,
		borderColor: "#123456",
		titleColor: "#111111",
		titleSize: 1.2,
		titleWeight: "600",
		align: "center",
		metaAlign: "right",
		metaColor: "#606060",
		metaSize: 0.9,
		likeColor: "#0f0f0f",
		likeBg: "#f2f2f2",
		likeActiveColor: "#ffffff",
		likeActiveBg: "#cc0000",
	});
	assert.deepEqual(displayVars(d, "#000000"), [
		"--cw-video-bg:#000000",
		"--cw-video-radius:0px",
		"--cw-video-border:2px solid #123456",
		"--cw-video-title-color:#111111",
		"--cw-video-title-size:1.2em",
		"--cw-video-title-weight:600",
		"--cw-video-align:center",
		"--cw-video-meta-justify:flex-end",
		"--cw-video-muted:#606060",
		"--cw-video-meta-size:0.9em",
		"--cw-video-like-color:#0f0f0f",
		"--cw-video-like-bg:#f2f2f2",
		"--cw-video-like-active:#ffffff",
		"--cw-video-like-active-bg:#cc0000",
	]);
});

test("CSS: defaults match the block's earlier look; like pop respects reduced motion", () => {
	assert.match(VIDEO_CSS, /border-radius:var\(--cw-video-radius,0\.5rem\)/);
	assert.match(VIDEO_CSS, /font-size:var\(--cw-video-meta-size,0\.875em\)/);
	assert.match(VIDEO_CSS, /font-size:var\(--cw-video-title-size,0\.95em\)/);
	assert.match(VIDEO_CSS, /@media \(prefers-reduced-motion:reduce\)\{[^}]*\[data-pop\] svg\{animation:none\}/);
	assert.match(VIDEO_CSS, /:not\(\[data-held\]\):hover/);
});

// ── Icons and markup ─────────────────────────────────────────────

test("like icons are Video Manager's SVG paths", () => {
	assert.deepEqual(Object.keys(LIKE_ICON_PATHS), ["heart", "thumbs", "star"]);
	assert.match(likeIconSvg("heart"), /<path d="M19 14c1\.49-1\.46 3-3\.21 3-5\.5A5\.5/);
	const thumbs = likeIconSvg("thumbs");
	assert.equal(thumbs.match(/<path /g).length, 2);
	assert.match(thumbs, /<path d="M7 10v12" \/><path d="M15 5\.88 14 10h5\.83/);
	assert.match(likeIconSvg("star"), /<path d="M11\.525 2\.295a\.53\.53/);
	assert.match(likeIconSvg("heart"), /^<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/);
	assert.equal(likeIconSvg("bogus"), likeIconSvg("heart"));
});

test("captionHtml: name and description, escaped", () => {
	assert.equal(captionHtml("Video", "", { name: true, description: true }), "", "the placeholder name alone isn't a caption");
	assert.equal(
		captionHtml("A <b>", "Desc & more", { name: true, description: true }),
		'<figcaption class="cw-video__caption"><strong class="cw-video__name">A &lt;b&gt;</strong> — <span class="cw-video__desc">Desc &amp; more</span></figcaption>',
	);
	assert.equal(captionHtml("Name", "Desc", { name: false, description: true }), '<figcaption class="cw-video__caption"><span class="cw-video__desc">Desc</span></figcaption>');
});

test("metaHtml: like button with the chosen icon and count, views, date and length", () => {
	const base = { uid: UID, likes: 3, showLikeCount: true, likeIcon: "star", plays: 1, date: "2026-03-07T00:00:00Z", dateStyle: "absolute", now: NOW };
	const html = metaHtml(base);
	assert.match(html, new RegExp(`^<div class="cw-video__meta"><button type="button" class="cw-video__like" data-cw-like="${UID}" aria-pressed="false"><svg`));
	assert.ok(html.includes(LIKE_ICON_PATHS.star[0]));
	assert.match(html, /<span class="cw-video__likes" data-cw-likes>3<\/span><\/button>/);
	assert.match(html, /<span class="cw-video__plays" data-cw-plays>1 view<\/span>/);
	assert.match(html, /<time class="cw-video__date" datetime="2026-03-07T00:00:00Z">Mar 7, 2026<\/time><\/div>$/);
	assert.doesNotMatch(html, /cw-video__len/, "no length badge");
	assert.doesNotMatch(metaHtml({ ...base, showLikeCount: false }), /cw-video__likes/, "count hidden");
	assert.match(metaHtml({ ...base, dateStyle: "relative" }), /datetime="2026-03-07T00:00:00Z" data-cw-relative>7 months ago<\/time>/);
	assert.equal(metaHtml({ ...base, likes: null, plays: null, date: null }), "");
	assert.match(metaHtml({ ...base, liked: true }), /aria-pressed="true"/);
});

// ── Dates ────────────────────────────────────────────────────────

test("date styles: absolute and Video Manager's time ago", () => {
	assert.equal(videoDateText("2026-10-06T00:00:00Z", "absolute", NOW), "Oct 6, 2026");
	assert.equal(videoDateText("nope", "absolute", NOW), "");
	assert.equal(videoDateText(null, "relative", NOW), "");
	assert.equal(relativeDate("2026-10-06T11:59:30Z", NOW), "just now");
	assert.equal(relativeDate("2026-10-06T11:58:00Z", NOW), "2 minutes ago");
	assert.equal(relativeDate("2026-10-06T11:00:00Z", NOW), "1 hour ago");
	assert.equal(relativeDate("2026-10-03T12:00:00Z", NOW), "3 days ago");
	assert.equal(relativeDate("2026-09-20T12:00:00Z", NOW), "2 weeks ago");
	assert.equal(relativeDate("2026-03-07T12:00:00Z", NOW), "7 months ago");
	assert.equal(relativeDate("2024-10-01T12:00:00Z", NOW), "2 years ago");
	assert.equal(relativeDate("2026-12-01T00:00:00Z", NOW), "just now", "future dates");
});

// ── Preview ──────────────────────────────────────────────────────

test("settings preview: every part, the clicked state, and the draft's settings", () => {
	const html = renderVideoPreviewHtml(DISPLAY_DEFAULTS, null, NOW);
	assert.match(html, /^<div class="cw-video-stage"><figure class="cw-video" style="--cw-video-ratio:16 \/ 9">/);
	assert.match(html, /cw-video__frame cw-video__frame--checker/, "checkerboard while the background is transparent");
	assert.match(html, /<strong class="cw-video__name">Your video name<\/strong> — <span class="cw-video__desc">A short video description\.<\/span>/);
	assert.match(html, /data-cw-likes>175</);
	assert.match(html, />23 views</);
	assert.match(html, />Mar 7, 2026<\/time><\/div>/);
	assert.doesNotMatch(html, /cw-video__len|4:05/);
	assert.match(html, /After clicking like:.*aria-pressed="true"/);

	const dark = renderVideoPreviewHtml(normalizeDisplay({ scheme: "dark", likeIcon: "thumbs", dateStyle: "relative", showPlays: false, showName: false, radius: 16 }), "#000000", NOW);
	assert.match(dark, /^<div class="cw-video-stage cw-video-stage--dark"><figure class="cw-video cw-video--dark" style="--cw-video-ratio:16 \/ 9;--cw-video-bg:#000000;--cw-video-radius:16px">/);
	assert.doesNotMatch(dark, /checker/);
	assert.doesNotMatch(dark, /views|cw-video__name/);
	assert.match(dark, />7 months ago</);
	assert.ok(dark.includes(LIKE_ICON_PATHS.thumbs[1]));

	const noLikes = renderVideoPreviewHtml(normalizeDisplay({ showLikes: false }), null, NOW);
	assert.doesNotMatch(noLikes, /cw-video__like|After clicking/);
});

// ── Tags ─────────────────────────────────────────────────────────

test("parseTags: Video Manager's tag rules", () => {
	assert.deepEqual(parseTags("#Tutorial, product launch\nTUTORIAL, a/b, ..x.., "), ["Tutorial", "product-launch", "ab", "x"]);
	assert.deepEqual(parseTags(["one", "#two"]), ["one", "two"]);
	assert.deepEqual(parseTags(null), []);
	assert.equal(parseTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 25);
	assert.equal(parseTags("x".repeat(80))[0].length, 50);
});
