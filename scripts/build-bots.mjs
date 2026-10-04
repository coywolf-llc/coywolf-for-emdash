#!/usr/bin/env node
/**
 * Rebuild src/robots/data/bots.json, the bundled crawler directory for the
 * Robots.txt Rules module.
 *
 *   RADAR_API_TOKEN=… node scripts/build-bots.mjs [--wp <dir>] [--radar-snapshot <file>] [--save-snapshot <file>]
 *
 * Inputs
 *  - Cloudflare Radar's bot directory: GET /client/v4/radar/bots (all bots),
 *    plus GET /radar/bots/{slug} for bots the WordPress data doesn't have yet
 *    (for their user-agent strings and documentation URL). Needs a token with
 *    Account → Radar → Read in RADAR_API_TOKEN, or a snapshot saved earlier
 *    with --save-snapshot and passed back with --radar-snapshot.
 *  - Coywolf SEO's curated tokens (includes/data/bot-tokens.json,
 *    cloudflare-bots.json, ai-crawlers.json): from --wp <dir>, or fetched with
 *    `gh api repos/coywolf-llc/coywolf-seo/contents/includes/data/<file>`.
 *  - src/robots/data/verified.json: tokens checked by hand against the
 *    operator's documentation (source URL + date), corrections and extras.
 *
 * Verification levels written per bot:
 *  - verified / operator-docs: verified.json, or a Coywolf SEO token whose
 *    source is the operator's documentation page (not a homepage or a
 *    third-party list).
 *  - verified / user-agent: the token appears in a user-agent string Radar
 *    publishes for the bot.
 *  - unverified: anything else (derived from a pattern, legacy, hash-like).
 * Bots that share a token are merged into one entry (mergedSlugs).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/robots/data/bots.json");
const VERIFIED = JSON.parse(readFileSync(join(ROOT, "src/robots/data/verified.json"), "utf8"));
const TODAY = new Date().toISOString().slice(0, 10);

const args = process.argv.slice(2);
const arg = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

// ── Coywolf SEO data ────────────────────────────────────────────
function wpFile(name) {
	const dir = arg("--wp");
	if (dir) return JSON.parse(readFileSync(join(dir, name), "utf8"));
	const raw = execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/coywolf-llc/coywolf-seo/contents/includes/data/${name}`], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return JSON.parse(raw);
}
const wpBots = wpFile("cloudflare-bots.json");
const curated = wpFile("bot-tokens.json");
const supplement = wpFile("ai-crawlers.json");
const wpBySlug = new Map(wpBots.map((b) => [b.slug, b]));
/** Date of the Radar data Coywolf SEO's user-agent evidence came from. */
const WP_DATE = arg("--wp-date") ?? "2026-08-13";

// ── Radar ───────────────────────────────────────────────────────
async function radar(path) {
	const token = process.env.RADAR_API_TOKEN;
	if (!token) throw new Error("Set RADAR_API_TOKEN (Account → Radar → Read) or pass --radar-snapshot <file>.");
	const res = await fetch(`https://api.cloudflare.com/client/v4/radar/${path}`, { headers: { Authorization: `Bearer ${token}` } });
	const body = await res.json();
	if (!res.ok || !body.success) throw new Error(`Radar ${path}: ${res.status} ${JSON.stringify(body.errors)}`);
	return body.result;
}

async function loadRadar() {
	const file = arg("--radar-snapshot");
	if (file) return JSON.parse(readFileSync(file, "utf8"));
	const list = [];
	for (let offset = 0; ; offset += 1000) {
		const { bots } = await radar(`bots?limit=1000&offset=${offset}`);
		list.push(...bots);
		if (bots.length < 1000) break;
	}
	// Details (userAgents, operatorUrl) only for bots Coywolf SEO's snapshot lacks.
	const out = [];
	for (const b of list) {
		if (wpBySlug.has(b.slug)) out.push({ ...b, detailsFrom: "wp" });
		else out.push({ ...(await radar(`bots/${encodeURIComponent(b.slug)}`)).bot, detailsFrom: TODAY });
	}
	const save = arg("--save-snapshot");
	if (save) writeFileSync(save, `${JSON.stringify(out, null, "\t")}\n`);
	return out;
}

