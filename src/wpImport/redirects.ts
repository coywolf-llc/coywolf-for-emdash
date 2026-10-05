/**
 * WordPress redirects in the Redirects module's import format. WordPress
 * redirects a post's old slugs by itself (post meta `_wp_old_slug`), and
 * redirect plugins keep their rules in their own tables or options; none of
 * that comes over in an export. This reads:
 *
 * - `_wp_old_slug` from the export (wxrOldSlugRules);
 * - Redirection (`wp_redirection_items` rows), Rank Math
 *   (`wp_rank_math_redirections` rows), Yoast SEO Premium (the
 *   `wpseo-premium-redirects-base` option as JSON) and Coywolf SEO
 *   (`wp_coywolf_seo_redirects` rows), pasted from WP-CLI.
 *
 * Absolute targets on the old site become site paths. Rules the Redirects
 * module can't express (query-string sources, conditions on the referrer,
 * login state, …) are skipped with a reason.
 *
 * Pure, no imports: runs in the admin (browser), a Node script and tests.
 */
export interface WpRedirect {
	source: string;
	target: string;
	type: number;
	isRegex: boolean;
	note?: string;
}

export interface RedirectsResult {
	rules: WpRedirect[];
	skipped: Array<{ source: string; reason: string }>;
}

const TYPES = new Set([301, 302, 307, 308, 410]);

/** The Redirects module's type for a WordPress status code (303 → 302, 404/451 → 410 Gone, anything else → 301). */
export function redirectType(code: unknown): number {
	const n = Number(code);
	if (TYPES.has(n)) return n;
	if (n === 303) return 302;
	if (n === 404 || n === 451) return 410;
	return 301;
}

