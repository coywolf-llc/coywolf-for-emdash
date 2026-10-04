// Run: node --test test/export.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import "./ts-resolve.mjs";

const { csvRecords, guardCell, parseCsv, toCsv, unguardCell } = await import("../src/core/csv.ts");
const { REDIRECT_CSV_COLUMNS, parseRedirectsImport, redirectsToCsv, redirectsToJson } = await import("../src/redirects/transfer.ts");
const { validate } = await import("../src/redirects/rules.ts");
const { exportRobotsRules, readRobotsImport } = await import("../src/robots/transfer.ts");
const { DEFAULT_CONFIG, normalizeConfig } = await import("../src/robots/rules.ts");
const { linksToCsv } = await import("../src/links/export.ts");
const { filesToCsv } = await import("../src/files/export.ts");
const { entitiesToCsv } = await import("../src/ai/export.ts");
const { DOWNLOAD_PATH, configureBackupDownloads, createDownloadLink, downloadFilename, serveBackupDownload } = await import("../src/backups/download.ts");

// ── CSV ──────────────────────────────────────────────────────────

test("toCsv quotes commas, quotes, line breaks and edge spaces", () => {
	assert.equal(toCsv([["a", "b,c", 'say "hi"', "two\nlines", " pad", 3, true, null]]), 'a,"b,c","say ""hi""","two\nlines"," pad",3,1,\r\n');
});

