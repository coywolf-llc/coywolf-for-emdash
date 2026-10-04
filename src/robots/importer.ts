/**
 * Turn the robots.txt EmDash was serving into structured rules, and prove
 * the result is equivalent: for every crawler named in either file (plus a
 * few well-known ones and a stand-in for "any other crawler") and every path
 * the files' lines target, both files must give the same verdict. When the
 * rules can't reproduce the file exactly, the original is kept as Extra lines.
 *
 * One deliberate difference: media in EmDash's library (/_emdash/api/media/)
 * is always opened to crawlers, so images can show up in image search. The
 * equivalence check leaves media paths out, and the import summary says so.
 */
import { extractProductToken, parse } from "./rep.js";
import { describeRule } from "./explain.js";
import {
	CONFIG_VERSION,
	DEFAULT_CONFIG,
	EMDASH_ADMIN_PATH,
	EMDASH_MEDIA_PATH,
	PROBE_AGENT,
	type RobotsConfig,
	WELL_KNOWN_PATH,
	type RobotsRule,
	type RuleKind,
	directives,
	generate,
	isValidToken,
	matchGroup,
	samplePaths,
} from "./rules.js";
import { evaluateParsed } from "./rep.js";

/** EmDash's own robots.txt when no custom one is set (emdash/src/astro/routes/robots.txt.ts). */
export function emdashDefaultRobots(siteUrl: string): string {
	return ["User-agent: *", "Allow: /", "", "# Disallow admin and API routes", "Disallow: /_emdash/", "", `Sitemap: ${siteUrl}/sitemap.xml`, ""].join("\n");
}

/** The robots.txt EmDash serves: its custom file (with the sitemap appended when missing) or its default. */
export function emdashRobots(custom: string | null | undefined, siteUrl: string): string {
	const site = siteUrl.replace(/\/$/, "");
	if (custom) {
		let content = custom;
		if (!content.toLowerCase().includes("sitemap:")) content = `${content.trimEnd()}\n\nSitemap: ${site}/sitemap.xml\n`;
		return content;
	}
	return emdashDefaultRobots(site);
}

interface RawGroup {
	/** Lowercased token → written token; "*" for the global group. */
	agents: string[];
	rules: Array<{ directive: "Allow" | "Disallow"; value: string }>;
	/** Lines that aren't Allow/Disallow (Crawl-delay, Content-Signal…), as written. */
	other: string[];
	uaLines: string[];
}

