/**
 * The guided "Add rule" flow's model: a small set of plain choices that
 * map onto stored rules (and back, for editing), smart reading of pasted
 * addresses, and live "will match / won't match" examples from the real
 * matcher.
 *
 * Choices → stored kinds:
 *   Everything                        → entire_site
 *   A section (+ "at any depth")      → folder (+ anyDepth)
 *   One page (+ "only this address")  → single_page / exact_url
 *   A kind of file (+ "only in…")     → filetype / filetype_in_folder
 *   Links with parameters             → query_param / query_any
 *   Advanced pattern                  → custom (covers prefix, contains, wildcard…)
 *   Block … "Except…"                 → except[] (more specific Allow lines)
 */
import { matchRaw } from "./rep.js";
import {
	CRAWLER_GROUPS,
	type DirectoryBot,
	type RobotsRule,
	directives,
	groupTokens,
	matchGroup,
	normalizePathInput,
	ruleExts,
	ruleParams,
	samplePaths,
} from "./rules.js";

export type Area = "everything" | "section" | "page" | "files" | "params" | "advanced";
export type Who = "everyone" | "search_engines" | "ai_training" | "ai_search" | "seo_tools" | "specific";

export interface Draft {
	id: string;
	enabled: boolean;
	action: "block" | "allow";
	area: Area;
	section: string;
	anyDepth: boolean;
	page: string;
	exact: boolean;
	fileTypes: string[];
	otherExt: string;
	filesIn: string;
	params: string[];
	anyQuery: boolean;
	otherParam: string;
	pattern: string;
	except: string[];
	who: Who;
	agents: string[];
	name: string;
	description: string;
	nameTouched: boolean;
	descriptionTouched: boolean;
}

