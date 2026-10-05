#!/usr/bin/env node
// Prepare a WordPress export (WXR) for EmDash's importer: the same as
// "Prepare the WordPress export" on the pack's WordPress import page.
//
//   node scripts/wp-prepare.mjs export.xml export-prepared.xml [options]
//
// Options:
//   --disclosure-block=<name>   a self-closing block that printed an affiliate
//                               disclosure (repeatable), e.g.
//                               --disclosure-block=genesis-custom-blocks/disclosure
//   --redirects=<file.json>     also write redirects for old slugs (_wp_old_slug)
//                               in the Redirects module's import format
//
// Prints what changed per block type. Reads and writes local files only.
import { readFile, writeFile } from "node:fs/promises";

import "../test/ts-resolve.mjs";

const { prepareWxr } = await import("../src/wpImport/prepare.ts");
const { optionSnippet, parentsMap, termParentsSnippet } = await import("../src/wpImport/parents.ts");
const { postCredits } = await import("../src/wpImport/guests.ts");
const { wxrOldSlugRules } = await import("../src/wpImport/redirects.ts");
const { wxrSite } = await import("../src/wpImport/urls.ts");

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const option = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const [input, output] = files;
if (!input || !output) {
	console.error("Usage: node scripts/wp-prepare.mjs <export.xml> <prepared.xml> [--disclosure-block=<name>] [--redirects=<file.json>]");
	process.exit(1);
}
const xml = await readFile(input, "utf8");
const result = prepareWxr(xml, { disclosureBlocks: option("disclosure-block") });
await writeFile(output, result.xml);
const site = wxrSite(xml);
console.log(`Old site: ${site.homeUrl || site.siteUrl || "(unknown)"}${site.hosts.length ? ` (hosts: ${site.hosts.join(", ")})` : ""}`);
console.log(`${result.posts.length} entries changed.`);
const dropped = Object.entries(result.counts).filter(([k]) => /→ (dropped|missing)$/.test(k));
for (const [key, count] of Object.entries(result.counts).filter(([k]) => !/→ (dropped|missing)$/.test(k)).sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)}  ${key}`);
if (dropped.length) {
	console.log("\nBlocks EmDash's importer will drop (rebuild them after importing):");
	for (const [key, count] of dropped.sort((a, b) => b[1] - a[1])) console.log(`${String(count).padStart(6)}  ${key}`);
}
const credits = postCredits(result.guestAuthors);
if (credits.length) {
	console.log(`\n${credits.length} ${credits.length === 1 ? "post has" : "posts have"} co-authors or guest authors (credit them on the WordPress import page, step "Co-authors and guest authors"):`);
	for (const c of credits) console.log(`  ${c.names.join(", ")}: ${c.title || c.slug}`);
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
const oldSlugs = wxrOldSlugRules(xml);
const [redirectsFile] = option("redirects");
if (redirectsFile) {
	await writeFile(redirectsFile, `${JSON.stringify(oldSlugs.rules, null, "\t")}\n`);
	console.log(`\nWrote ${oldSlugs.rules.length} old-slug redirects to ${redirectsFile} (Redirects → Import → Choose file).${oldSlugs.skipped.length ? ` Skipped ${oldSlugs.skipped.length}: an entry uses that URL now.` : ""}`);
} else if (oldSlugs.rules.length) {
	console.log(`\n${oldSlugs.rules.length} old-slug redirects are in the export: add --redirects=old-slugs.json to write them, or use step "Redirects from WordPress".`);
}
