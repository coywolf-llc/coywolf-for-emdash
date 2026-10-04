/**
 * Plain-English descriptions of rules and of the whole robots.txt, for
 * people who don't read robots.txt syntax.
 */
import { evaluateParsed, parse } from "./rep.js";
import {
	CRAWLER_GROUPS,
	type DirectoryBot,
	PROBE_AGENT,
	type RobotsConfig,
	type RobotsRule,
	generate,
	groupTokens,
	matchGroup,
	resolveAgents,
	ruleExts,
	ruleParams,
} from "./rules.js";

const FILE_TYPE_NAMES: Record<string, string> = {
	pdf: "PDF",
	doc: "Word",
	docx: "Word",
	xls: "Excel",
	xlsx: "Excel",
	csv: "CSV",
	ppt: "PowerPoint",
	pptx: "PowerPoint",
	zip: "ZIP",
	jpg: "JPEG",
	jpeg: "JPEG",
	png: "PNG",
	gif: "GIF",
	webp: "WebP",
	avif: "AVIF",
	svg: "SVG",
	mp4: "MP4",
	mov: "QuickTime",
	webm: "WebM",
	mp3: "MP3",
};

export function listPhrase(items: string[], max = 3): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length <= max) return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
	return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** "all crawlers", "AI training crawlers", "GPTBot and ClaudeBot"… */
export function describeAgents(rule: Pick<RobotsRule, "agents" | "group">, nameOf?: (token: string) => string): string {
	if (rule.agents.includes("*")) {
		const others = rule.agents.filter((a) => a !== "*");
		return others.length ? `all crawlers (including ${listPhrase(others)})` : "all crawlers";
	}
	const group = (rule.group && CRAWLER_GROUPS.find((g) => g.id === rule.group)) || matchGroup(rule.agents);
	if (group) {
		const inGroup = new Set(group.tokens.map((t) => t.toLowerCase()));
		const extra = rule.agents.filter((a) => !inGroup.has(a.toLowerCase()));
		const count = rule.agents.length;
		if (!extra.length || rule.group === group.id) return `${group.phrase} (${count})`;
		return `${group.phrase} and ${listPhrase(extra.map((a) => nameOf?.(a) ?? a), 2)}`;
	}
	return listPhrase(rule.agents.map((a) => nameOf?.(a) ?? a));
}

function extsPhrase(exts: string[]): string {
	const names = [...new Set(exts.map((e) => FILE_TYPE_NAMES[e] ?? `.${e}`))];
	return `${listPhrase(names, 4)} files`;
}

/** What part of the site a rule covers, e.g. "the /private/ section and everything in it". */
export function describeTarget(rule: RobotsRule): string {
	const path = rule.path ?? "";
	switch (rule.kind) {
		case "entire_site":
			return "the whole site";
		case "folder": {
			const p = path.endsWith("/") ? path : `${path}/`;
			const folder = p.startsWith("/") ? p : `/${p}`;
			return rule.anyDepth
				? `every ${folder.replace(/^\/|\/$/g, "") || "/"}/ folder, at any level, and everything in them`
				: `the ${folder} section and everything in it`;
		}
		case "prefix":
			return `every address starting with ${path.startsWith("/") ? path : `/${path}`}`;
		case "single_page":
			return rule.strict ? `only the exact address ${path}` : `the page ${path} (and addresses that continue it)`;
		case "exact_url":
			return `only the exact address ${path.startsWith("/") ? path : `/${path}`}`;
		case "filetype":
			return `${extsPhrase(ruleExts(rule))} anywhere on the site`;
		case "filetype_in_folder":
			return `${extsPhrase(ruleExts(rule))} in ${path.endsWith("/") ? path : `${path}/`}`;
		case "contains":
			return `addresses containing “${path}”`;
		case "any_depth":
			return `any ${path.replace(/^\/+|\/+$/g, "")}/ folder below the top level`;
		case "query_any":
			return "addresses with a query string (anything after a ?)";
		case "query_param": {
			const params = ruleParams(rule).map((p) => (p.endsWith("*") ? `${p.slice(0, -1)}…` : p));
			return `addresses with the ${listPhrase(params, 4)} parameter${params.length > 1 ? "s" : ""}`;
		}
		case "wildcard_prefix":
			return `addresses matching ${path.endsWith("*") ? path : `${path}*`}`;
		case "allow_exception":
			return `the ${path} section, except ${rule.allow ?? ""}`;
		default:
			return path ? `addresses matching ${path}` : "nothing (an empty value)";
	}
}