// ── Helpers ─────────────────────────────────────────────────────
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const THIRD_PARTY = /github\.com\/ai-robots-txt|knownagents\.com|darkvisitors\.com|crawlercheck\.com/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inUA = (token, uas) => uas.some((ua) => new RegExp(`(^|[^A-Za-z0-9._-])${escapeRe(token)}(?=$|[/;\\s)(,])`, "i").test(ua));
/** A bare homepage isn't documentation of a token. */
const isHomepage = (url) => {
	try {
		const u = new URL(url);
		return (u.pathname === "/" || u.pathname === "") && !u.search;
	} catch {
		return true;
	}
};
/** Hex digests and random-looking strings aren't product tokens. */
const hashLike = (t) => /^[0-9a-f]{12,}$/i.test(t) || (t.length >= 16 && !/[._-]/.test(t) && (t.match(/\d/g) ?? []).length >= 3 && /[a-z]/.test(t) && /[A-Z]/.test(t));
const cleanToken = (t) => (t ?? "").replace(/\\/g, "").trim().replace(/\/.*$/, "");
const deriveToken = (patterns, name) => {
	for (const p of patterns ?? []) {
		const t = cleanToken(p);
		if (TOKEN_RE.test(t) && t.toLowerCase() !== "user_agent") return t;
	}
	return TOKEN_RE.test(name) ? name : null;
};
const desc = (s) => {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t;
};
const withHttps = (u) => (u ? (/^https?:\/\//.test(u) ? u : `https://${u}`) : undefined);

// ── Build ───────────────────────────────────────────────────────
const radarBots = await loadRadar();
const entries = [];
const dropped = [];

function verification(slug, token, record, uaDate) {
	const m = VERIFIED.manual[slug];
	if (m) return { token: m.token, status: "verified", evidence: "operator-docs", sourceUrl: m.sourceUrl, verifiedAt: m.verifiedAt };
	const ua = VERIFIED.userAgentVerified[slug];
	if (ua) return { token: ua.token, status: "verified", evidence: "user-agent", sourceUrl: ua.sourceUrl, verifiedAt: ua.verifiedAt, note: ua.note };
	const operatorUrl = withHttps(record.operatorUrl);
	const source = operatorUrl ? { sourceUrl: operatorUrl } : {};
	if (VERIFIED.unverified[slug]) return { token, status: "unverified", evidence: "none", ...source, note: VERIFIED.unverified[slug] };
	if (hashLike(token)) {
		return { token, status: "unverified", evidence: "heuristic", ...source, note: "Radar lists a hash-like identifier, not a product token; robots.txt can't reliably target this bot." };
	}
	const cur = curated[slug];
	if (cur?.confidence === "high" && /^https?:/.test(cur.source ?? "") && !THIRD_PARTY.test(cur.source) && !isHomepage(cur.source) && cleanToken(cur.token) === token) {
		return { token, status: "verified", evidence: "operator-docs", sourceUrl: cur.source, verifiedAt: WP_DATE };
	}
	const uas = [...(record.userAgents ?? []), ...(record.userAgentPatterns ?? [])];
	if ((cur?.confidence ?? "high") === "high" && inUA(token, uas)) return { token, status: "verified", evidence: "user-agent", ...source, verifiedAt: uaDate };
	return { token, status: "unverified", evidence: "heuristic", ...source };
}

for (const live of radarBots) {
	const slug = live.slug;
	if (VERIFIED.exclude[slug]) {
		dropped.push(slug);
		continue;
	}
	const wp = wpBySlug.get(slug);
	const record = { ...(wp ?? {}), ...live, userAgents: live.userAgents ?? wp?.userAgents ?? [], operatorUrl: live.operatorUrl ?? wp?.operatorUrl };
	const cur = curated[slug];
	if (cur?.excluded) {
		dropped.push(slug);
		continue;
	}
	const token = VERIFIED.manual[slug]?.token ?? VERIFIED.userAgentVerified[slug]?.token ?? (cur?.token ? cleanToken(cur.token) : deriveToken(record.userAgentPatterns, record.name ?? ""));
	if (!token || !TOKEN_RE.test(token)) {
		dropped.push(slug);
		continue;
	}
	const uaDate = wp && live.detailsFrom !== TODAY ? WP_DATE : (live.detailsFrom ?? TODAY);
	const v = verification(slug, token, record, uaDate);
	const aliases = (cur?.aliases ?? []).filter((a) => a !== "user_agent" && a.toLowerCase() !== v.token.toLowerCase() && !hashLike(a));
	entries.push({
		slug,
		name: record.name,
		operator: record.operator ?? "",
		category: VERIFIED.categoryFix[slug] ?? record.category ?? "OTHER",
		description: desc(record.description),
		...v,
		...(aliases.length && slug !== "mistralai-user" ? { aliases } : {}),
		origin: "radar",
	});
}

const taken = () => new Set(entries.map((e) => e.token.toLowerCase()));
for (const s of [...supplement, ...VERIFIED.extra]) {
	const token = VERIFIED.manual[s.slug]?.token ?? s.userAgents?.[0] ?? s.name;
	if (taken().has(token.toLowerCase()) || entries.some((e) => e.slug === s.slug)) continue;
	const v = verification(s.slug, token, s, TODAY);
	entries.push({ slug: s.slug, name: s.name, operator: s.operator ?? "", category: VERIFIED.categoryFix[s.slug] ?? s.category, description: desc(s.description), ...v, origin: "curated" });
}

// Merge bots that share a token: keep the best-verified entry, remember the others' slugs.
const rank = (e) => (e.status === "verified" ? (e.evidence === "operator-docs" ? 0 : 1) : 2);
const byToken = new Map();
for (const e of entries) {
	const key = e.token.toLowerCase();
	(byToken.get(key) ?? byToken.set(key, []).get(key)).push(e);
}
const merged = [];
let mergedCount = 0;
for (const group of byToken.values()) {
	group.sort((a, b) => rank(a) - rank(b) || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug));
	const [best, ...rest] = group;
	if (rest.length) {
		best.mergedSlugs = rest.map((r) => r.slug);
		mergedCount += rest.length;
	}
	merged.push(best);
}

// What each preset bot is for (verified.json → purposes), so presets are built by purpose, not Radar category.
for (const e of merged) {
	const p = VERIFIED.purposes?.[e.slug];
	if (p?.purpose) e.purpose = p.purpose;
}
const list = merged.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
writeFileSync(
	OUT,
	`{"generatedAt":"${TODAY}","source":"Cloudflare Radar /radar/bots + operator documentation (scripts/build-bots.mjs)","bots":[\n${list.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`,
);
const count = (f) => list.filter(f).length;
console.log({
	total: list.length,
	verifiedOperatorDocs: count((e) => e.evidence === "operator-docs"),
	verifiedUserAgent: count((e) => e.status === "verified" && e.evidence === "user-agent"),
	unverified: count((e) => e.status === "unverified"),
	mergedDuplicates: mergedCount,
	dropped: dropped.length,
});
