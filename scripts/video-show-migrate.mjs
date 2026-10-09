#!/usr/bin/env node
// Turn the true/false show/hide choices older Coywolf Video blocks carry
// (WordPress imports, the old on/off toggles) into "show"/"hide", so the
// block editor shows what the page does. Rendering doesn't change: see
// normalizeVideoShow in src/videos/lib.ts.
//
//   node scripts/video-show-migrate.mjs --url=https://example.com [--apply] [--backup-dir=<dir>]
//
// Dry run by default: lists what would change and writes nothing. With
// --apply it saves a JSON backup of each entry (as the API returned it) to
// --backup-dir (default ./video-show-backup-<host>-<time>), then updates only
// the changed content fields through EmDash's content API, so revisions,
// hooks and cache invalidation happen as for an edit in the admin:
//
// - published, no pending draft: save + publish (published date kept);
// - published with a pending draft: skipped (publishing would also make the
//   draft's edits live; publish or discard the draft, then run again);
// - drafts and scheduled entries: saved to the draft only.
//
// Publishing sets each entry's updated_at to now (EmDash's API has no way to
// save without it), which themes may show as "Updated <date>" and use for
// article:modified_time, sitemap lastmod and feed dates. The backup keeps the
// original date, and a second step puts it back straight in D1:
//
//   node scripts/video-show-migrate.mjs --url=<site> --restore-updated-at --backup-dir=<dir> [--apply --d1=<database> [--wrangler-dir=<dir>]]
//
// It lists each entry's current and original date, writes the guarded SQL to
// <dir>/restore-updated-at.sql, and with --apply runs it through
// `wrangler d1 execute <database> --remote` (from --wrangler-dir, default the
// current directory: the folder with the site's wrangler config), then clears
// the pack's page cache. Each statement changes a row only while updated_at
// still holds the value the migration left, so entries edited since keep
// their new date. Without --d1 it writes the SQL and prints the commands.
//
// Auth: EMDASH_TOKEN, else the EmDash CLI login for the URL in
// ~/.config/emdash/auth.json (`npx emdash login --url <site>`), refreshed when
// it has expired. The mapping follows the site's Videos setting "Make all
// video blocks follow the site defaults" (read from the pack's videos/settings
// route; --follow-site-defaults=true|false overrides it).
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import "../test/ts-resolve.mjs";

const { d1Changes, planEntry, planRestore, restoreUpdatedAtSql } = await import("./video-show-migrate-lib.mjs");

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = args.includes("--apply");
const restoreMode = args.includes("--restore-updated-at");
const site = (option("url") || process.env.EMDASH_URL || "").replace(/\/+$/, "");
const usage = () => {
	console.error("Usage: node scripts/video-show-migrate.mjs --url=<site> [--apply] [--backup-dir=<dir>] [--follow-site-defaults=true|false]");
	console.error("       node scripts/video-show-migrate.mjs --url=<site> --restore-updated-at --backup-dir=<dir> [--apply --d1=<database> [--wrangler-dir=<dir>]]");
	process.exit(1);
};
if (!site) usage();
if (restoreMode && !option("backup-dir")) usage();
const API = `${site}/_emdash/api`;

// ── Auth ─────────────────────────────────────────────────────────

