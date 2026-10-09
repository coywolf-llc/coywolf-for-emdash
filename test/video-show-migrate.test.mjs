// The pure parts of scripts/video-show-migrate.mjs: planning an entry's rewrite, and putting updated_at back.
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { countVideoBlocks, d1Changes, hasPendingDraft, isIsoInstant, planEntry, planRestore, restoreUpdatedAtSql } = await import("../scripts/video-show-migrate-lib.mjs");

const UID = "5b7349bd06767b1ba66bf2ce566d1440";
const video = (extra) => ({ _type: "coywolf-video", uid: UID, ...extra });
const entry = (extra) => ({
	id: "e1",
	slug: "hello",
	status: "published",
	liveRevisionId: null,
	draftRevisionId: null,
	updatedAt: "2026-10-04T23:06:41.935Z",
	data: { title: "Hello", content: [{ _type: "block", children: [] }, video({ showName: false })] },
	...extra,
});

test("countVideoBlocks counts every video block, at any depth, whatever the key order", () => {
	const content = [video({}), { _type: "columns", columns: [{ content: [{ uid: UID, _type: "coywolf-video" }] }] }, { _type: "block" }];
	assert.equal(countVideoBlocks(content), 2);
	assert.equal(countVideoBlocks(null), 0);
	assert.equal(countVideoBlocks({ content, excerpt: [video({})] }), 3);
});

test("planEntry: what to do with an entry", () => {
	const e = entry();
	const published = planEntry(e, false);
	assert.deepEqual([published.action, published.blocks, published.videos, published.pendingDraft, Object.keys(published.changes)], ["publish", 1, 1, false, ["content"]]);
	assert.equal(published.changes.content[1].showName, "hide");
	assert.equal(published.changes.content[0], e.data.content[0], "other blocks pass through as they are");
	assert.equal(e.data.content[1].showName, false, "the input is not changed");

	const pending = planEntry(entry({ liveRevisionId: "r1", draftRevisionId: "r2" }), false);
	assert.deepEqual([pending.action, pending.pendingDraft], ["skip", true]);
	assert.equal(planEntry(entry({ liveRevisionId: "r1", draftRevisionId: "r1" }), false).action, "publish", "a draft pointer equal to the live one is no pending draft");
	assert.equal(planEntry(entry({ status: "draft" }), false).action, "draft");
	assert.equal(planEntry(entry({ status: "scheduled" }), false).action, "draft");

	const clean = planEntry(entry({ data: { content: [video({ showName: "hide" })] } }), false);
	assert.deepEqual([clean.action, clean.blocks, clean.videos, clean.changes], ["none", 0, 1, {}]);
	// With the site following its defaults the boolean is removed, which still counts as a change.
	assert.equal(planEntry(entry(), true).changes.content[1].showName, undefined);
	assert.equal(planEntry({ status: "published", data: null }, false).action, "none");
});

test("hasPendingDraft / isIsoInstant", () => {
	assert.equal(hasPendingDraft({ draftRevisionId: "a", liveRevisionId: null }), true);
	assert.equal(hasPendingDraft({ draftRevisionId: "a", liveRevisionId: "a" }), false);
	assert.equal(hasPendingDraft({}), false);
	assert.equal(isIsoInstant("2026-10-04T23:06:41.935Z"), true);
	assert.equal(isIsoInstant("2026-10-04T23:06:41Z"), true);
	assert.equal(isIsoInstant("2026-10-04 23:06:41"), false);
	assert.equal(isIsoInstant("2026-13-04T23:06:41.935Z"), false, "not a date");
	assert.equal(isIsoInstant("' OR 1=1 --"), false);
	assert.equal(isIsoInstant(1), false);
});

test("restoreUpdatedAtSql guards on the migration's value and refuses anything unexpected", () => {
	const sql = restoreUpdatedAtSql({ collection: "posts", id: "abc_123-X", from: "2026-10-09T13:00:00.000Z", to: "2026-10-04T23:06:41.935Z" });
	assert.equal(sql, "UPDATE ec_posts SET updated_at = '2026-10-04T23:06:41.935Z' WHERE id = 'abc_123-X' AND updated_at = '2026-10-09T13:00:00.000Z';");
	const ok = { collection: "posts", id: "e1", from: "2026-10-09T13:00:00.000Z", to: "2026-10-04T23:06:41.935Z" };
	assert.throws(() => restoreUpdatedAtSql({ ...ok, collection: "posts; DROP TABLE x" }), /collection/);
	assert.throws(() => restoreUpdatedAtSql({ ...ok, collection: "ec_posts'" }), /collection/);
	assert.throws(() => restoreUpdatedAtSql({ ...ok, id: "e1' OR '1'='1" }), /entry id/);
	assert.throws(() => restoreUpdatedAtSql({ ...ok, to: "2026-10-04T23:06:41.935Z'; --" }), /timestamp/);
	assert.throws(() => restoreUpdatedAtSql({ ...ok, from: undefined }), /timestamp/);
});

test("planRestore puts a date back only when the entry is as the migration left it", () => {
	const original = "2026-10-04T23:06:41.935Z";
	const migrated = "2026-10-09T13:00:00.000Z";
	const normalized = { ...entry({ updatedAt: migrated }), data: { content: [video({ showName: "hide" })] } };
	const backup = { item: entry(), _rev: "x", after: { updatedAt: migrated, version: 3 } };

	assert.deepEqual(planRestore(backup, normalized, false), { action: "restore", from: migrated, to: original });
	assert.equal(planRestore(backup, { ...normalized, updatedAt: "2026-10-10T08:00:00.000Z" }, false).reason, "edited since the migration");
	assert.equal(planRestore(backup, { ...normalized, updatedAt: original }, false).reason, "already at its original date");
	assert.equal(planRestore({ item: entry(), _rev: "x" }, normalized, false).reason, "the migration didn't save this entry");
	assert.equal(planRestore(backup, null, false).reason, "the entry no longer exists");
	assert.equal(planRestore(backup, { ...normalized, draftRevisionId: "d9", liveRevisionId: "l1" }, false).reason, "has a pending draft");
	assert.equal(planRestore(backup, entry({ updatedAt: migrated }), false).reason, "still has true/false choices");
	assert.equal(planRestore({ item: { ...entry(), updatedAt: "yesterday" }, after: backup.after }, normalized, false).reason, "the backup has no original date");
	// Drafts: the save didn't touch updated_at, so there's nothing to put back.
	assert.equal(planRestore({ item: entry({ status: "draft" }), after: { updatedAt: original } }, { ...normalized, status: "draft", updatedAt: original }, false).reason, "already at its original date");
});

test("d1Changes reads the changed-row counts from wrangler's JSON output", () => {
	const output = [
		{ results: [], success: true, meta: { changes: 1, duration: 0.2 } },
		{ results: [], success: true, meta: { changes: 0 } },
		{ results: [], success: false, meta: { changes: 1 } },
		{ results: [] },
	];
	assert.deepEqual(d1Changes(output), [1, 0, null, null]);
	assert.deepEqual(d1Changes("not json"), []);
});