/** A target on the old site (absolute) as a site path; other targets as written. */
export function sitePath(target: string, hosts: string[]): string {
	const t = target.trim();
	if (!t) return "";
	const m = t.match(/^(?:https?:)?\/\/([^/?#]+)(.*)$/i);
	if (m && hosts.includes((m[1] as string).toLowerCase().replace(/:\d+$/, ""))) return (m[2] as string) || "/";
	if (/^https?:\/\//i.test(t) || t.startsWith("/")) return t;
	// Relative ("new-page/"), as Yoast and Rank Math store them.
	return `/${t}`;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const leadingSlash = (p: string) => (p.startsWith("/") ? p : `/${p}`);

/** A regex source matched against the path with a leading slash: `^old/(.*)` → `^/old/(.*)`. */
function anchorRegex(pattern: string): string {
	const p = pattern.trim();
	if (p.startsWith("^") && !p.startsWith("^/") && !p.startsWith("^\\/") && !p.startsWith("^(")) return `^/${p.slice(1)}`;
	return p;
}

function validRegex(source: string): boolean {
	try {
		new RegExp(source);
		return true;
	} catch {
		return false;
	}
}

/** Add a rule, or say why not. */
function push(out: RedirectsResult, rule: WpRedirect): void {
	const source = rule.source.trim();
	if (!source) return;
	if (rule.isRegex) {
		if (!validRegex(source)) {
			out.skipped.push({ source, reason: "The pattern isn't a valid JavaScript regular expression" });
			return;
		}
	} else {
		if (!source.startsWith("/") || source.startsWith("//")) {
			out.skipped.push({ source, reason: "The source isn't a site path" });
			return;
		}
		if (source.includes("?")) {
			out.skipped.push({ source, reason: "Sources with a query string aren't supported" });
			return;
		}
	}
	if (rule.type !== 410) {
		if (!rule.target) {
			out.skipped.push({ source, reason: "No destination" });
			return;
		}
		if (!rule.isRegex && rule.target.startsWith("/") && rule.target.split("?")[0]?.replace(/\/+$/, "") === source.replace(/\/+$/, "")) {
			out.skipped.push({ source, reason: "Redirects to itself" });
			return;
		}
	}
	out.rules.push({ ...rule, source, target: rule.type === 410 ? "" : rule.target });
}

// ── PHP serialize (Rank Math stores its sources serialized) ─────

/** A small reader for PHP's serialize() format: strings, numbers, booleans, null and arrays. Returns undefined when it can't read it. */
export function phpUnserialize(input: string): unknown {
	let i = 0;
	const bytes = new TextEncoder().encode(input);
	const decoder = new TextDecoder();
	const readUntil = (ch: string) => {
		const code = ch.charCodeAt(0);
		const start = i;
		while (i < bytes.length && bytes[i] !== code) i++;
		if (i >= bytes.length) throw new Error("Unexpected end");
		const out = decoder.decode(bytes.slice(start, i));
		i++;
		return out;
	};
	const expect = (ch: string) => {
		if (bytes[i] !== ch.charCodeAt(0)) throw new Error(`Expected ${ch}`);
		i++;
	};
	const read = (depth: number): unknown => {
		if (depth > 32) throw new Error("Too deep");
		const type = String.fromCharCode(bytes[i] as number);
		i++;
		if (type === "N") {
			expect(";");
			return null;
		}
		expect(":");
		switch (type) {
			case "b":
				return readUntil(";") === "1";
			case "i":
			case "d":
				return Number(readUntil(";"));
			case "s": {
				const len = Number(readUntil(":"));
				expect('"');
				const value = decoder.decode(bytes.slice(i, i + len));
				i += len;
				expect('"');
				expect(";");
				return value;
			}
			case "a": {
				const count = Number(readUntil(":"));
				expect("{");
				const entries: Array<[string | number, unknown]> = [];
				for (let n = 0; n < count; n++) {
					const key = read(depth + 1) as string | number;
					entries.push([key, read(depth + 1)]);
				}
				expect("}");
				const isList = entries.every(([k], n) => k === n);
				return isList ? entries.map(([, v]) => v) : Object.fromEntries(entries);
			}
			default:
				throw new Error(`Unsupported type ${type}`);
		}
	};
	try {
		const value = read(0);
		return i === bytes.length ? value : undefined;
	} catch {
		return undefined;
	}
}

// ── Plugins ──────────────────────────────────────────────────────

type Row = Record<string, string | number | null | undefined>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/**
 * Redirection plugin: rows of
 * `SELECT url, action_data, action_code, action_type, match_type, regex, status FROM wp_redirection_items`.
 */
export function redirectionRules(rows: Row[], hosts: string[] = []): RedirectsResult {
	const out: RedirectsResult = { rules: [], skipped: [] };
	for (const row of rows) {
		const source = s(row.url);
		if (!source) continue;
		if (s(row.status) && s(row.status) !== "enabled") continue;
		const matchType = s(row.match_type) || "url";
		if (matchType !== "url") {
			out.skipped.push({ source, reason: `Redirection's “${matchType}” condition can't be expressed` });
			continue;
		}
		const action = s(row.action_type) || "url";
		const code = Number(s(row.action_code)) || 301;
		const isRegex = s(row.regex) === "1";
		if (action === "error") {
			if (code === 410 || code === 451) push(out, { source: isRegex ? anchorRegex(source) : leadingSlash(source), target: "", type: 410, isRegex, note: "Redirection" });
			else out.skipped.push({ source, reason: `Error ${code} (pages that 404 need no rule)` });
			continue;
		}
		if (action !== "url") {
			out.skipped.push({ source, reason: `Redirection's “${action}” action can't be expressed` });
			continue;
		}
		push(out, { source: isRegex ? anchorRegex(source) : leadingSlash(source), target: sitePath(s(row.action_data), hosts), type: redirectType(code), isRegex, note: "Redirection" });
	}
	return out;
}

/**
 * Rank Math: rows of
 * `SELECT sources, url_to, header_code, status FROM wp_rank_math_redirections`.
 * Each row can hold several sources (exact, start, end, contains or regex).
 */
export function rankMathRules(rows: Row[], hosts: string[] = []): RedirectsResult {
	const out: RedirectsResult = { rules: [], skipped: [] };
	for (const row of rows) {
		if (s(row.status) && s(row.status) !== "active") continue;
		const sources = phpUnserialize(s(row.sources));
		if (!Array.isArray(sources)) {
			out.skipped.push({ source: s(row.sources).slice(0, 80), reason: "Couldn't read the sources" });
			continue;
		}
		const type = redirectType(s(row.header_code) || 301);
		const target = type === 410 ? "" : sitePath(s(row.url_to), hosts);
		for (const src of sources) {
			if (!src || typeof src !== "object") continue;
			const pattern = s((src as Record<string, unknown>).pattern).replace(/^\/+/, "");
			const comparison = s((src as Record<string, unknown>).comparison) || "exact";
			if (!pattern) continue;
			const note = "Rank Math";
			if (comparison === "exact") push(out, { source: `/${pattern}`, target, type, isRegex: false, note });
			else if (comparison === "regex") push(out, { source: anchorRegex(s((src as Record<string, unknown>).pattern)), target, type, isRegex: true, note });
			else if (comparison === "start") push(out, { source: `^/${escapeRegex(pattern)}`, target, type, isRegex: true, note });
			else if (comparison === "end") push(out, { source: `${escapeRegex(pattern)}$`, target, type, isRegex: true, note });
			else if (comparison === "contains") push(out, { source: escapeRegex(pattern), target, type, isRegex: true, note });
			else out.skipped.push({ source: pattern, reason: `Unknown comparison “${comparison}”` });
		}
	}
	return out;
}

/** Yoast SEO Premium: `wp option get wpseo-premium-redirects-base --format=json` (a list of { origin, url, type, format }). */
export function yoastRules(value: unknown, hosts: string[] = []): RedirectsResult {
	const out: RedirectsResult = { rules: [], skipped: [] };
	const list = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const origin = s(r.origin);
		if (!origin) continue;
		const type = redirectType(r.type);
		const isRegex = s(r.format) === "regex";
		push(out, { source: isRegex ? anchorRegex(origin) : leadingSlash(origin), target: type === 410 ? "" : sitePath(s(r.url), hosts), type, isRegex, note: "Yoast" });
	}
	return out;
}

/** Coywolf SEO: rows of `SELECT source, target, type, is_regex FROM wp_coywolf_seo_redirects`. */
export function coywolfSeoRules(rows: Row[], hosts: string[] = []): RedirectsResult {
	const out: RedirectsResult = { rules: [], skipped: [] };
	for (const row of rows) {
		const source = s(row.source);
		if (!source) continue;
		const isRegex = s(row.is_regex) === "1";
		const type = redirectType(s(row.type) || 301);
		push(out, { source: isRegex ? source : leadingSlash(source), target: type === 410 ? "" : sitePath(s(row.target), hosts), type, isRegex, note: "Coywolf SEO" });
	}
	return out;
}

// ── Old slugs ────────────────────────────────────────────────────

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
function tag(item: string, name: string): string {
	const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	if (!m) return "";
	const body = m[1] as string;
	if (!body.includes("<![CDATA[")) return body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
	let out = "";
	for (const c of body.matchAll(CDATA)) out += c[1];
	return out.trim();
}

/** Every value of a meta key on an item (a key can repeat, as _wp_old_slug does). */
function metaValues(item: string, key: string): string[] {
	const out: string[] = [];
	for (const m of item.matchAll(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g)) {
		if (tag(m[1] as string, "wp:meta_key") === key) out.push(tag(m[1] as string, "wp:meta_value"));
	}
	return out;
}

const pathOf = (url: string): string | null => {
	try {
		return new URL(url).pathname;
	} catch {
		return null;
	}
};

const SKIP_TYPES = new Set(["attachment", "nav_menu_item", "revision", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "customize_changeset", "oembed_cache", "custom_css", "user_request"]);

/**
 * A redirect from each old slug (`_wp_old_slug`) of a published entry to its
 * current URL, both as WordPress built them: the entry's permalink in the
 * export (`<link>`) with its slug swapped for the old one. Old URLs that are
 * some other entry's current URL are skipped.
 */
export function wxrOldSlugRules(xml: string): RedirectsResult {
	const out: RedirectsResult = { rules: [], skipped: [] };
	const current = new Set<string>();
	const candidates: WpRedirect[] = [];
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		const type = tag(item, "wp:post_type");
		if (SKIP_TYPES.has(type) || tag(item, "wp:status") !== "publish") continue;
		const path = pathOf(tag(item, "link"));
		if (!path) continue;
		current.add(path.replace(/\/+$/, ""));
		if (!item.includes("_wp_old_slug")) continue;
		const slug = tag(item, "wp:post_name");
		const segments = path.split("/");
		const last = segments.length - (path.endsWith("/") ? 2 : 1);
		if (!slug || last < 1 || segments[last] !== slug) continue;
		for (const old of new Set(metaValues(item, "_wp_old_slug"))) {
			if (!old || old === slug || !/^[^/?#\s]+$/.test(old)) continue;
			const oldSegments = segments.slice();
			oldSegments[last] = old;
			candidates.push({ source: oldSegments.join("/"), target: path, type: 301, isRegex: false, note: "Old slug" });
		}
	}
	const seen = new Set<string>();
	for (const rule of candidates) {
		const key = rule.source.replace(/\/+$/, "");
		if (current.has(key)) {
			out.skipped.push({ source: rule.source, reason: "Another entry uses this URL now" });
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		push(out, rule);
	}
	return out;
}

/** Merge rule lists: the first rule for a source wins. */
export function mergeRedirects(...lists: WpRedirect[][]): WpRedirect[] {
	const out = new Map<string, WpRedirect>();
	for (const list of lists) {
		for (const rule of list) {
			const key = `${rule.isRegex ? "re:" : ""}${rule.isRegex ? rule.source : rule.source.replace(/\/+$/, "") || "/"}`;
			if (!out.has(key)) out.set(key, rule);
		}
	}
	return [...out.values()];
}
