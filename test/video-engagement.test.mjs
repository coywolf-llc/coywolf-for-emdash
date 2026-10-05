// Run: node --test test/video-engagement.test.mjs
import "./ts-resolve.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

const { ENGAGEMENT_LIMITS, EngagementLimiter, hasEngagementHeader, likeAction, likesByKey, staleLikesByKey } = await import("../src/videos/engagement.ts");

test("likes need the X-Coywolf-Video header", () => {
	assert.equal(hasEngagementHeader(new Headers({ "X-Coywolf-Video": "1" })), true);
	assert.equal(hasEngagementHeader(new Headers()), false);
	assert.equal(hasEngagementHeader(new Headers({ "X-Coywolf-Video": "yes" })), false);
});

test("plays and likes are rate limited per address per minute", () => {
	const limiter = new EngagementLimiter();
	const now = Date.UTC(2026, 9, 5, 12, 0, 0);
	for (let i = 0; i < ENGAGEMENT_LIMITS.playsPerMinute; i++) assert.ok(limiter.play("a", now));
	assert.equal(limiter.play("a", now), false);
	assert.ok(limiter.play("b", now), "other addresses aren't affected");
	assert.ok(limiter.play("a", now + 60_000), "a new minute");
	for (let i = 0; i < ENGAGEMENT_LIMITS.likesPerMinute; i++) assert.ok(limiter.like("a", now));
	assert.equal(limiter.like("a", now), false);
});

test("new likes are capped per address per day", () => {
	const limiter = new EngagementLimiter();
	const now = Date.UTC(2026, 9, 5, 1, 0, 0);
	for (let i = 0; i < ENGAGEMENT_LIMITS.likesPerDay; i++) assert.ok(limiter.newLike("a", now + i * 60_000));
	assert.equal(limiter.newLike("a", now + 12 * 3_600_000), false);
	assert.ok(limiter.newLike("a", Date.UTC(2026, 9, 6, 0, 0, 1)), "the next (UTC) day");
});

test("a like request with the wanted state doesn't undo someone else's like", () => {
	assert.equal(likeAction(true, true), "keep");
	assert.equal(likeAction(true, false), "add");
	assert.equal(likeAction(false, true), "remove");
	assert.equal(likeAction(false, false), "keep");
	assert.equal(likeAction(undefined, true), "remove", "toggles without a state");
	assert.equal(likeAction(undefined, false), "add");
});

test("daily like counts are pruned by day", () => {
	const key = likesByKey("2026-10-01", "abc");
	assert.equal(staleLikesByKey(key, "2026-10-03"), true);
	assert.equal(staleLikesByKey(likesByKey("2026-10-03", "abc"), "2026-10-03"), false);
	assert.equal(staleLikesByKey("state:videos:likesBy:junk", "2026-10-03"), false);
});
