/**
 * Pure R2 helpers: multipart part sizing, minimal XML reading, and the CORS
 * rules browser uploads need. No imports, so `node --test` can load this file.
 */

const MIN_PART = 8 * 1024 * 1024;
const MAX_PARTS = 10_000;

/** Equal-sized parts (R2 requires every part but the last to be the same size), in whole MiB. */
export function partSizeFor(size: number): number {
	const mib = 1024 * 1024;
	const needed = Math.ceil(size / MAX_PARTS);
	return Math.max(MIN_PART, Math.ceil(needed / mib) * mib);
}

export function xmlValue(xml: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match ? decodeXml(match[1]) : undefined;
}

export function xmlValues(xml: string, tag: string): string[] {
	return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => decodeXml(m[1]));
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

export function encodeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface CorsRule {
	origins: string[];
	methods: string[];
	headers: string[];
	expose: string[];
}

export function parseCors(xml: string): CorsRule[] {
	return xmlValues(xml, "CORSRule").map((rule) => ({
		origins: xmlValues(rule, "AllowedOrigin"),
		methods: xmlValues(rule, "AllowedMethod").map((m) => m.toUpperCase()),
		headers: xmlValues(rule, "AllowedHeader").map((h) => h.toLowerCase()),
		expose: xmlValues(rule, "ExposeHeader").map((h) => h.toLowerCase()),
	}));
}

function originMatches(pattern: string, origin: string): boolean {
	if (pattern === "*") return true;
	if (!pattern.includes("*")) return pattern.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase();
	const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
	return re.test(origin);
}

/** What's missing from the bucket's CORS rules for browser uploads from `origin`. Empty when it's fine. */
export function corsProblems(rules: CorsRule[], origin: string): string[] {
	if (!rules.length) return ["The bucket has no CORS policy."];
	const matching = rules.filter((r) => r.origins.some((o) => originMatches(o, origin)));
	if (!matching.length) return [`No CORS rule allows the origin ${origin}.`];
	const usable = matching.filter((r) => r.methods.includes("PUT"));
	if (!usable.length) return [`The CORS rule for ${origin} doesn't allow the PUT method.`];
	const problems: string[] = [];
	if (!usable.some((r) => r.headers.includes("*") || r.headers.includes("content-type")))
		problems.push('Allow the "Content-Type" header (or "*") in AllowedHeaders.');
	if (!usable.some((r) => r.expose.includes("etag"))) problems.push('Add "ETag" to ExposeHeaders, so the browser can read each part\'s ETag.');
	return problems;
}

/** The CORS policy to paste into the R2 dashboard (Settings → CORS Policy). */
export function corsPolicyFor(origin: string) {
	return [{ AllowedOrigins: [origin], AllowedMethods: ["PUT"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3600 }];
}
