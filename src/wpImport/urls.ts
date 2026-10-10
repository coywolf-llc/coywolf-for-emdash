/**
 * Old-site URLs left in imported content: `/wp-content/uploads/…` images and
 * files, theme and plugin assets. EmDash's importer rewrites the media URLs
 * it imported to the media library (1.2.0: image, gallery, column, cover,
 * file and button blocks, embeds and HTML blocks, links in text and tables,
 * and `-1024x683` sizes of an attachment's own file name), but not other
 * blocks' fields (a testimonial's photo, a video's poster), sizes of large
 * images whose attachment is the `-scaled` (or `-rotated`, edited) copy, or
 * files that were never media-library attachments. This finds every old-site
 * URL still in content (a generic scan, so what EmDash already rewrote just
 * isn't found), maps each to a media library file (size variants to their
 * original), lists what isn't in the library yet, rewrites content and builds
 * redirect rules.
 *
 * Pure, no imports: runs in the Worker, the admin (browser) and tests.
 */

export type SiteUrlKind = "uploads" | "themes" | "plugins";

export interface SiteInfo {
	/** `<wp:base_site_url>` (where WordPress is installed). */
	siteUrl: string;
	/** `<wp:base_blog_url>` (the home URL). */
	homeUrl: string;
	/** Lowercase host names of the old site, with and without `www.`. */
	hosts: string[];
	/** The folder WordPress is installed in ("/wp"), when it isn't the site root. */
	prefixes: string[];
}

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function text(body: string): string {
	if (!body.includes("<![CDATA[")) return body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	let out = "";
	for (const m of body.matchAll(CDATA)) out += m[1];
	return out;
}

const hostOf = (url: string): string | null => {
	try {
		return new URL(url.trim()).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
};

/** Host names with their `www.` twin. */
export function withWww(hosts: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const raw of hosts) {
		const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "");
		if (!host || !/^[a-z0-9.-]+$/.test(host)) continue;
		out.add(host);
		out.add(host.startsWith("www.") ? host.slice(4) : `www.${host}`);
	}
	return [...out];
}

/** The old site's URLs and host names, from the export's channel header. */
export function wxrSite(xml: string): SiteInfo {
	const head = xml.split(/<item>/)[0] ?? "";
	const tagText = (name: string) => {
		const m = head.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
		return m ? text(m[1] as string).trim() : "";
	};
	const siteUrl = tagText("wp:base_site_url");
	const homeUrl = tagText("wp:base_blog_url") || tagText("link");
	const hosts = [siteUrl, homeUrl, tagText("link")].map(hostOf).filter((h): h is string => Boolean(h));
	const prefixes = new Set<string>();
	for (const url of [siteUrl, homeUrl]) {
		try {
			const path = new URL(url).pathname.replace(/\/+$/, "");
			if (path && /^(?:\/[\w.~-]+){1,3}$/.test(path)) prefixes.add(path);
		} catch {
			// Not a URL.
		}
	}
	return { siteUrl, homeUrl, hosts: withWww(hosts), prefixes: [...prefixes] };
}