test("parseCsv reads what toCsv writes", () => {
	const rows = [
		["plain", "with, comma", 'quote " inside', "line\r\nbreak", "", "  spaced  "],
		["=SUM(A1)", "'apostrophe", "unicode ✓ café", "tab\there", "\"", ","],
	];
	assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("parseCsv handles a BOM, LF line ends, tabs and blank lines", () => {
	assert.deepEqual(parseCsv("﻿a,b\n\nc,d\n"), [
		["a", "b"],
		["c", "d"],
	]);
	assert.deepEqual(parseCsv("a\tb\nc\td"), [
		["a", "b"],
		["c", "d"],
	]);
	assert.deepEqual(parseCsv('x,"unterminated'), [["x", "unterminated"]]);
});

test("csvRecords keys rows by the lowercased header", () => {
	assert.deepEqual(csvRecords("Source,Target\n/a,/b\n/c"), [
		{ source: "/a", target: "/b" },
		{ source: "/c", target: "" },
	]);
});

test("guardCell neutralizes formulas and unguardCell undoes it exactly", () => {
	for (const [raw, guarded] of [
		["=1+1", "'=1+1"],
		["+44 20", "'+44 20"],
		["-5", "'-5"],
		["@cmd", "'@cmd"],
		["\tx", "'\tx"],
		["'=x", "''=x"],
		["''=x", "'''=x"],
		["'plain", "'plain"],
		["plain", "plain"],
		["", ""],
		["/path", "/path"],
	]) {
		assert.equal(guardCell(raw), guarded, raw);
		assert.equal(unguardCell(guardCell(raw)), raw, raw);
	}
	// Values that were never guarded pass through unguardCell untouched.
	for (const v of ["'plain", "plain", "/a", "^/x", "it's"]) assert.equal(unguardCell(v), v);
});

test("toCsv with guard leaves numbers alone", () => {
	assert.equal(toCsv([[-1, "-1"]], { guard: true }), "-1,'-1\r\n");
});

// ── Redirects ────────────────────────────────────────────────────

const rule = (patch) => ({
	id: "x",
	source: "/old",
	target: "/new",
	type: 301,
	isRegex: false,
	enabled: true,
	hits: 0,
	lastHit: null,
	note: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-02T00:00:00.000Z",
	...patch,
});

const RULES = [
	rule({ source: "/visit/partner", target: "https://example.com/?a=1&b=2", hits: 42, lastHit: "2026-03-01T00:00:00.000Z", note: "Affiliate, \"main\" link" }),
	rule({ source: "^/blog/(\\d{4}),(\\d{2})/(.*)$", target: "/posts/$3", isRegex: true, type: 308, note: "=HYPERLINK(\"evil\")" }),
	rule({ source: "/gone", target: "", type: 410, enabled: false, note: "line one\nline two" }),
	rule({ source: "/plus", target: "/p", note: "'=kept apostrophe" }),
];

const asInput = (r) => ({ source: r.source, target: r.target, type: r.type, isRegex: r.isRegex, enabled: r.enabled, note: r.note });

test("redirect CSV export imports back to the same rules", () => {
	const csv = redirectsToCsv(RULES);
	assert.equal(csv.split("\r\n")[0], REDIRECT_CSV_COLUMNS.join(","));
	// The formula-looking note is guarded in the file…
	assert.ok(csv.includes(`"'=HYPERLINK(""evil"")"`));
	// …and comes back exactly.
	assert.deepEqual(parseRedirectsImport(csv), RULES.map(asInput));
	for (const r of parseRedirectsImport(csv)) validate(r);
});

test("redirect JSON export imports back to the same rules", () => {
	assert.deepEqual(parseRedirectsImport(redirectsToJson(RULES)), RULES.map(asInput));
	assert.deepEqual(parseRedirectsImport(JSON.stringify({ redirects: [{ source: "/a", target: "/b" }] })), [{ source: "/a", target: "/b", type: 301, isRegex: false }]);
});

test("redirect import keeps the older formats working", () => {
	// Header-less comma and tab rows (a Coywolf SEO export from WordPress).
	assert.deepEqual(parseRedirectsImport("/a, /b, 302, 0\n/c,/d"), [
		{ source: "/a", target: "/b", type: 302, isRegex: false },
		{ source: "/c", target: "/d", type: 301, isRegex: false },
	]);
	assert.deepEqual(parseRedirectsImport("^/x/(.{1,3})\t/y/$1\t301\ttrue"), [{ source: "^/x/(.{1,3})", target: "/y/$1", type: 301, isRegex: true }]);
	// A header in any order, with only some columns.
	assert.deepEqual(parseRedirectsImport("target,source\n/b,/a"), [{ source: "/a", target: "/b", type: 301, isRegex: false }]);
	assert.deepEqual(parseRedirectsImport("source,target,enabled,note\n/a,/b,no,\n/c,/d,,hi"), [
		{ source: "/a", target: "/b", type: 301, isRegex: false, enabled: false, note: null },
		{ source: "/c", target: "/d", type: 301, isRegex: false, note: "hi" },
	]);
	assert.deepEqual(parseRedirectsImport("   "), []);
	assert.throws(() => parseRedirectsImport("[oops"), /valid JSON/);
	assert.throws(() => parseRedirectsImport('{"a":1}'), /list of redirects/);
});

// ── Robots ───────────────────────────────────────────────────────

test("robots rules export reads back to the same config, minus another site's import notes", () => {
	const config = normalizeConfig({
		...DEFAULT_CONFIG,
		rules: [{ id: "r1", name: "Block GPTBot", enabled: true, agents: ["GPTBot"], kind: "entire_site", directive: "disallow" }],
		extra: "Content-Signal: search=yes",
		importedAt: "2026-01-01T00:00:00.000Z",
		importNotes: ["from the other site"],
	});
	const text = exportRobotsRules({ ...config, automatic: { llms: true } }, "https://example.com", new Date("2026-10-04T00:00:00Z"));
	const file = JSON.parse(text);
	assert.equal(file.format, "coywolf-pack/robots-rules");
	assert.equal(file.site, "https://example.com");
	assert.equal(file.config.automatic, undefined);
	const back = readRobotsImport(text);
	const { importedAt: _a, importNotes: _n, ...expected } = config;
	assert.deepEqual(back, expected);
	// A bare config object works too.
	assert.deepEqual(readRobotsImport(JSON.stringify(expected)), expected);
	assert.throws(() => readRobotsImport("nope"), /valid JSON/);
	assert.throws(() => readRobotsImport('{"format":"coywolf-pack/robots-rules","config":{}}'), /no rules/);
});

// ── Spreadsheet exports ──────────────────────────────────────────

test("links CSV lists each link with where it's used, guarded for spreadsheets", () => {
	const csv = linksToCsv([
		{
			url: "https://a.example/x",
			resolved: "https://a.example/x",
			host: "a.example",
			internal: false,
			ignored: false,
			status: "broken",
			code: 404,
			finalUrl: null,
			note: "Not found",
			checkedAt: "2026-10-01T00:00:00.000Z",
			usedIn: [
				{ collection: "posts", entryId: "1", title: "=Hello, world", anchors: ["click"] },
				{ collection: "pages", entryId: "2", title: "", anchors: ["click", "here"] },
			],
		},
	]);
	const [header, row] = parseCsv(csv);
	assert.equal(header[0], "url");
	assert.deepEqual(row.slice(0, 5), ["https://a.example/x", "https://a.example/x", "broken", "404", ""]);
	assert.equal(row[10], "2");
	assert.equal(row[11], "'=Hello, world (posts/1) | 2 (pages/2)");
	assert.equal(row[12], "click | here");
});

test("files CSV makes download links absolute", () => {
	const csv = filesToCsv(
		[{ id: "fabc", source: "upload", status: "ready", name: "+report.pdf", type: "application/pdf", size: 2048, uploadedAt: null, url: "/download/fabc/report.pdf", downloads: 7, lastDownload: null, usedIn: [] }],
		"https://example.com",
	);
	const [, row] = parseCsv(csv);
	assert.deepEqual(row.slice(0, 8), ["'+report.pdf", "https://example.com/download/fabc/report.pdf", "application/pdf", "2048", "large upload", "ready", "", "7"]);
});

test("AI entities CSV has a row per entity and keeps entries without any", () => {
	const base = { collection: "posts", title: "T", status: "ok", error: "", description: "Desc", descriptionStatus: "suggested", updated: "2026-10-01" };
	const csv = entitiesToCsv([
		{ ...base, entryId: "1", entities: [{ name: "Cloudflare", type: "Organization", description: "company", qid: "Q4778915", wikipedia: "https://en.wikipedia.org/wiki/Cloudflare", website: "https://cloudflare.com", primary: true }] },
		{ ...base, entryId: "2", status: "error", error: "timeout", entities: [] },
	]);
	const rows = parseCsv(csv);
	assert.equal(rows.length, 3);
	assert.deepEqual(rows[1].slice(4, 9), ["Cloudflare", "Organization", "about", "Q4778915", "https://www.wikidata.org/wiki/Q4778915"]);
	assert.equal(rows[2][3], "error: timeout");
	assert.equal(rows[2][4], "");
	assert.equal(rows[2][12], "Desc");
});

// ── Backup downloads ─────────────────────────────────────────────

function fakeBucket() {
	const objects = new Map();
	const entry = (key) => {
		const o = objects.get(key);
		if (!o) return null;
		return {
			key,
			size: o.bytes.byteLength,
			uploaded: o.uploaded,
			httpEtag: '"etag"',
			body: new Blob([o.bytes]).stream(),
			json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
		};
	};
	return {
		objects,
		async put(key, value) {
			objects.set(key, { bytes: typeof value === "string" ? new TextEncoder().encode(value) : value, uploaded: new Date() });
		},
		async get(key) {
			return entry(key);
		},
		async head(key) {
			return entry(key);
		},
		async delete(keys) {
			for (const k of [].concat(keys)) objects.delete(k);
		},
		async list({ prefix }) {
			return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => entry(k)), truncated: false, delimitedPrefixes: [] };
		},
	};
}

