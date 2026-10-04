/**
 * Link check results, ignore rules and the recheck schedule. Pure functions.
 */

export type LinkStatus = "unchecked" | "ok" | "redirect" | "broken" | "blocked" | "error";

export const STATUS_LABELS: Record<LinkStatus, string> = {
	unchecked: "Not checked",
	ok: "OK",
	redirect: "Redirect",
	broken: "Broken",
	blocked: "Blocked",
	error: "Error",
};

export interface Hop {
	url: string;
	code: number;
}

export interface CheckOutcome {
	status: LinkStatus;
	/** Final HTTP status (0 when there was no response). */
	code: number;
	/** Where the redirect chain ended, when it changed the URL. */
	finalUrl: string | null;
	chain: Hop[];
	/** Short reason shown in the admin. */
	note: string;
}

/** Status codes that mean "a bot wall answered", not "the page is gone". */
const BLOCKED_CODES = new Set([403, 429, 999]);

/** Response headers that identify a bot challenge (Cloudflare, AWS WAF, DataDome, PerimeterX, Akamai). */
export function isBotWall(code: number, headers: Headers | Record<string, string | undefined>): boolean {
	if (BLOCKED_CODES.has(code)) return true;
	const get = (name: string) => (headers instanceof Headers ? headers.get(name) : headers[name]) ?? "";
	if (/challenge/i.test(get("cf-mitigated"))) return true;
	if (get("x-amzn-waf-action") || get("x-datadome") || get("x-px-block")) return true;
	return false;
}

/** Same URL apart from a trailing slash. */
function sameUrl(a: string, b: string): boolean {
	return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Classify a finished request. `chain` lists every response, the last one
 * being final. `blocked` is whether the final response looked like a bot wall.
 */
export function classify(chain: Hop[], blocked: boolean, error?: string): CheckOutcome {
	const last = chain[chain.length - 1];
	if (!last || error) {
		return { status: "error", code: last?.code ?? 0, finalUrl: null, chain, note: error ?? "No response" };
	}
	const first = chain[0];
	const redirected = chain.length > 1 && !sameUrl(first.url, last.url);
	const finalUrl = redirected ? last.url : null;
	if (blocked) {
		return {
			status: "blocked",
			code: last.code,
			finalUrl,
			chain,
			note: `Blocked by the destination (HTTP ${last.code}). The link is likely fine but can't be verified from a server.`,
		};
	}
	if (last.code >= 400) {
		return {
			status: "broken",
			code: last.code,
			finalUrl,
			chain,
			note: redirected ? `Redirects (${first.code}) to a page that returns ${last.code}` : `HTTP ${last.code}`,
		};
	}
	if (last.code >= 300) {
		return { status: "error", code: last.code, finalUrl, chain, note: "Redirect without a usable Location" };
	}
	if (redirected) {
		return { status: "redirect", code: last.code, finalUrl, chain, note: `${first.code} → ${last.url}` };
	}
	return { status: "ok", code: last.code, finalUrl: null, chain, note: `HTTP ${last.code}` };
}

const DAY = 86_400_000;

/** When to check again: problems daily, everything else weekly. */
export function nextCheckAt(status: LinkStatus, now: number): string {
	const delay = status === "broken" || status === "error" ? DAY : 7 * DAY;
	return new Date(now + delay).toISOString();
}

// ── Ignore rules ─────────────────────────────────────────────────

export type IgnoreType = "domain" | "url" | "wildcard" | "regex";

export interface IgnoreRule {
	id: string;
	type: IgnoreType;
	value: string;
}

export class IgnoreRuleError extends Error {}

/** Normalize and validate a rule's value. Throws IgnoreRuleError. */
export function normalizeIgnore(type: IgnoreType, raw: string): string {
	const value = raw.trim();
	if (!value) throw new IgnoreRuleError("Enter a value.");
	if (value.length > 1024) throw new IgnoreRuleError("That rule is too long.");
	switch (type) {
		case "domain": {
			const host = value.includes("://") ? safeHost(value) : value.replace(/\/.*$/, "");
			const clean = host.toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
			if (!/^[a-z0-9.-]+\.[a-z0-9-]+$|^localhost$/.test(clean)) throw new IgnoreRuleError(`"${value}" isn't a domain.`);
			return clean;
		}
		case "url":
			return normalizeUrlForMatch(value) || value;
		case "wildcard":
			return value.replace(/\*+/g, "*");
		case "regex":
			if (value.length > 200) throw new IgnoreRuleError("Keep regular expressions under 200 characters, or use a wildcard rule.");
			// Repeated groups holding a quantifier or alternation, like (a+)+ or (a|ab)*, and backreferences can take exponential time.
			if (/\((?:[^()\\]|\\.)*[+*}|](?:[^()\\]|\\.)*\)\s*[+*{]|\\[1-9]/.test(value)) {
				throw new IgnoreRuleError("That regular expression could be very slow (nested repetition or a backreference). Simplify it or use a wildcard rule.");
			}
			try {
				new RegExp(value, "i");
			} catch {
				throw new IgnoreRuleError("That regular expression isn't valid.");
			}
			return value;
	}
}

function safeHost(value: string): string {
	try {
		return new URL(value).hostname;
	} catch {
		return value;
	}
}

/** scheme://host/path?query, lowercased scheme and host, no trailing slash, no fragment. */
export function normalizeUrlForMatch(url: string): string {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}${u.pathname.replace(/\/+$/, "")}${u.search}`;
	} catch {
		return "";
	}
}

const regexCache = new Map<string, RegExp | null>();
function compiled(pattern: string, wildcard: boolean): RegExp | null {
	const key = `${wildcard ? "w" : "r"}:${pattern}`;
	if (!regexCache.has(key)) {
		let re: RegExp | null = null;
		try {
			re = wildcard
				? new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i")
				: new RegExp(pattern, "i");
		} catch {
			re = null;
		}
		if (regexCache.size > 500) regexCache.clear();
		regexCache.set(key, re);
	}
	return regexCache.get(key) ?? null;
}

/** Whether a rule matches an absolute URL. */
export function ruleMatches(rule: IgnoreRule, absoluteUrl: string): boolean {
	switch (rule.type) {
		case "domain": {
			const host = safeHost(absoluteUrl).toLowerCase().replace(/^www\./, "");
			return host === rule.value || host.endsWith(`.${rule.value}`);
		}
		case "url":
			return normalizeUrlForMatch(absoluteUrl).toLowerCase() === rule.value.toLowerCase();
		case "wildcard":
			return absoluteUrl.length <= 2048 && (compiled(rule.value, true)?.test(absoluteUrl) ?? false);
		case "regex":
			// Stored rules were vetted by normalizeIgnore; still refuse anything that no longer passes.
			return absoluteUrl.length <= 2048 && rule.value.length <= 200 && (compiled(rule.value, false)?.test(absoluteUrl) ?? false);
	}
}

export function isIgnored(rules: IgnoreRule[], absoluteUrl: string): boolean {
	return rules.some((rule) => ruleMatches(rule, absoluteUrl));
}

// ── Safety ───────────────────────────────────────────────────────

/** Refuse to request loopback, private, link-local or metadata addresses. */
export function isPublicTarget(url: URL): boolean {
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a === 198 && (b === 18 || b === 19)) return false;
		return true;
	}
	if (host.includes(":")) {
		if (host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:")) return false;
		// NAT64 (64:ff9b::/96) embeds an IPv4 address.
		if (host.startsWith("64:ff9b:")) return false;
	}
	return true;
}
