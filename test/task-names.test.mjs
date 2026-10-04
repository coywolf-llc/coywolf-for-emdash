// Every scheduled task name must pass EmDash's validateTaskName rule, or
// cron.schedule() throws (it broke the Features page in 0.4.0).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const RULE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function files(dir) {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
	});
}

test("task names follow EmDash's rule", () => {
	const names = [];
	for (const file of files("src")) {
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/(?:_TASK|TASK_\w*)\s*=\s*"([^"]+)"/g)) names.push(m[1]);
		for (const m of src.matchAll(/TASKS\s*=\s*\{([^}]*)\}/g)) for (const v of m[1].matchAll(/"([^"]+)"/g)) names.push(v[1]);
	}
	assert.ok(names.length >= 8, `found ${names.length} task names`);
	for (const name of names) assert.match(name, RULE, name);
});