/** Google's grouping: a User-agent line after a rule line starts a new group. */
function groupsOf(text: string): { groups: RawGroup[]; sitemaps: string[]; orphans: string[] } {
	const raw = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
	const { directives: dirs } = parse(text);
	const groups: RawGroup[] = [];
	const sitemaps: string[] = [];
	const orphans: string[] = [];
	let current: RawGroup | null = null;
	let sawRule = false;
	for (const d of dirs) {
		const line = (raw[d.line - 1] ?? "").replace(/#.*$/, "").trim();
		if (d.type === "sitemap") {
			sitemaps.push(d.value);
			continue;
		}
		if (d.type === "user-agent") {
			if (!current || sawRule) {
				current = { agents: [], rules: [], other: [], uaLines: [] };
				groups.push(current);
				sawRule = false;
			}
			current.uaLines.push(line);
			const v = d.value;
			if (v.length >= 1 && v[0] === "*" && (v.length === 1 || /\s/.test(v[1]))) current.agents.push("*");
			else {
				const token = extractProductToken(v);
				if (token) current.agents.push(token);
			}
			continue;
		}
		if (d.type === "allow" || d.type === "disallow") {
			if (!current) continue; // Google ignores rules before any User-agent.
			sawRule = true;
			current.rules.push({ directive: d.type === "allow" ? "Allow" : "Disallow", value: d.value });
			continue;
		}
		if (current) current.other.push(line);
		else orphans.push(line);
	}
	return { groups, sitemaps, orphans };
}

/** The stored rule that writes exactly `value` (or a custom rule when nothing simpler does). */
export function classify(directive: "Allow" | "Disallow", value: string): Pick<RobotsRule, "kind" | "path" | "exts" | "strict" | "directive"> {
	const dir = directive === "Allow" ? "allow" : "disallow";
	const candidates: Array<Pick<RobotsRule, "kind" | "path" | "exts" | "strict">> = [];
	let m: RegExpExecArray | null;
	if (value === "/") candidates.push({ kind: "entire_site" });
	if (value === "/*?") candidates.push({ kind: "query_any" });
	if ((m = /^\/\*\.([A-Za-z0-9]+)\$$/.exec(value))) candidates.push({ kind: "filetype", exts: [m[1].toLowerCase()] });
	if ((m = /^(\/[^*$]*\/)\*\.([A-Za-z0-9]+)\$$/.exec(value))) candidates.push({ kind: "filetype_in_folder", path: m[1], exts: [m[2].toLowerCase()] });
	if ((m = /^\/\*\/([^*$/]+)\/$/.exec(value))) candidates.push({ kind: "any_depth", path: m[1] });
	if (!/[*$]/.test(value)) {
		if (value.endsWith("/")) candidates.push({ kind: "folder", path: value });
		else if (/\/[^/]*\.[^/]+$/.test(value)) candidates.push({ kind: "single_page", path: value });
		else candidates.push({ kind: "prefix", path: value });
	}
	if ((m = /^([^*$]+)\$$/.exec(value))) candidates.push({ kind: "exact_url", path: m[1] });
	if ((m = /^\/\*([^*?/$][^*$]*)$/.exec(value))) candidates.push({ kind: "contains", path: m[1] });
	if ((m = /^(\/[^*$]+)\*$/.exec(value))) candidates.push({ kind: "wildcard_prefix", path: m[1] });
	for (const c of candidates) {
		const probe = { id: "x", name: "x", enabled: true, agents: ["*"], directive: dir, ...c } as RobotsRule;
		const lines = directives(probe);
		if (lines.length === 1 && lines[0].value === value) return { directive: dir, ...c };
	}
	return { directive: dir, kind: "custom" as RuleKind, path: value };
}

export interface ImportResult {
	config: RobotsConfig;
	mode: "rules" | "verbatim";
	/** Plain-English notes for the admin. */
	notes: string[];
}

const WELL_KNOWN = ["Googlebot", "bingbot", "GPTBot", "ClaudeBot", PROBE_AGENT];

/** Same verdicts for every crawler on every path, ignoring media paths (opened on purpose). */
export function equivalent(original: string, generated: string, agents: string[]): boolean {
	const a = parse(original).directives;
	const b = parse(generated).directives;
	const paths = new Set(["/", "/a-post/", "/x.pdf", "/?q=1", "/_emdash/", "/_emdash/admin", "/_emdash/api/content/posts", "/index.html", "/sitemap.xml"]);
	for (const d of [...a, ...b]) {
		if (d.type === "allow" || d.type === "disallow") {
			for (const p of samplePaths(d.value)) paths.add(p);
			paths.add(`${d.value.replace(/\$$/, "").replace(/\*/g, "")}`.replace(/^([^/])/, "/$1") || "/");
		}
	}
	for (const p of paths) {
		// Opened on purpose: media, and discovery files (see discoveryPathsFor).
		if (p.startsWith(EMDASH_MEDIA_PATH) || p.startsWith(WELL_KNOWN_PATH) || p.startsWith("/llms")) continue;
		for (const agent of agents) {
			if (evaluateParsed(a, [agent], p).allowed !== evaluateParsed(b, [agent], p).allowed) return false;
		}
	}
	return true;
}

/** Turn a robots.txt into a config that serves an equivalent file (see the file comment). */
export function importRobots(original: string, siteUrl: string, now = new Date().toISOString()): ImportResult {
	const site = siteUrl.replace(/\/+$/, "");
	const { groups, sitemaps, orphans } = groupsOf(original);
	const tokens = [...new Set(groups.flatMap((g) => g.agents).filter((a) => a !== "*"))];
	const agents = [...new Set([...tokens.filter(isValidToken), ...WELL_KNOWN])];
	const mediaAlreadyOpen = evaluateParsed(parse(original).directives, [PROBE_AGENT], `${EMDASH_MEDIA_PATH}file/a.jpg`).allowed;

	const sitemapSettings = (() => {
		const own = `${site}/sitemap.xml`;
		const list = [...new Set(sitemaps)];
		return { includeSitemap: list.includes(own), sitemaps: list.filter((s) => s !== own) };
	})();

	const build = (inheritGeneral: boolean, emdashLines: boolean): RobotsConfig | null => {
		const byLine = new Map<string, RobotsRule>();
		const extra: string[] = [...orphans];
		let n = 0;
		for (const g of groups) {
			const named = g.agents.filter((a) => a === "*" || isValidToken(a));
			if (!named.length) continue;
			if (g.other.length) extra.push([...g.uaLines, ...g.other].join("\n"));
			// Google: Allow wins ties, so a value both allowed and blocked is allowed.
			const lines = g.rules.filter((r) => r.value !== "" && !(r.directive === "Disallow" && g.rules.some((o) => o.directive === "Allow" && o.value === r.value)));
			// Explicit lines (including EmDash's harmless `Allow: /`) are kept as rules.
			let effective = lines;
			if (emdashLines && named.includes("*")) {
				effective = effective.filter((l) => !(l.directive === "Disallow" && l.value === EMDASH_ADMIN_PATH) && !(l.directive === "Allow" && l.value === EMDASH_MEDIA_PATH));
			}
			// A group whose lines all drop out still names its crawlers (they ignore `*`): keep it as "allow everything".
			if (!effective.length && g.rules.length && !named.includes("*")) effective = [{ directive: "Allow", value: "/" }];
			for (const l of effective) {
				const k = `${l.directive}|${l.value}`;
				let rule = byLine.get(k);
				if (!rule) {
					rule = { id: `imp${++n}`, name: "", enabled: true, agents: [], ...classify(l.directive, l.value), source: "import" };
					byLine.set(k, rule);
				}
				for (const a of named) if (!rule.agents.some((x) => x.toLowerCase() === a.toLowerCase())) rule.agents.push(a);
			}
		}
		const rules = [...byLine.values()];
		for (const rule of rules) {
			const group = matchGroup(rule.agents);
			if (group && rule.agents.length === group.tokens.length) rule.group = group.id;
			rule.name = describeRule(rule);
		}
		const config: RobotsConfig = {
			...DEFAULT_CONFIG,
			version: CONFIG_VERSION,
			rules,
			...sitemapSettings,
			allowMedia: true,
			extra: extra.join("\n\n"),
			inheritGeneral,
			emdashLines,
			importedAt: now,
			importMode: "rules",
		};
		return equivalent(original, generate(config, { siteUrl: site }), agents) ? config : null;
	};

	const notes: string[] = [];
	const discoveryBlocked = agents.some((a) => !evaluateParsed(parse(original).directives, [a], `${WELL_KNOWN_PATH}security.txt`).allowed);
	const mediaNote = [
		...(discoveryBlocked ? ["Discovery files under /.well-known/ (and llms.txt, when Discovery is on) stay readable for every crawler, so AI agents and tools can find them."] : []),
		...mediaNoteOnly(),
	];
	function mediaNoteOnly(): string[] {
		return mediaAlreadyOpen ? [] : ["We added one improvement: images and files in your media library can now be crawled, so they can appear in image search."];
	}
	for (const [inherit, emdash] of [
		[true, true],
		[false, true],
		[true, false],
		[false, false],
	] as const) {
		const config = build(inherit, emdash);
		if (!config) continue;
		notes.push(
			config.rules.length
				? `We turned EmDash's robots.txt into ${config.rules.length} rule${config.rules.length === 1 ? "" : "s"}. Crawlers see exactly the same rules as before.`
				: "EmDash's robots.txt had no rules of its own beyond keeping its admin private. Crawlers see exactly the same rules as before.",
			...mediaNote,
		);
		if (!emdash) notes.push("EmDash's admin wasn't blocked for every crawler in the old file, so we kept it that way. Turn on “Keep EmDash's admin private” in Settings to block it.");
		config.importNotes = notes;
		return { config, mode: "rules", notes };
	}

	// Fallback: serve the original lines unchanged (minus sitemaps, which are settings).
	const body = original
		.replace(/^﻿/, "")
		.split(/\r\n|\r|\n/)
		.filter((l) => !/^\s*site-?map\s*:/i.test(l))
		.join("\n")
		.trim();
	const config: RobotsConfig = {
		...DEFAULT_CONFIG,
		rules: [],
		...sitemapSettings,
		allowMedia: true,
		extra: mediaAlreadyOpen || !evaluateParsed(parse(original).directives, [PROBE_AGENT], "/some-page/").allowed ? body : `${body}\n\n# Added by Coywolf Pack: let crawlers see your media library\nUser-agent: *\nAllow: ${EMDASH_MEDIA_PATH}`,
		emdashLines: false,
		importedAt: now,
		importMode: "verbatim",
	};
	notes.push("EmDash's robots.txt uses lines that can't be turned into rules exactly, so it's kept as written under Extra lines. Crawlers see the same rules as before.", ...(config.extra.includes("Added by Coywolf Pack") ? mediaNote : []));
	config.importNotes = notes;
	return { config, mode: "verbatim", notes };
}
