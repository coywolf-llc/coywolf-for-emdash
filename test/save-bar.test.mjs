// Run: node --test test/save-bar.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { isDirty, stableStringify } = await import("../src/admin/dirty.ts");

test("nothing saved yet is never dirty", () => {
	assert.equal(isDirty({ a: 1 }, undefined), false);
	assert.equal(isDirty({ a: 1 }, null), false);
});

test("equal drafts are clean regardless of key order", () => {
	assert.equal(isDirty({ a: 1, b: { c: "x", d: [1, 2] } }, { b: { d: [1, 2], c: "x" }, a: 1 }), false);
	assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test("any changed value, added key, or reordered array is dirty", () => {
	assert.equal(isDirty({ a: 1 }, { a: 2 }), true);
	assert.equal(isDirty({ a: 1, b: "" }, { a: 1 }), true);
	assert.equal(isDirty({ list: [2, 1] }, { list: [1, 2] }), true);
	assert.equal(isDirty({ secret: "typed" }, { secret: "" }), true);
});

test("type differences count (a typed \"5\" is not the number 5)", () => {
	assert.equal(isDirty({ n: "5" }, { n: 5 }), true);
});