/** One sentence: "Block AI training crawlers (11) from the whole site". */
export function describeRule(rule: RobotsRule, nameOf?: (token: string) => string): string {
	const who = describeAgents(rule, nameOf);
	const what = describeTarget(rule);
	let sentence =
		rule.kind === "allow_exception"
			? `Block ${who} from ${what}`
			: rule.directive === "allow"
				? `Let ${who} crawl ${what}`
				: `Block ${who} from ${what}`;
	if (rule.directive === "disallow" && rule.except?.length) sentence += `, except ${listPhrase(rule.except, 3)}`;
	return sentence;
}

export interface SummaryLine {
	who: string;
	text: string;
	tone: "open" | "partial" | "closed";
}

/**
 * A plain-English summary of what the whole file does, by kind of crawler:
 * "Search engines can crawl everything except EmDash's admin."
 */
export function summarize(config: RobotsConfig, siteUrl: string, bots: DirectoryBot[] = []): SummaryLine[] {
	const text = generate(config, { siteUrl });
	const parsed = parse(text).directives;
	const resolved = resolveAgents(config);
	const ruleById = new Map(config.rules.map((r) => [r.id, r]));
	const out: SummaryLine[] = [];
	const describeFor = (tokens: string[], who: string) => {
		const states = tokens.map((t) => {
			const home = evaluateParsed(parsed, [t], "/").allowed;
			const page = evaluateParsed(parsed, [t], "/some-page/").allowed;
			const lines = resolved.get(t.toLowerCase())?.lines ?? resolved.get("*")?.lines ?? [];
			const blocks = lines.filter((l) => !l.system && l.directive === "Disallow");
			const allows = lines.filter((l) => !l.system && l.directive === "Allow");
			const areas = (list: typeof lines) =>
				[...new Set(list.flatMap((l) => l.ruleIds.map((id) => ruleById.get(id))).filter(Boolean).map((r) => describeTarget(r as RobotsRule)))];
			if (!home && !page) {
				const open = areas(allows);
				return open.length ? { tone: "partial" as const, text: `are blocked from the whole site except ${listPhrase(open, 3)}` } : { tone: "closed" as const, text: "are blocked from the whole site" };
			}
			const closed = areas(blocks);
			if (closed.length) return { tone: "partial" as const, text: `can crawl everything except ${listPhrase(closed, 3)}` };
			return { tone: "open" as const, text: "can crawl everything" };
		});
		if (!states.length) return;
		const buckets = new Map<string, { tone: SummaryLine["tone"]; tokens: string[] }>();
		states.forEach((st, i) => {
			const b = buckets.get(st.text) ?? { tone: st.tone, tokens: [] };
			b.tokens.push(tokens[i]);
			buckets.set(st.text, b);
		});
		if (buckets.size === 1) {
			const [[text, b]] = [...buckets];
			out.push({ who, text: tokens.length === 1 && who !== "All other crawlers" ? text.replace(/^are /, "is ") : text, tone: b.tone });
			return;
		}
		const sorted = [...buckets].sort((a, b) => a[1].tokens.length - b[1].tokens.length);
		const parts = sorted.map(([text, b], i) => (i === sorted.length - 1 && b.tokens.length > 3 ? `the others ${text}` : `${listPhrase(b.tokens, 3)} ${b.tokens.length === 1 ? text.replace(/^are /, "is ") : text}`));
		out.push({ who: `${who}:`, text: parts.join("; "), tone: "partial" });
	};
	const named = new Set<string>();
	for (const group of CRAWLER_GROUPS) {
		const tokens = groupTokens(group, bots);
		for (const t of tokens) named.add(t.toLowerCase());
		describeFor(tokens, group.phrase.charAt(0).toUpperCase() + group.phrase.slice(1));
	}
	const others = [...resolved.values()].map((e) => e.token).filter((t) => t !== "*" && !named.has(t.toLowerCase()));
	if (others.length) describeFor(others, listPhrase(others, 3));
	describeFor([PROBE_AGENT], "All other crawlers");
	return out;
}

/** "Search engines can crawl everything." as one string per line. */
export function summaryText(lines: SummaryLine[]): string[] {
	return lines.map((l) => `${l.who} ${l.text}.`);
}