test("downloadFilename puts the backup time before the extension", () => {
	assert.equal(downloadFilename("mysite.sql.gz", "2026-10-03T1802Z"), "mysite-2026-10-03T1802Z.sql.gz");
	assert.equal(downloadFilename("db", "2026-10-03T1802Z"), "db-2026-10-03T1802Z");
});

test("a backup download link streams the file and expires", async () => {
	const bucket = fakeBucket();
	const dump = new Uint8Array([31, 139, 8, 0, 1, 2, 3]);
	await bucket.put("d1/2026-10-03T1802Z/mysite.sql.gz", dump);
	await bucket.put("downloads/stale.json", "{}");
	bucket.objects.get("downloads/stale.json").uploaded = new Date(Date.now() - 3_600_000);

	assert.equal(await createDownloadLink(bucket, "2026-10-03T1802Z", "missing.sql.gz"), null);
	assert.equal(await createDownloadLink(bucket, "../etc", "mysite.sql.gz"), null);
	const link = await createDownloadLink(bucket, "2026-10-03T1802Z", "mysite.sql.gz");
	assert.ok(link.url.startsWith(DOWNLOAD_PATH));
	assert.equal(link.filename, "mysite-2026-10-03T1802Z.sql.gz");
	assert.equal(link.bytes, dump.byteLength);
	assert.ok(!bucket.objects.has("downloads/stale.json"), "expired tickets are pruned");

	const env = { BACKUPS: bucket };
	const site = "https://example.com";
	const request = (path, method = "GET") => new Request(`${site}${path}`, { method });
	const serve = (path, method) => serveBackupDownload(request(path, method), new URL(`${site}${path}`), env);

	// Before the module is configured (no backups option), the middleware ignores the path.
	assert.equal(await serve(link.url), undefined);
	configureBackupDownloads({});

	assert.equal(await serve("/some/page"), undefined);
	const head = await serve(link.url, "HEAD");
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("content-length"), String(dump.byteLength));
	const response = await serve(link.url);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-disposition"), 'attachment; filename="mysite-2026-10-03T1802Z.sql.gz"');
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), dump);

	assert.equal((await serve(`${DOWNLOAD_PATH}${"0".repeat(48)}/x.sql.gz`)).status, 404);
	assert.equal((await serve(`${DOWNLOAD_PATH}not-a-token/x`)).status, 404);
	assert.equal((await serve(link.url, "POST")).status, 405);

	// Expired tickets stop working.
	const token = link.url.slice(DOWNLOAD_PATH.length).split("/")[0];
	const ticketKey = `downloads/${token}.json`;
	const ticket = await (await bucket.get(ticketKey)).json();
	await bucket.put(ticketKey, JSON.stringify({ ...ticket, expires: new Date(Date.now() - 1000).toISOString() }));
	assert.equal((await serve(link.url)).status, 404);
});
