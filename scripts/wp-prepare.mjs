#!/usr/bin/env node
// Prepare a WordPress export (WXR) for EmDash's importer: the same as
// "Prepare the WordPress export" on the pack's WordPress import page.
//
//   node scripts/wp-prepare.mjs export.xml export-prepared.xml
//
// Prints what changed per block type. Reads and writes local files only.
import { readFile, writeFile } from "node:fs/promises";

import "../test/ts-resolve.mjs";

const { prepareWxr } = await import("../src/wpImport/prepare.ts");

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error("Usage: node scripts/wp-prepare.mjs <export.xml> <prepared.xml>");
	process.exit(1);
}
const xml = await readFile(input, "utf8");
const result = prepareWxr(xml);
await writeFile(output, result.xml);
console.log(`${result.posts.length} entries changed.`);
for (const [key, count] of Object.entries(result.counts).sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)}  ${key}`);