const authFile = join(homedir(), ".config", "emdash", "auth.json");
let token = process.env.EMDASH_TOKEN || "";
if (!token) {
	const all = JSON.parse(await readFile(authFile, "utf8").catch(() => "{}"));
	const cred = all[site];
	if (!cred) {
		console.error(`No EmDash login for ${site}. Run: npx emdash login --url ${site}`);
		process.exit(1);
	}
	token = cred.accessToken;
	if (!(new Date(cred.expiresAt).getTime() > Date.now() + 60_000)) {
		const res = await fetch(`${API}/oauth/token/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refreshToken }),
		});
		if (!res.ok) {
			console.error(`Token refresh failed (${res.status}). Run: npx emdash login --url ${site}`);
			process.exit(1);
		}
		const json = await res.json();
		const t = json.data?.access_token ? json.data : json;
		token = t.access_token;
		all[site] = {
			...cred,
			accessToken: t.access_token,
			refreshToken: t.refresh_token ?? cred.refreshToken,
			expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
		};
		await writeFile(authFile, JSON.stringify(all, null, 2));
	}
}

async function call(method, path, body) {
	const headers = { Authorization: `Bearer ${token}`, "X-EmDash-Request": "1", Origin: new URL(site).origin };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error?.message ?? ""}`.trim());
	return json && typeof json === "object" && "data" in json ? json.data : json;
}

const entryPath = (collection, id) => `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;

let follow;
const forced = option("follow-site-defaults");
if (forced === "true" || forced === "false") follow = forced === "true";
else {
	const settings = await call("GET", "/plugins/coywolf-pack/videos/settings");
	follow = settings?.display?.followSiteDefaults === true;
}

if (restoreMode) await restoreUpdatedAt();
else await migrate();

// ── Migrate ──────────────────────────────────────────────────────

async function migrate() {
	console.log(`${site}: blocks ${follow ? "follow the site defaults (true/false → Site default)" : "keep their own choices (true/false → Show/Hide)"}.`);

	const collections = (await call("GET", "/schema/collections")).items ?? [];
	const plan = [];
	const totals = { entries: 0, videos: 0 };
	for (const c of collections) {
		let cursor;
		do {
			const page = await call("GET", `/content/${encodeURIComponent(c.slug)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			for (const listed of page.items ?? []) {
				if (!JSON.stringify(listed).includes('"coywolf-video"')) continue;
				const got = await call("GET", entryPath(c.slug, listed.id));
				const item = got.item;
				const entry = planEntry(item, follow);
				totals.entries++;
				totals.videos += entry.videos;
				if (entry.action === "none") continue;
				plan.push({ collection: c.slug, item, rev: got._rev, changes: entry.changes, blocks: entry.blocks, action: entry.action });
			}
			cursor = page.nextCursor;
		} while (cursor);
	}

	const label = (p) => `${p.collection}/${p.item.slug ?? p.item.id}`;
	const sum = (list) => list.reduce((n, p) => n + p.blocks, 0);
	console.log(`Coywolf Video blocks: ${totals.videos} in ${totals.entries} entries; with true/false choices: ${sum(plan)} in ${plan.length}.`);
	for (const p of plan) {
		const note = { publish: "save + publish", draft: `save to draft (${p.item.status})`, skip: "SKIP: published with a pending draft" }[p.action];
		console.log(`  ${String(p.blocks).padStart(2)}  ${label(p)}  [${Object.keys(p.changes).join(", ")}]  ${note}`);
	}
	const skipped = plan.filter((p) => p.action === "skip");
	if (skipped.length) console.log(`${skipped.length} skipped: publish or discard their drafts, then run again.`);

	if (!apply) {
		console.log("Dry run: nothing written. Run again with --apply to update.");
		if (plan.some((p) => p.action === "publish")) console.log("Publishing sets updated_at to now; --restore-updated-at puts the original dates back afterward (see the top of this script).");
		process.exit(0);
	}

	const backupDir = option("backup-dir") || `video-show-backup-${new URL(site).host}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	let done = 0;
	let failed = 0;
	for (const p of plan.filter((x) => x.action !== "skip")) {
		const file = join(backupDir, p.collection, `${p.item.id}.json`);
		const backup = { item: p.item, _rev: p.rev };
		try {
			await mkdir(join(backupDir, p.collection), { recursive: true });
			// The entry as it was, before anything is written.
			await writeFile(file, JSON.stringify(backup, null, 2));
			const saved = await call("PUT", entryPath(p.collection, p.item.id), { data: p.changes, _rev: p.rev });
			let final = saved;
			// Collections with revisions stage the save as a draft; publish it (keeps the published date).
			if (p.action === "publish" && saved.item?.draftRevisionId) {
				final = await call("POST", `${entryPath(p.collection, p.item.id)}/publish`, saved._rev ? { _rev: saved._rev } : {});
			}
			// The entry as the migration left it, so --restore-updated-at knows which date is the migration's.
			backup.after = { updatedAt: final.item?.updatedAt, version: final.item?.version, status: final.item?.status, _rev: final._rev };
			await writeFile(file, JSON.stringify(backup, null, 2));
			done++;
			console.log(`  updated ${label(p)}`);
		} catch (error) {
			failed++;
			console.error(`  FAILED ${label(p)}: ${error.message}`);
		}
	}
	console.log(`Updated ${done}, failed ${failed}, skipped ${skipped.length}. Backups: ${backupDir}`);
	if (done) console.log(`To put the original updated dates back: node scripts/video-show-migrate.mjs --url=${site} --restore-updated-at --backup-dir=${backupDir}`);
	process.exit(failed ? 1 : 0);
}

// ── Restore updated_at ───────────────────────────────────────────

async function restoreUpdatedAt() {
	const backupDir = option("backup-dir");
	const database = option("d1");
	const wranglerDir = resolve(option("wrangler-dir") || ".");
	if (apply && !database) {
		console.error("--apply needs --d1=<database name> (the D1 database in the site's wrangler config).");
		process.exit(1);
	}

	const rows = [];
	for (const collection of (await readdir(backupDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
		for (const name of (await readdir(join(backupDir, collection))).filter((f) => f.endsWith(".json"))) {
			const backup = JSON.parse(await readFile(join(backupDir, collection, name), "utf8"));
			const id = backup.item?.id ?? name.slice(0, -5);
			let current = null;
			try {
				current = (await call("GET", entryPath(collection, id))).item;
			} catch (error) {
				if (!/ 404 /.test(error.message)) throw error;
			}
			const plan = planRestore(backup, current, follow);
			rows.push({ collection, id, slug: current?.slug ?? backup.item?.slug, current: current?.updatedAt, ...plan });
		}
	}

	const restores = rows.filter((r) => r.action === "restore");
	console.log(`${site}: ${rows.length} backed-up entries; updated_at to put back: ${restores.length}.`);
	for (const r of rows) {
		const name = `${r.collection}/${r.slug ?? r.id}`;
		if (r.action === "restore") console.log(`  ${name}  ${r.from} → ${r.to}`);
		else console.log(`  ${name}  skip: ${r.reason}`);
	}
	if (!restores.length) {
		console.log("Nothing to restore.");
		process.exit(0);
	}

	const sql = restores.map((r) => restoreUpdatedAtSql(r)).join("\n") + "\n";
	const sqlFile = join(backupDir, "restore-updated-at.sql");
	await writeFile(sqlFile, sql);
	console.log(`SQL written to ${sqlFile}`);

	if (!apply) {
		console.log("Dry run: nothing changed. To apply, either run again with --apply --d1=<database> from the folder with the site's wrangler config, or run:");
		console.log(`  npx wrangler d1 execute <database> --remote --file ${sqlFile}`);
		console.log("  then clear the page cache (Plugins → Coywolf Pack → Performance → Clear pages and images).");
		process.exit(0);
	}

	// wrangler reads the account from the site's wrangler config in --wrangler-dir. The statements go
	// through --command (not --file, which uses D1's import and reports no per-statement results), in
	// chunks so the command line stays short; each statement's result says whether it changed a row.
	const runSql = (text) =>
		new Promise((resolveRun, reject) => {
			const child = spawn("npx", ["wrangler", "d1", "execute", database, "--remote", "--json", "--yes", "--command", text], { cwd: wranglerDir, stdio: ["ignore", "pipe", "inherit"] });
			let out = "";
			child.stdout.on("data", (d) => (out += d));
			child.on("error", reject);
			child.on("close", (code) => (code === 0 ? resolveRun(out) : reject(new Error(`wrangler d1 execute exited with ${code}`))));
		});
	const statements = restores.map((r) => restoreUpdatedAtSql(r));
	const CHUNK = 50;
	const changes = [];
	for (let i = 0; i < statements.length; i += CHUNK) {
		const chunk = statements.slice(i, i + CHUNK);
		let results;
		try {
			const output = await runSql(chunk.join(" "));
			results = d1Changes(JSON.parse(output.slice(output.indexOf("["))));
		} catch (error) {
			console.error(`Could not run or read statements ${i + 1}–${i + chunk.length}: ${error instanceof Error ? error.message : error}`);
			results = [];
		}
		for (let j = 0; j < chunk.length; j++) changes.push(results[j] ?? null);
	}
	let restored = 0;
	let untouched = 0;
	restores.forEach((r, i) => {
		const n = changes[i];
		// D1 counts rows changed by triggers too (EmDash keeps search tables in sync), so a restored
		// entry reports 1 or more; 0 means the guard didn't match.
		if (typeof n === "number" && n > 0) restored++;
		else {
			untouched++;
			console.log(`  NOT CHANGED ${r.collection}/${r.slug ?? r.id}: ${n === 0 ? "updated_at no longer held the migration's value (edited since, or already restored)" : "no result from D1 (check this entry in the admin)"}`);
		}
	});
	console.log(`Restored ${restored}, not changed ${untouched}.`);
	if (untouched) process.exitCode = 1;

	// Pages were rendered with the migration's dates: clear them.
	try {
		const purged = await call("POST", "/plugins/coywolf-pack/cache/purge");
		console.log(`Page cache cleared: pages ${purged?.pages ? "yes" : "no"}, images ${purged?.images?.purged ? "yes" : "no"}.`);
	} catch (error) {
		console.error(`Page cache not cleared (${error.message}); clear it in the admin: Plugins → Coywolf Pack → Performance.`);
	}
	process.exit(untouched ? 1 : 0);
}
