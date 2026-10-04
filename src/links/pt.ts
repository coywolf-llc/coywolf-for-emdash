/**
 * Links in EmDash content: find them in Portable Text (link marks, linked
 * images, buttons, embeds, iframes, files) and URL fields, and rewrite them
 * without touching anything else. Pure functions; no I/O.
 *
 * Portable Text shapes (emdash/src/content/converters/types.ts):
 * - text block: { _type: "block", children: span[], markDefs: [{ _type: "link", _key, href, blank? }] }
 *   spans reference a link through `marks: [markDef._key]`
 * - table: markDefs on the table and on each tableCell, spans under `content`
 * - image: `link` is { href, blank? } or (WordPress imports) a bare string
 * - button: { _type: "button", url }, embed: { url }, iframe: { src }, file: { url }
 */

export type LinkKind = "text" | "image" | "button" | "embed" | "iframe" | "file" | "field" | "block";

export interface FoundLink {
	href: string;
	kind: LinkKind;
	/** Linked text for text links (empty otherwise). */
	anchor: string;
}

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: Json): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const SKIP_SCHEME = /^(?:mailto:|tel:|sms:|javascript:|data:|about:|blob:|file:|#)/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Whether an href points somewhere we can track (http(s), protocol-relative or relative). */
export function isTrackable(href: unknown): href is string {
	if (typeof href !== "string") return false;
	const h = href.trim();
	if (!h || h.length > 2048 || SKIP_SCHEME.test(h)) return false;
	if (HAS_SCHEME.test(h)) return /^https?:/i.test(h);
	return true;
}

/** Keys that hold a URL on non-text blocks, by block type. `asset` (media references) is never followed. */
const URL_KEYS = ["href", "url", "src", "link"] as const;

function blockKind(type: unknown, key: string): LinkKind {
	if (key === "link") return "image";
	switch (type) {
		case "button":
			return "button";
		case "iframe":
			return "iframe";
		case "file":
			return "file";
		case "embed":
			return "embed";
		default:
			return key === "src" || key === "url" ? "embed" : "block";
	}
}

function linkHref(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (isObj(value) && typeof value.href === "string") return value.href;
	return undefined;
}

/** Text of the spans under `node` that carry `markKey`. */
function anchorText(node: Json, markKey: string): string {
	const parts: string[] = [];
	const walk = (v: Json) => {
		if (Array.isArray(v)) {
			for (const item of v) walk(item);
			return;
		}
		if (!isObj(v)) return;
		if (v._type === "span") {
			if (Array.isArray(v.marks) && v.marks.includes(markKey) && typeof v.text === "string") parts.push(v.text);
			return;
		}
		for (const [k, child] of Object.entries(v)) if (k !== "markDefs" && k !== "asset") walk(child);
	};
	walk(node);
	return parts.join("").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Every trackable link in a Portable Text value (or any nested block structure). */
export function extractLinks(value: Json): FoundLink[] {
	const out: FoundLink[] = [];
	const walk = (v: Json) => {
		if (Array.isArray(v)) {
			for (const item of v) walk(item);
			return;
		}
		if (!isObj(v)) return;
		if (Array.isArray(v.markDefs)) {
			for (const def of v.markDefs) {
				if (isObj(def) && def._type === "link" && isTrackable(def.href)) {
					out.push({ href: def.href.trim(), kind: "text", anchor: anchorText(v, String(def._key ?? "")) });
				}
			}
		}
		if (v._type !== "span" && v._type !== "block") {
			for (const key of URL_KEYS) {
				const href = key === "link" ? linkHref(v[key]) : typeof v[key] === "string" ? (v[key] as string) : undefined;
				if (isTrackable(href)) out.push({ href: href.trim(), kind: blockKind(v._type, key), anchor: "" });
			}
		}
		for (const [k, child] of Object.entries(v)) {
			if (k === "markDefs" || k === "asset" || k === "link") continue;
			if (typeof child === "object" && child !== null) walk(child);
		}
	};
	walk(value);
	return out;
}

/** Links in an entry's data, given the fields to look at and their types. */
export function extractEntryLinks(data: Obj, fields: Array<{ slug: string; type: string }>): FoundLink[] {
	const out: FoundLink[] = [];
	for (const field of fields) {
		const value = data[field.slug];
		if (value == null) continue;
		if (field.type === "url") {
			if (isTrackable(value)) out.push({ href: value.trim(), kind: "field", anchor: "" });
		} else {
			out.push(...extractLinks(value));
		}
	}
	return out;
}

export type LinkEdit = { type: "replace"; to: string } | { type: "unlink" };

export interface TransformResult<T> {
	value: T;
	/** Links changed (replaced or unlinked). */
	changed: number;
	/** Matching links that couldn't be unlinked (an embed's or iframe's own URL). */
	skipped: number;
}

/** Remove `keys` from the marks of every span under `node`. Returns the same object when nothing changed. */
function stripMarks(node: Json, keys: Set<string>): Json {
	if (Array.isArray(node)) {
		let changed = false;
		const next = node.map((item) => {
			const n = stripMarks(item, keys);
			if (n !== item) changed = true;
			return n;
		});
		return changed ? next : node;
	}
	if (!isObj(node)) return node;
	if (node._type === "span") {
		if (!Array.isArray(node.marks) || !node.marks.some((m) => keys.has(m as string))) return node;
		return { ...node, marks: node.marks.filter((m) => !keys.has(m as string)) };
	}
	let next: Obj | null = null;
	for (const [k, child] of Object.entries(node)) {
		if (k === "markDefs" || k === "asset" || typeof child !== "object" || child === null) continue;
		const n = stripMarks(child, keys);
		if (n !== child) {
			next ??= { ...node };
			next[k] = n;
		}
	}
	return next ?? node;
}

/**
 * Replace or unlink every link whose href satisfies `match`. Never mutates
 * the input: changed objects are copied, unchanged subtrees are shared, and
 * other marks, keys and fields are kept as they were.
 */
export function transformLinks<T>(value: T, match: (href: string) => boolean, edit: LinkEdit): TransformResult<T> {
	let changed = 0;
	let skipped = 0;
	const hit = (href: unknown): boolean => typeof href === "string" && match(href.trim());

	const walk = (v: Json): Json => {
		if (Array.isArray(v)) {
			let any = false;
			const next = v.map((item) => {
				const n = walk(item);
				if (n !== item) any = true;
				return n;
			});
			return any ? next : v;
		}
		if (!isObj(v)) return v;

		let next: Obj | null = null;
		const set = (k: string, val: unknown) => {
			next ??= { ...v };
			next[k] = val;
		};
		const del = (k: string) => {
			next ??= { ...v };
			delete next[k];
		};

		// Children first, so mark stripping below sees the rewritten tree.
		for (const [k, child] of Object.entries(v)) {
			if (k === "markDefs" || k === "asset" || k === "link" || typeof child !== "object" || child === null) continue;
			const n = walk(child);
			if (n !== child) set(k, n);
		}

		if (Array.isArray(v.markDefs)) {
			const removed = new Set<string>();
			let defsChanged = false;
			const defs: unknown[] = [];
			for (const def of v.markDefs) {
				if (isObj(def) && def._type === "link" && hit(def.href)) {
					changed++;
					defsChanged = true;
					if (edit.type === "replace") defs.push({ ...def, href: edit.to });
					else removed.add(String(def._key ?? ""));
				} else {
					defs.push(def);
				}
			}
			if (defsChanged) {
				set("markDefs", defs);
				if (removed.size) {
					const current: Obj = next ?? v;
					const stripped = stripMarks({ ...current, markDefs: [] }, removed) as Obj;
					for (const [k, child] of Object.entries(stripped)) if (k !== "markDefs" && child !== current[k]) set(k, child);
				}
			}
		}

		if (v._type !== "span" && v._type !== "block") {
			for (const key of URL_KEYS) {
				const raw = v[key];
				const href = key === "link" ? linkHref(raw) : typeof raw === "string" ? raw : undefined;
				if (href === undefined || !hit(href)) continue;
				if (edit.type === "replace") {
					changed++;
					set(key, key === "link" && isObj(raw) ? { ...raw, href: edit.to } : edit.to);
				} else if (key === "link" || key === "href" || (key === "url" && v._type === "button")) {
					changed++;
					del(key);
				} else {
					skipped++;
				}
			}
		}
		return next ?? v;
	};

	return { value: walk(value) as T, changed, skipped };
}

/** Apply an edit to the given fields of an entry. Returns only the fields that changed. */
export function transformEntry(
	data: Obj,
	fields: Array<{ slug: string; type: string }>,
	match: (href: string) => boolean,
	edit: LinkEdit,
): { patch: Obj; changed: number; skipped: number } {
	const patch: Obj = {};
	let changed = 0;
	let skipped = 0;
	for (const field of fields) {
		const value = data[field.slug];
		if (value == null) continue;
		if (field.type === "url") {
			if (typeof value === "string" && isTrackable(value) && match(value.trim())) {
				if (edit.type === "replace") {
					patch[field.slug] = edit.to;
					changed++;
				} else skipped++;
			}
			continue;
		}
		const result = transformLinks(value, match, edit);
		changed += result.changed;
		skipped += result.skipped;
		if (result.value !== value) patch[field.slug] = result.value;
	}
	return { patch, changed, skipped };
}

// ── URLs ─────────────────────────────────────────────────────────

/** Resolve an href against the site. Returns null when it can't be checked. */
export function resolveHref(href: string, siteUrl: string): URL | null {
	try {
		const url = new URL(href.trim(), siteUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url;
	} catch {
		return null;
	}
}

/** Host without a leading "www.", lowercased. */
export function bareHost(host: string): string {
	return host.toLowerCase().replace(/^www\./, "");
}

export function isInternal(href: string, siteUrl: string): boolean {
	const url = resolveHref(href, siteUrl);
	if (!url) return false;
	try {
		return bareHost(url.hostname) === bareHost(new URL(siteUrl).hostname);
	} catch {
		return false;
	}
}