/** Host names typed by a person ("example.com, cdn.example.com" or full URLs). */
export function parseHosts(input: string): string[] {
	return withWww(input.split(/[\s,]+/).map((h) => hostOf(/^[a-z]+:\/\//i.test(h) ? h : `https://${h}`) ?? ""));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Characters a URL can hold here (stops at quotes, spaces, tags, brackets). */
const URL_CHARS = "[^\\s\"'<>()\\[\\]{}\\\\^`|]";

/**
 * A regex finding the old site's `/wp-content/(uploads|themes|plugins)/…`
 * URLs: absolute or protocol-relative on one of `hosts` (also through
 * Jetpack's i0–i3.wp.com image CDN), or site-relative, optionally under the
 * folder WordPress was installed in (`prefixes`, e.g. "/wp"). With
 * `hosts === null`, any host and any one-folder prefix match (used to rewrite
 * with a map, which holds only the old site's URLs anyway).
 */
export function siteUrlPattern(hosts: string[] | null, prefixes: string[] = []): RegExp {
	const host = hosts === null ? "[a-z0-9.-]+" : hosts.length ? `(?:${hosts.map(escape).join("|")})` : null;
	const origin = host ? `(?:(?:https?:)?\\/\\/(?:i[0-3]\\.wp\\.com\\/)?${host}(?::\\d+)?)?` : "";
	const prefix = hosts === null ? "(?:\\/[\\w.~-]+)?" : prefixes.length ? `(?:${prefixes.map(escape).join("|")})?` : "";
	return new RegExp(`(?<![\\w.\\-/])${origin}${prefix}\\/wp-content\\/(?:uploads|themes|plugins)\\/${URL_CHARS}+`, "gi");
}

/** Trailing punctuation that belongs to the prose, not the URL. */
const TRAILING = /[.,;:!?]+$/;

function scanString(value: string, re: RegExp, fn: (url: string) => string | undefined): string {
	if (!value.includes("/wp-content/")) return value;
	re.lastIndex = 0;
	return value.replace(re, (whole: string) => {
		const tail = whole.match(TRAILING)?.[0] ?? "";
		const url = tail ? whole.slice(0, -tail.length) : whole;
		const next = fn(url);
		return next === undefined ? whole : next + tail;
	});
}

/** Count every old-site URL in a value (deep: strings in objects and arrays). */
export function findSiteUrls(value: unknown, re: RegExp, into: Map<string, number> = new Map(), depth = 0): Map<string, number> {
	if (depth > 40) return into;
	if (typeof value === "string") {
		scanString(value, re, (url) => {
			into.set(url, (into.get(url) ?? 0) + 1);
			return undefined;
		});
	} else if (Array.isArray(value)) {
		for (const v of value) findSiteUrls(v, re, into, depth + 1);
	} else if (value && typeof value === "object") {
		for (const v of Object.values(value)) findSiteUrls(v, re, into, depth + 1);
	}
	return into;
}

/** Replace mapped URLs everywhere in a value. Returns the same value when nothing changed. */
export function rewriteSiteUrls<T>(value: T, map: Record<string, string>, re: RegExp = siteUrlPattern(null)): { value: T; count: number } {
	let count = 0;
	const walk = (v: unknown, depth: number): unknown => {
		if (depth > 40) return v;
		if (typeof v === "string") {
			const next = scanString(v, re, (url) => {
				const to = Object.hasOwn(map, url) ? map[url] : undefined;
				if (to === undefined || to === url) return undefined;
				count++;
				return to;
			});
			return next;
		}
		if (Array.isArray(v)) {
			let out: unknown[] | null = null;
			v.forEach((item, i) => {
				const next = walk(item, depth + 1);
				if (next !== item) {
					out ??= v.slice();
					out[i] = next;
				}
			});
			return out ?? v;
		}
		if (v && typeof v === "object") {
			let out: Record<string, unknown> | null = null;
			for (const [k, item] of Object.entries(v)) {
				const next = walk(item, depth + 1);
				if (next !== item) {
					out ??= { ...(v as Record<string, unknown>) };
					out[k] = next;
				}
			}
			return out ?? v;
		}
		return v;
	};
	const next = walk(value, 0) as T;
	return { value: next, count };
}

/** Scheme and host of an absolute or protocol-relative URL (through Jetpack's CDN too). */
const ORIGIN = /^(?:(https?):)?\/\/(?:i[0-3]\.wp\.com\/)?([^/?#]+)/i;

/**
 * Where to download a found URL from: its own origin (Jetpack CDN URLs from
 * the site behind it, without resize parameters), or `origin` for
 * site-relative URLs.
 */
export function sourceUrl(url: string, origin: string): string | null {
	const path = url.replace(ORIGIN, "").split(/[?#]/)[0] as string;
	if (!path.startsWith("/")) return null;
	const m = url.match(ORIGIN);
	if (m) return `${(m[1] ?? "https").toLowerCase()}://${m[2]}${path}`;
	try {
		return new URL(path, origin).toString();
	} catch {
		return null;
	}
}

/** Where a found URL points: its kind, the path on the old site (no query), and the folder and file name below the kind's folder. */
export function siteUrlParts(url: string): { kind: SiteUrlKind; path: string; dir: string; name: string } | null {
	const m = url.match(/\/wp-content\/(uploads|themes|plugins)\/([^?#]*)/i);
	if (!m) return null;
	let rest = m[2] as string;
	try {
		rest = decodeURIComponent(rest);
	} catch {
		// Keep it as written.
	}
	const parts = rest.split("/").filter(Boolean);
	const name = parts.pop() ?? "";
	if (!name) return null;
	const path = url.replace(ORIGIN, "").split(/[?#]/)[0] as string;
	return { kind: (m[1] as string).toLowerCase() as SiteUrlKind, path, dir: parts.join("/").toLowerCase(), name };
}

/**
 * The file name WordPress made a size variant from: strips `-300x200`,
 * `-scaled`, `-rotated` and image-editor suffixes (`-e1589912345678`), in any
 * order, and lowercases it. `photo-scaled.jpg`, `photo-1024x683.jpg` and
 * `photo.jpg` all give `photo.jpg`.
 */
export function originalName(name: string): string {
	const dot = name.lastIndexOf(".");
	let stem = (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
	const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
	for (let i = 0; i < 6; i++) {
		const next = stem.replace(/-\d+x\d+$/, "").replace(/-(?:scaled|rotated)$/, "").replace(/-e\d{10,}$/, "");
		if (next === stem || !next) break;
		stem = next;
	}
	return stem + ext;
}

/** A media library item as EmDash's media API lists it. */
export interface MediaFile {
	id: string;
	filename: string;
	url: string;
	storageKey?: string;
}

export interface SiteUrlPlan {
	url: string;
	kind: SiteUrlKind;
	/** The path on the old site (no host or query), for a redirect. */
	path: string;
	/** Times it appears in content (0 for an attachment not used in content). */
	count: number;
	/** matched: in the media library; missing: not there yet (import it from the old site); ambiguous: several files fit. */
	status: "matched" | "missing" | "ambiguous";
	/** The media library URL. */
	target?: string;
	/** How it was matched or why not. */
	note?: string;
}

/**
 * Map old-site URLs to media library files. `attachments` are the export's
 * attachment URLs (`wp:attachment_url`): an uploads URL whose original is an
 * attachment maps to the media file imported from it (by file name); one that
 * wasn't an attachment is "missing" (import it from the old site) unless
 * `known` has it (files imported in this session). Without attachments,
 * uploads URLs match by original file name when exactly one media file has it.
 * Theme and plugin files are matched only through `known`.
 */
export function planSiteUrls(
	found: Iterable<[string, number]>,
	media: MediaFile[],
	attachments: Iterable<string> | null,
	known: Record<string, string> = {},
): SiteUrlPlan[] {
	const byName = new Map<string, MediaFile[]>();
	const byOriginal = new Map<string, MediaFile[]>();
	const add = (map: Map<string, MediaFile[]>, key: string, file: MediaFile) => {
		const list = map.get(key);
		if (list) list.push(file);
		else map.set(key, [file]);
	};
	for (const file of media) {
		add(byName, file.filename.toLowerCase(), file);
		add(byOriginal, originalName(file.filename), file);
	}
	// "2020/05/photo.jpg" (original) → the attachment's own file name ("photo-scaled.jpg").
	const attachmentFile = new Map<string, string>();
	if (attachments) {
		for (const url of attachments) {
			const p = siteUrlParts(url);
			if (p?.kind === "uploads") attachmentFile.set(`${p.dir}/${originalName(p.name)}`, p.name.toLowerCase());
		}
	}
	const pick = (list: MediaFile[] | undefined): MediaFile | "ambiguous" | null => {
		if (!list?.length) return null;
		const urls = new Set(list.map((f) => f.url));
		return urls.size === 1 ? (list[0] as MediaFile) : "ambiguous";
	};
	const plans: SiteUrlPlan[] = [];
	for (const [url, count] of found) {
		const parts = siteUrlParts(url);
		if (!parts) continue;
		const plan: SiteUrlPlan = { url, kind: parts.kind, path: parts.path, count, status: "missing" };
		const knownTarget = known[url] ?? known[parts.path];
		if (knownTarget) {
			plan.status = "matched";
			plan.target = knownTarget;
			plan.note = "Imported";
		} else if (parts.kind !== "uploads") {
			plan.note = parts.kind === "themes" ? "Theme file" : "Plugin file";
		} else {
			const original = originalName(parts.name);
			let hit: MediaFile | "ambiguous" | null = null;
			if (attachments) {
				const file = attachmentFile.get(`${parts.dir}/${original}`);
				if (file) {
					hit = pick(byName.get(file)) ?? pick(byOriginal.get(original));
					plan.note = file === parts.name.toLowerCase() ? "Attachment" : `Size of ${file}`;
				} else {
					plan.note = "Not a media-library attachment";
				}
			} else {
				hit = pick(byOriginal.get(original));
				plan.note = "By file name";
			}
			if (hit === "ambiguous") {
				plan.status = "ambiguous";
				plan.note = `Several media files are named ${original}`;
			} else if (hit) {
				plan.status = "matched";
				plan.target = hit.url;
			} else if (plan.note !== "Not a media-library attachment") {
				plan.note = `${plan.note}: not in the media library`;
			}
		}
		plans.push(plan);
	}
	return plans.sort((a, b) => a.path.localeCompare(b.path) || a.url.localeCompare(b.url));
}

/** URL → media URL for every matched plan, to rewrite content with. */
export function rewriteMap(plans: SiteUrlPlan[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const p of plans) if (p.status === "matched" && p.target && p.target !== p.url) map[p.url] = p.target;
	return map;
}

/** Redirect rules (Redirects module import format) from each old path to its media file. */
export function uploadRedirects(plans: SiteUrlPlan[]): Array<{ source: string; target: string; type: number; isRegex: boolean; note: string }> {
	const out = new Map<string, { source: string; target: string; type: number; isRegex: boolean; note: string }>();
	for (const p of plans) {
		if (p.status !== "matched" || !p.target || out.has(p.path)) continue;
		if (!/^(?:\/[\w.~-]+)*\/wp-content\/[^\s?#]+$/i.test(p.path)) continue;
		out.set(p.path, { source: p.path, target: p.target, type: 301, isRegex: false, note: "WordPress media" });
	}
	return [...out.values()];
}