export const FILE_TYPES: Array<{ id: string; label: string; exts: string[] }> = [
	{ id: "pdf", label: "PDF", exts: ["pdf"] },
	{ id: "word", label: "Word", exts: ["doc", "docx"] },
	{ id: "sheets", label: "Spreadsheets", exts: ["xls", "xlsx", "csv"] },
	{ id: "slides", label: "Presentations", exts: ["ppt", "pptx"] },
	{ id: "images", label: "Images", exts: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"] },
	{ id: "zip", label: "ZIP archives", exts: ["zip"] },
	{ id: "video", label: "Video", exts: ["mp4", "mov", "webm"] },
	{ id: "audio", label: "Audio", exts: ["mp3", "m4a", "wav"] },
];

export const PARAMS: Array<{ id: string; label: string; names: string[]; hint: string }> = [
	{ id: "utm", label: "utm_… (campaign tracking)", names: ["utm_*"], hint: "?utm_source=newsletter" },
	{ id: "ref", label: "ref", names: ["ref"], hint: "?ref=twitter" },
	{ id: "fbclid", label: "fbclid (Facebook)", names: ["fbclid"], hint: "?fbclid=…" },
	{ id: "gclid", label: "gclid (Google Ads)", names: ["gclid"], hint: "?gclid=…" },
	{ id: "session", label: "Session IDs", names: ["sessionid", "sid"], hint: "?sessionid=…" },
	{ id: "sort", label: "Sorting and filters", names: ["sort", "order", "filter"], hint: "?sort=price" },
	{ id: "search", label: "Site search", names: ["q", "s", "search"], hint: "?q=oats" },
];

export function blankDraft(id: string): Draft {
	return {
		id,
		enabled: true,
		action: "block",
		area: "section",
		section: "",
		anyDepth: false,
		page: "",
		exact: false,
		fileTypes: [],
		otherExt: "",
		filesIn: "",
		params: [],
		anyQuery: false,
		otherParam: "",
		pattern: "",
		except: [],
		who: "everyone",
		agents: [],
		name: "",
		description: "",
		nameTouched: false,
		descriptionTouched: false,
	};
}

const splitList = (s: string) =>
	s
		.split(/[\s,]+/)
		.map((x) => x.trim())
		.filter(Boolean);

export function draftExts(d: Draft): string[] {
	return [...new Set([...FILE_TYPES.filter((f) => d.fileTypes.includes(f.id)).flatMap((f) => f.exts), ...splitList(d.otherExt).map((e) => e.replace(/^\.+/, "").toLowerCase())])];
}

export function draftParams(d: Draft): string[] {
	return [...new Set([...PARAMS.filter((p) => d.params.includes(p.id)).flatMap((p) => p.names), ...splitList(d.otherParam).map((p) => p.replace(/^[?&]+/, "").replace(/=.*$/, ""))])];
}

export function draftAgents(d: Draft, bots: DirectoryBot[]): string[] {
	if (d.who === "everyone") return ["*"];
	if (d.who === "specific") return d.agents;
	const group = CRAWLER_GROUPS.find((g) => g.id === d.who);
	return group ? groupTokens(group, bots) : [];
}

const asFolder = (v: string) => (v === "" ? "" : v.endsWith("/") ? v : `${v}/`);

/** The stored rule a draft produces (name/description filled by the caller). */
export function draftToRule(d: Draft, bots: DirectoryBot[], siteUrl = ""): RobotsRule {
	const norm = (v: string) => normalizePathInput(v, siteUrl).value;
	const base = {
		id: d.id,
		name: d.name,
		description: d.description || undefined,
		enabled: d.enabled,
		agents: draftAgents(d, bots),
		directive: d.action === "allow" ? ("allow" as const) : ("disallow" as const),
		...(d.who !== "everyone" && d.who !== "specific" ? { group: d.who } : {}),
		source: "user" as const,
	};
	const except = d.action === "block" && (d.area === "section" || d.area === "everything" || d.area === "advanced") ? d.except.map((e) => e.trim()).filter(Boolean).map(norm) : [];
	const withExcept = except.length ? { except } : {};
	switch (d.area) {
		case "everything":
			return { ...base, kind: "entire_site", ...withExcept };
		case "section":
			return { ...base, kind: "folder", path: asFolder(norm(d.section)), ...(d.anyDepth ? { anyDepth: true } : {}), ...withExcept };
		case "page":
			return { ...base, kind: d.exact ? "exact_url" : "single_page", path: norm(d.page).replace(/\$$/, "") };
		case "files": {
			const exts = draftExts(d);
			const folder = d.filesIn.trim() ? asFolder(norm(d.filesIn)) : "";
			return folder ? { ...base, kind: "filetype_in_folder", path: folder, exts } : { ...base, kind: "filetype", exts };
		}
		case "params":
			return d.anyQuery ? { ...base, kind: "query_any" } : { ...base, kind: "query_param", params: draftParams(d) };
		default:
			return { ...base, kind: "custom", path: d.pattern.trim() ? norm(d.pattern) : "", ...withExcept };
	}
}

/** A draft that edits an existing rule (anything the plain choices can't show opens as Advanced). */
export function ruleToDraft(rule: RobotsRule): Draft {
	const d = blankDraft(rule.id);
	d.enabled = rule.enabled;
	d.action = rule.directive === "allow" && rule.kind !== "allow_exception" ? "allow" : "block";
	d.name = rule.name;
	d.description = rule.description ?? "";
	d.nameTouched = true;
	d.descriptionTouched = Boolean(rule.description);
	d.except = [...(rule.except ?? [])];
	const path = rule.path ?? "";
	switch (rule.kind) {
		case "entire_site":
			d.area = "everything";
			break;
		case "folder":
			d.area = "section";
			d.section = path;
			d.anyDepth = Boolean(rule.anyDepth);
			break;
		case "allow_exception":
			d.area = "section";
			d.section = path;
			if (rule.allow) d.except = [rule.allow, ...d.except];
			break;
		case "single_page":
			d.area = "page";
			d.page = path;
			d.exact = Boolean(rule.strict);
			break;
		case "exact_url":
			d.area = "page";
			d.page = path;
			d.exact = true;
			break;
		case "filetype":
		case "filetype_in_folder": {
			d.area = "files";
			const exts = ruleExts(rule);
			const chips = FILE_TYPES.filter((f) => f.exts.every((e) => exts.includes(e)));
			const covered = new Set(chips.flatMap((c) => c.exts));
			d.fileTypes = chips.map((c) => c.id);
			d.otherExt = exts.filter((e) => !covered.has(e)).join(", ");
			d.filesIn = rule.kind === "filetype_in_folder" ? path : "";
			break;
		}
		case "query_any":
			d.area = "params";
			d.anyQuery = true;
			break;
		case "query_param": {
			d.area = "params";
			const names = ruleParams(rule);
			const chips = PARAMS.filter((p) => p.names.every((n) => names.includes(n)));
			const covered = new Set(chips.flatMap((c) => c.names));
			d.params = chips.map((c) => c.id);
			d.otherParam = names.filter((n) => !covered.has(n)).join(", ");
			break;
		}
		default: {
			d.area = "advanced";
			const lines = directives({ ...rule, except: [] });
			d.pattern = lines[0]?.value ?? path;
		}
	}
	if (rule.agents.length === 1 && rule.agents[0] === "*") d.who = "everyone";
	else {
		const group = (rule.group && CRAWLER_GROUPS.find((g) => g.id === rule.group)) || matchGroup(rule.agents);
		if (group && rule.group === group.id) d.who = group.id as Who;
		else {
			d.who = "specific";
			d.agents = [...rule.agents];
		}
	}
	return d;
}

export interface Reading {
	area: Area;
	value: string;
	/** "We read this as: the /recipes/ section" */
	message: string;
	notes: string[];
}

/** Read a pasted address or path and suggest the plain choice that fits it. */
export function inferInput(input: string, siteUrl = "", sections: string[] = []): Reading | null {
	const raw = input.trim();
	if (!raw) return null;
	const { value, notes } = normalizePathInput(raw, siteUrl);
	if (/[*$]/.test(value)) return { area: "advanced", value, message: `“${value}” is a pattern (* means anything, $ means the address ends there), so it's set up as an advanced pattern.`, notes };
	if (value === "/") return { area: "everything", value, message: "That's your home page address, which covers the whole site.", notes };
	const q = value.indexOf("?");
	if (q !== -1) {
		const name = value.slice(q + 1).split(/[=&]/)[0];
		if (name) return { area: "params", value: name, message: `That address has a ?${name}= parameter. Do you mean links with that parameter?`, notes };
	}
	const ext = /\/[^/]+\.([A-Za-z0-9]{1,8})$/.exec(value)?.[1];
	if (ext && !/^html?$/i.test(ext)) return { area: "page", value, message: `We read this as one ${ext.toUpperCase()} file. To cover every .${ext.toLowerCase()} file, pick “A kind of file”.`, notes };
	const known = sections.find((s) => value === s || `${value}/` === s);
	if (value.endsWith("/") || known) {
		const folder = known ?? value;
		return { area: "section", value: folder, message: `We read this as the ${folder} section and everything in it.`, notes };
	}
	return { area: "page", value, message: `We read this as the page ${value}.`, notes };
}

/** Example addresses a rule matches and nearby ones it doesn't, from the real matcher. */
export function matchExamples(rule: RobotsRule): { matches: string[]; misses: string[] } {
	let lines: ReturnType<typeof directives>;
	try {
		lines = directives(rule).filter((l) => l.directive === (rule.directive === "allow" ? "Allow" : "Disallow"));
	} catch {
		return { matches: [], misses: [] };
	}
	const exceptions = rule.directive === "disallow" ? directives(rule).filter((l) => l.directive === "Allow") : [];
	const hit = (p: string) => lines.some((l) => matchRaw(l.value, p)) && !exceptions.some((l) => matchRaw(l.value, p));
	const matches = [...new Set(lines.flatMap((l) => samplePaths(l.value)))].filter(hit).slice(0, 4);
	const near = new Set<string>();
	for (const e of exceptions) for (const p of samplePaths(e.value).slice(0, 1)) near.add(p);
	for (const l of lines) {
		const literal = l.value.replace(/\$$/, "").replace(/\*/g, "");
		const trimmed = literal.replace(/\/$/, "");
		if (trimmed) {
			near.add(trimmed);
			near.add(`${trimmed}-index/`);
			near.add(`/other${literal.startsWith("/") ? literal : `/${literal}`}`);
			near.add(`${literal}x`.replace(/^([^/])/, "/$1"));
			near.add(`${trimmed.toUpperCase()}/`);
		}
		near.add(`${literal || "/"}?page=2`.replace(/^([^/])/, "/$1"));
	}
	near.add("/");
	near.add("/blog/a-post/");
	near.add("/file.pdf?download=1");
	const misses = [...near].filter((p) => p.startsWith("/") && !p.startsWith("//") && !hit(p) && !matches.includes(p)).slice(0, 3);
	return { matches, misses };
}
