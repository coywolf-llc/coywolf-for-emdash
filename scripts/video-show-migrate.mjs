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
// Auth: EMDASH_TOKEN, else the EmDash CLI login for the URL in
// ~/.config/emdash/auth.json (`npx emdash login --url <site>`), refreshed when
// it has expired. The mapping follows the site's Videos setting "Make all
// video blocks follow the site defaults" (read from the pack's videos/settings
// route; --follow-site-defaults=true|false overrides it).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import "../test/ts-resolve.mjs";

const { normalizeVideoShows } = await import("../src/videos/lib.ts");

const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = args.includes("--apply");
const site = (option("url") || process.env.EMDASH_URL || "").replace(/\/+$/, "");
if (!site) {
	console.error("Usage: node scripts/video-show-migrate.mjs --url=<site> [--apply] [--backup-dir=<dir>] [--follow-site-defaults=true|false]");
	process.exit(1);
}
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
	const headers = { Authorization: `Bearer ${token}` };
	if (method !== "GET") Object.assign(headers, { "Content-Type": "application/json", "X-EmDash-Request": "1", Origin: new URL(site).origin });
	const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const json = await res.json().catch(() => null);
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error?.message ?? ""}`.trim());
	return json && typeof json === "object" && "data" in json ? json.data : json;
}

// ── Plan ─────────────────────────────────────────────────────────

let follow;
const forced = option("follow-site-defaults");
if (forced === "true" || forced === "false") follow = forced === "true";
else {
	const settings = await call("GET", "/plugins/coywolf-pack/videos/settings");
	follow = settings?.display?.followSiteDefaults === true;
}
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
			const got = await call("GET", `/content/${encodeURIComponent(c.slug)}/${encodeURIComponent(listed.id)}`);
			const item = got.item;
			const videos = (JSON.stringify(item.data).match(/"_type":"coywolf-video"/g) ?? []).length;
			totals.entries++;
			totals.videos += videos;
			const changes = {};
			let blocks = 0;
			for (const [field, value] of Object.entries(item.data ?? {})) {
				const out = normalizeVideoShows(value, follow);
				if (out.changed) {
					changes[field] = out.value;
					blocks += out.changed;
				}
			}
			if (!blocks) continue;
			const pendingDraft = Boolean(item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId);
			const action = item.status === "published" ? (pendingDraft ? "skip" : "publish") : "draft";
			plan.push({ collection: c.slug, item, rev: got._rev, changes, blocks, action });
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
	process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────

const backupDir = option("backup-dir") || `video-show-backup-${new URL(site).host}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
let done = 0;
let failed = 0;
for (const p of plan.filter((x) => x.action !== "skip")) {
	try {
		await mkdir(join(backupDir, p.collection), { recursive: true });
		await writeFile(join(backupDir, p.collection, `${p.item.id}.json`), JSON.stringify({ item: p.item, _rev: p.rev }, null, 2));
		const saved = await call("PUT", `/content/${encodeURIComponent(p.collection)}/${encodeURIComponent(p.item.id)}`, { data: p.changes, _rev: p.rev });
		// Collections with revisions stage the save as a draft; publish it (keeps the published date).
		if (p.action === "publish" && saved.item?.draftRevisionId) {
			await call("POST", `/content/${encodeURIComponent(p.collection)}/${encodeURIComponent(p.item.id)}/publish`, saved._rev ? { _rev: saved._rev } : {});
		}
		done++;
		console.log(`  updated ${label(p)}`);
	} catch (error) {
		failed++;
		console.error(`  FAILED ${label(p)}: ${error.message}`);
	}
}
console.log(`Updated ${done}, failed ${failed}, skipped ${skipped.length}. Backups: ${backupDir}`);
process.exit(failed ? 1 : 0);
