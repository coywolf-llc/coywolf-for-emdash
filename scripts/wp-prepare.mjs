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
const { optionSnippet, parentsMap, termParentsSnippet } = await import("../src/wpImport/parents.ts");

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
if (result.guestAuthors.length) {
	console.log(`\n${result.guestAuthors.length} ${result.guestAuthors.length === 1 ? "post has a guest author" : "posts have guest authors"} (credit them on the WordPress import page, step "Guest author bylines"):`);
	for (const g of result.guestAuthors) console.log(`  ${g.name}: ${g.title || g.slug}`);
}
const categoryParents = parentsMap(result.categories);
if (Object.keys(categoryParents).length) {
	console.log(`\n${Object.keys(categoryParents).length} ${Object.keys(categoryParents).length === 1 ? "category has" : "categories have"} a parent. EmDash's importer drops category parents: restore them on the WordPress import page, step "Category and page parents". Until then, this coywolfPlugin() option keeps {termpath:category} URLs right:`);
	console.log(termParentsSnippet("category", categoryParents));
}
const pageParents = parentsMap(result.pages);
if (Object.keys(pageParents).length) {
	console.log(`\n${Object.keys(pageParents).length} ${Object.keys(pageParents).length === 1 ? "page has" : "pages have"} a parent page. EmDash entries have no parent, so add this to coywolfPlugin() and use {pagepath} in the pages URL pattern:`);
	console.log(optionSnippet("pageParents", pageParents));
}
