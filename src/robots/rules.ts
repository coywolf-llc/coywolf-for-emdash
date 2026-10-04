/**
 * Robots.txt rules: the stored model, rendering each named rule to directive
 * lines (ported from Coywolf SEO's rule types), and generating the served
 * robots.txt with EmDash's own required lines kept intact.
 *
 * No imports, so the tests can run this file under plain Node.
 */

export const RULE_KINDS = [
	"entire_site",
	"folder",
	"prefix",
	"single_page",
	"exact_url",
	"filetype",
	"filetype_in_folder",
	"contains",
	"any_depth",
	"query_any",
	"query_param",
	"wildcard_prefix",
	"allow_exception",
	"custom",
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export interface RobotsRule {
	id: string;
	/** Plain-English name, written as a comment above the rule. */
	name: string;
	description?: string;
	enabled: boolean;
	/** robots.txt product tokens ("*" for every crawler). */
	agents: string[];
	/** Disallow (block) or Allow. `allow_exception` always writes both. */
	directive: "allow" | "disallow";
	kind: RuleKind;
	path?: string;
	ext?: string;
	/** For `allow_exception`: the item to allow inside the blocked folder. */
	allow?: string;
	/** For `single_page`: append `$` so nothing past the path matches. */
	strict?: boolean;
}

export interface RobotsConfig {
	rules: RobotsRule[];
	/** Write EmDash's `Sitemap: <site>/sitemap.xml` line. */
	includeSitemap: boolean;
	/** More sitemap URLs (absolute, or site-relative paths). */
	sitemaps: string[];
	/** Let crawlers fetch media files, which EmDash serves from /_emdash/api/media/. */
	allowMedia: boolean;
	/** Write each rule's name as a comment. */
	comments: boolean;
	/** Raw lines appended before the sitemaps (e.g. a Content-Signal line). */
	extra: string;
}

export const DEFAULT_CONFIG: RobotsConfig = {
	rules: [],
	includeSitemap: true,
	sitemaps: [],
	allowMedia: true,
	comments: true,
	extra: "",
};

export const EMDASH_ADMIN_PATH = "/_emdash/";
export const EMDASH_MEDIA_PATH = "/_emdash/api/media/";

/** A robots.txt product token: letters, digits, `.`, `_`, `-` (or `*`). */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidToken(token: string): boolean {
	return token === "*" || TOKEN_RE.test(token);
}

export class RobotsValidationError extends Error {}

const lead = (p: string) => {
	const t = p.trim();
	return !t || t.startsWith("/") ? t : `/${t}`;
};
const dirPath = (p: string) => {
	const t = lead(p);
	if (!t) return "/";
	return t.endsWith("/") ? t : `${t}/`;
};
const ensureStar = (p: string) => (p.endsWith("*") ? p : `${p}*`);
/** robots.txt values can't contain whitespace or comments. */
const clean = (v: string) => v.replace(/[\s#]+/g, "");

export interface DirectiveLine {
	directive: "Allow" | "Disallow";
	value: string;
}

/** The directive line(s) a rule writes (no User-agent lines). */
export function directives(rule: RobotsRule): DirectiveLine[] {
	const path = clean(rule.path ?? "");
	const ext = clean(rule.ext ?? "").replace(/^\.+/, "");
	const allow = clean(rule.allow ?? "");
	const dir: DirectiveLine["directive"] = rule.directive === "allow" ? "Allow" : "Disallow";
	const line = (value: string, d = dir): DirectiveLine => ({ directive: d, value });
	switch (rule.kind) {
		case "entire_site":
			return [line("/")];
		case "folder":
			return [line(dirPath(path))];
		case "prefix":
			return [line(lead(path))];
		case "single_page":
			return [line(lead(path) + (rule.strict ? "$" : ""))];
		case "exact_url":
			return [line(`${lead(path)}$`)];
		case "filetype":
			return [line(`/*.${ext}$`)];
		case "filetype_in_folder":
			return [line(`${dirPath(path)}*.${ext}$`)];
		case "contains":
			return [line(`/*${path.replace(/^\/+/, "")}`)];
		case "any_depth":
			return [line(`/*/${path.replace(/^\/+|\/+$/g, "")}/`)];
		case "query_any":
			return [line("/*?")];
		case "query_param": {
			const name = path.replace(/^[?&]+/, "").replace(/=+$/, "");
			return [line(`/*?${name}=`), line(`/*&${name}=`)];
		}
		case "wildcard_prefix":
			return [line(ensureStar(lead(path)))];
		case "allow_exception":
			return allow ? [line(dirPath(path), "Disallow"), line(lead(allow), "Allow")] : [line(dirPath(path), "Disallow")];
		default:
			return [line(path)];
	}
}

/** Throws RobotsValidationError when a rule can't produce a sensible directive. */
export function validateRule(rule: RobotsRule): void {
	if (!rule.name.trim()) throw new RobotsValidationError("Give the rule a name.");
	if (!rule.agents.length) throw new RobotsValidationError("Pick at least one crawler (or * for all).");
	for (const agent of rule.agents) {
		if (!isValidToken(agent)) {
			throw new RobotsValidationError(
				`"${agent}" isn't a robots.txt user-agent token (letters, digits, dot, dash and underscore, no spaces).`,
			);
		}
	}
	const needsPath = !["entire_site", "query_any", "filetype"].includes(rule.kind);
	if (needsPath && !clean(rule.path ?? "")) throw new RobotsValidationError("This rule type needs a path.");
	if ((rule.kind === "filetype" || rule.kind === "filetype_in_folder") && !/^[A-Za-z0-9]+$/.test(clean(rule.ext ?? "").replace(/^\.+/, ""))) {
		throw new RobotsValidationError("Enter a file extension such as pdf.");
	}
	if (rule.kind === "custom" && !/^[/*]/.test(clean(rule.path ?? ""))) {
		throw new RobotsValidationError("A custom value must start with / or *.");
	}
}

const oneLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** Values that must stay on one line and can't contain spaces (URLs, tokens): drop all whitespace, including CR/LF. */
const singleLine = (s: string | undefined) => (s ?? "").replace(/\s+/g, "");

function uniq(list: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of list) {
		const key = item.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			out.push(item);
		}
	}
	return out;
}

/** REP wildcard match (`*` any run, final `$` anchors), as in ./rep.ts; duplicated to keep this file import-free. */
function wildcardMatch(pattern: string, path: string): boolean {
	let pos = [0];
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "$" && i + 1 === pattern.length) return pos.includes(path.length);
		if (c === "*") {
			const from = Math.min(...pos);
			pos = Array.from({ length: path.length - from + 1 }, (_, k) => from + k);
		} else {
			pos = pos.filter((p) => p < path.length && path[p] === c).map((p) => p + 1);
			if (!pos.length) return false;
		}
	}
	return true;
}

/** Paths a whole-site block must cover: the home page, any page, and EmDash media. */
const WHOLE_SITE_PROBES = ["/", "/any/page.html?x=1", `${"/_emdash/api/media/"}file/a.jpg`];

/** Whether a Disallow value blocks every URL (`/`, `/*`, `*`, `/**`…), unlike e.g. `/$` (home page only). */
export function blocksWholeSite(value: string): boolean {
	return value !== "" && WHOLE_SITE_PROBES.every((p) => wildcardMatch(value, p));
}

/** Agents with an enabled rule that blocks the whole site. */
function rootBlocked(rules: RobotsRule[]): Set<string> {
	const out = new Set<string>();
	for (const rule of rules) {
		if (directives(rule).some((d) => d.directive === "Disallow" && blocksWholeSite(d.value))) {
			for (const a of rule.agents) out.add(a.toLowerCase());
		}
	}
	return out;
}

export interface GenerateOptions {
	/** Site origin without a trailing slash, e.g. "https://wellbeing.io". */
	siteUrl: string;
}

/**
 * Build robots.txt. Crawlers obey only their most specific group(s), so a bot
 * named in any rule would otherwise skip the `*` group and EmDash's
 * `Disallow: /_emdash/`; the EmDash group therefore lists `*` plus every
 * named bot that isn't blocked from the whole site. Media stays fetchable via
 * a longer `Allow: /_emdash/api/media/` (longest match wins), except for bots
 * blocked from the whole site, where that Allow would reopen media.
 */
export function generate(config: RobotsConfig, options: GenerateOptions): string {
	const siteUrl = singleLine(options.siteUrl).replace(/\/+$/, "");
	const rules = config.rules
		.filter((r) => r.enabled)
		.map((r) => ({ ...r, agents: r.agents.map(singleLine).filter(isValidToken) }))
		.filter((r) => r.agents.length);
	const out: string[] = config.comments ? ["# robots.txt managed by Coywolf Pack (Robots.txt Rules)", ""] : [];

	for (const rule of rules) {
		const lines = uniq(directives(rule).map((d) => `${d.directive}: ${d.value}`));
		if (!lines.length) continue;
		if (config.comments) {
			const comment = [oneLine(rule.name), oneLine(rule.description)].filter(Boolean).join(": ");
			if (comment) out.push(`# ${comment}`);
		}
		for (const agent of uniq(rule.agents)) out.push(`User-agent: ${agent}`);
		out.push(...lines, "");
	}

	const blocked = rootBlocked(rules);
	const named = uniq(rules.flatMap((r) => r.agents)).filter((a) => a !== "*" && !blocked.has(a.toLowerCase()));
	const emdashAgents = [...(blocked.has("*") ? [] : ["*"]), ...named];
	if (emdashAgents.length) {
		if (config.comments) out.push("# EmDash admin and API (media files stay crawlable)");
		for (const agent of emdashAgents) out.push(`User-agent: ${agent}`);
		if (config.allowMedia) out.push(`Allow: ${EMDASH_MEDIA_PATH}`);
		out.push(`Disallow: ${EMDASH_ADMIN_PATH}`, "");
	}

	const extra = config.extra.trim();
	if (extra) out.push(extra, "");

	const sitemaps: string[] = [];
	if (config.includeSitemap) sitemaps.push(`${siteUrl}/sitemap.xml`);
	for (const s of config.sitemaps) {
		const t = singleLine(s);
		if (!t) continue;
		sitemaps.push(/^https?:\/\//i.test(t) ? t : `${siteUrl}${lead(t)}`);
	}
	for (const s of uniq(sitemaps)) out.push(`Sitemap: ${s}`);

	return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Normalize untrusted stored/posted config (missing fields get defaults). */
export function normalizeConfig(input: Partial<RobotsConfig> | null | undefined): RobotsConfig {
	return {
		rules: Array.isArray(input?.rules) ? input.rules : [],
		includeSitemap: input?.includeSitemap ?? DEFAULT_CONFIG.includeSitemap,
		sitemaps: Array.isArray(input?.sitemaps) ? input.sitemaps : [],
		allowMedia: input?.allowMedia ?? DEFAULT_CONFIG.allowMedia,
		comments: input?.comments ?? DEFAULT_CONFIG.comments,
		extra: typeof input?.extra === "string" ? input.extra : "",
	};
}

/** Starting points offered in the admin ("named rules"). Tokens are checked against operators' documentation. */
export const PRESETS: Array<Omit<RobotsRule, "id" | "enabled">> = [
	{
		name: "Block AI training crawlers",
		description: "Opt out of crawlers that collect content to train AI models. Search and AI answers are unaffected.",
		directive: "disallow",
		kind: "entire_site",
		agents: [
			"GPTBot",
			"ClaudeBot",
			"Google-Extended",
			"Applebot-Extended",
			"CCBot",
			"meta-externalagent",
			"Bytespider",
			"Amazonbot",
			"MistralAI-Training",
			"Webzio-Extended",
			"ImagesiftBot",
		],
	},
	{
		name: "Block AI search and assistants",
		description: "Keep AI answer engines and on-demand AI fetchers out. Your pages won't be cited in their answers.",
		directive: "disallow",
		kind: "entire_site",
		agents: [
			"OAI-SearchBot",
			"ChatGPT-User",
			"Claude-SearchBot",
			"Claude-User",
			"PerplexityBot",
			"Perplexity-User",
			"meta-externalfetcher",
			"MistralAI-User",
			"DuckAssistBot",
			"Amzn-User",
		],
	},
	{
		name: "Allow search engines",
		description: "Explicitly allow the major search engines everywhere EmDash allows them.",
		directive: "allow",
		kind: "entire_site",
		agents: ["Googlebot", "bingbot", "Applebot", "DuckDuckBot", "YandexBot", "Baiduspider"],
	},
	{
		name: "Block SEO tool crawlers",
		description: "Stop backlink and SEO-audit crawlers that don't send visitors.",
		directive: "disallow",
		kind: "entire_site",
		agents: ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "BLEXBot", "DataForSeoBot", "Barkrowler"],
	},
];
