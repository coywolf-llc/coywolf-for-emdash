// Run: node --test test/admin-classes.test.mjs
//
// The admin pages render inside EmDash's admin, whose stylesheet is a precompiled
// Tailwind build: a utility it doesn't already contain is silently ignored. This
// checks every class in src/admin/**/*.tsx className attributes exists either in
// EmDash's admin stylesheet or in the pack's own admin CSS (src/admin/admin-css.ts).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./ts-resolve.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminDir = join(root, "src/admin");

function emdashAdminCss() {
	try {
		const require = createRequire(join(root, "package.json"));
		// A dependency of emdash (a devDependency here), exported as "./styles.css".
		return readFileSync(require.resolve("@emdash-cms/admin/styles.css", { paths: [root, join(root, "node_modules/emdash")] }), "utf8");
	} catch {
		return null;
	}
}

/** Every class name a stylesheet defines, with CSS escapes undone (`md\:flex` -> `md:flex`). */
export function cssClassNames(css) {
	const names = new Set();
	for (const match of css.matchAll(/\.((?:\\[0-9a-f]{1,6} ?|\\.|[\w-])+)/gi)) {
		names.add(match[1].replace(/\\([0-9a-f]{1,6}) ?|\\(.)/gi, (_, hex, ch) => (hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ch)));
	}
	return names;
}

/** Index just past the expression starting at `start` (an opening `{`), skipping strings. */
function skipBraces(src, start) {
	let depth = 0;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"' || ch === "'") {
			i = src.indexOf(ch, i + 1);
		} else if (ch === "`") {
			i = skipTemplate(src, i);
		} else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i + 1;
	}
	return src.length;
}

function skipTemplate(src, start) {
	for (let i = start + 1; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === "`") return i;
		else if (src[i] === "$" && src[i + 1] === "{") i = skipBraces(src, i + 1) - 1;
	}
	return src.length;
}

/** String-literal text in a className expression: static strings and template static parts. Comparison operands (`x === "none"`) are skipped. */
function expressionStrings(expr) {
	const out = [];
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i];
		if (ch === '"' || ch === "'") {
			const end = expr.indexOf(ch, i + 1);
			if (!/[=!]==?\s*$/.test(expr.slice(0, i))) out.push(expr.slice(i + 1, end));
			i = end;
		} else if (ch === "`") {
			let text = "";
			let j = i + 1;
			for (; j < expr.length && expr[j] !== "`"; j++) {
				if (expr[j] === "$" && expr[j + 1] === "{") {
					const close = skipBraces(expr, j + 1);
					out.push(...expressionStrings(expr.slice(j + 2, close - 1)));
					text += " ";
					j = close - 1;
				} else text += expr[j];
			}
			out.push(text);
			i = j;
		}
	}
	return out;
}

/** Class names used in className attributes, with the file they appear in. */
export function adminClassNames(files) {
	const found = new Map();
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		for (const match of src.matchAll(/className=/g)) {
			const start = match.index + match[0].length;
			let strings;
			if (src[start] === '"') strings = [src.slice(start + 1, src.indexOf('"', start + 1))];
			else if (src[start] === "{") strings = expressionStrings(src.slice(start + 1, skipBraces(src, start) - 1));
			else continue;
			for (const cls of strings.join(" ").split(/\s+/).filter(Boolean)) {
				if (!found.has(cls)) found.set(cls, new Set());
				found.get(cls).add(relative(root, file));
			}
		}
	}
	return found;
}

function tsxFiles(dir) {
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
		.map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

const emdashCss = emdashAdminCss();

test("the extractor reads static strings, conditionals, and template literal static parts", () => {
	const expr = (s) => expressionStrings(s).join(" ").split(/\s+/).filter(Boolean);
	assert.deepEqual(expr('`text-xs ${on ? "font-bold" : ""} m-1`'), ["font-bold", "text-xs", "m-1"]);
	assert.deepEqual(expr('x === "none" ? "gap-2" : undefined'), ["gap-2"]);
	assert.deepEqual([...cssClassNames(".md\\:flex{display:flex}:where(.space-y-8>:not(:last-child)){}.w-1\\/2{}.\\32 xl\\:grid-cols-6{}")], ["md:flex", "space-y-8", "w-1/2", "2xl:grid-cols-6"]);
});

test("every admin className exists in EmDash's admin CSS or the pack's admin CSS", { skip: emdashCss ? false : "@emdash-cms/admin/dist/styles.css not installed (run npm install); skipping the admin class check" }, async () => {
	const packCss = Object.values(await import("../src/admin/admin-css.ts")).filter((value) => typeof value === "string");
	const known = new Set([...cssClassNames(emdashCss), ...packCss.flatMap((css) => [...cssClassNames(css)])]);
	const used = adminClassNames(tsxFiles(adminDir));
	assert.ok(used.size > 100, `expected to find admin classes, found ${used.size}`);
	const missing = [...used].filter(([cls]) => !known.has(cls)).map(([cls, files]) => `${cls} (${[...files].join(", ")})`);
	assert.deepEqual(missing, [], `Classes not in EmDash's admin CSS or src/admin/admin-css.ts:\n  ${missing.join("\n  ")}`);
});
