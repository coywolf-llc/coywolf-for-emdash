/**
 * Turn imported WordPress blocks into native Coywolf Pack blocks, in stored
 * Portable Text. Reads:
 *
 * - markers written by the prepare step (./prepare.ts, ./markers.ts);
 * - wellbeing.io's `data-wb-block` markers (cloudflare-stream, review);
 * - what EmDash's importer makes of Coywolf blocks with saved HTML when the
 *   export wasn't prepared (`htmlBlock` with `originalBlockName` and
 *   `originalAttrs`: coywolf/video, coywolf/file).
 *
 * Produces `coywolf-video`, `coywolf-review`, `coywolf-toc` and
 * `coywolf-file` blocks, moves "anchor" markers onto the next heading's
 * `anchor` field, and maps Prism language names on code blocks to the
 * editor's (markup → html). Template markers (blockquote, sidenote, …) stay
 * HTML blocks. Anything else is left exactly as it is, and running it again
 * changes nothing.
 *
 * Pure, no I/O.
 */
import { type Marker, parseMarker } from "./markers.js";
import { type StreamEmbed, decodeHtml, textOf } from "./stream.js";

/** Video Manager's site-wide defaults (WordPress option coywolf_cvm_settings). Blocks without a value used these. */
export interface VideoDefaults {
	controls: boolean;
	autoplay: boolean;
	loop: boolean;
	mute: boolean;
	preload: "auto" | "metadata" | "none";
	showName: boolean;
	showDescription: boolean;
	showDate: boolean;
	showPlays: boolean;
	showLikes: boolean;
}

/** The Video Manager plugin's own defaults (also what coywolf.com uses). */
export const VIDEO_MANAGER_DEFAULTS: VideoDefaults = {
	controls: true,
	autoplay: false,
	loop: false,
	mute: false,
	preload: "metadata",
	showName: true,
	showDescription: true,
	showDate: true,
	showPlays: true,
	showLikes: true,
};

/** Coywolf Files' card defaults (WordPress option coywolf_files_settings). */
export interface FileDefaults {
	showIcon: boolean;
	showDescription: boolean;
	showMeta: boolean;
	showDownload: boolean;
	showCopyLink: boolean;
}

export const FILES_DEFAULTS: FileDefaults = { showIcon: true, showDescription: true, showMeta: true, showDownload: true, showCopyLink: true };

export interface ConvertOptions {
	videoDefaults?: Partial<VideoDefaults>;
	fileDefaults?: Partial<FileDefaults>;
	/** Key generator for new blocks (defaults to a random one). */
	key?: () => string;
}

/** Facts about a video learned from WordPress, for the Videos module's per-video data. */
export interface VideoFact {
	uid: string;
	name?: string;
	duration?: number;
	created?: string;
	width?: number;
	height?: number;
	host?: string;
}

export interface Change {
	/** What it was: a marker name or WordPress block name. */
	from: string;
	/** What it became: a block type, "anchor", or "removed". */
	to: string;
	detail?: string;
}

export interface ConvertResult<T> {
	value: T;
	changed: boolean;
	changes: Change[];
	videos: VideoFact[];
	/** Imported blocks left as HTML, by original block or marker name (for the report). */
	leftovers: Record<string, number>;
}

type Block = Record<string, unknown> & { _type?: unknown; _key?: unknown };

const UID = /^[0-9a-f]{32}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const num = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function randomKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

// ── Videos ───────────────────────────────────────────────────────

const HEIGHT_FOR = (pct: number) => Math.round((1920 * pct) / 100);

/** Seconds from the cloudflare-stream block's hours / minutes / seconds fields. */
export function streamSeconds(a: Record<string, unknown>): number | undefined {
	const total = (num(a["cs-hours"]) ?? 0) * 3600 + (num(a["cs-minutes"]) ?? 0) * 60 + (num(a["cs-seconds"]) ?? 0);
	return total > 0 ? total : undefined;
}

function embedFields(embed: StreamEmbed | null | undefined, block: Block): void {
	if (!embed) return;
	block.controls = embed.controls;
	block.autoplay = embed.autoplay;
	block.loop = embed.loop;
	block.muted = embed.muted || embed.autoplay;
	if (embed.preload) block.preload = embed.preload;
	if (embed.posterTime !== null && embed.posterTime >= 0) block.posterTime = embed.posterTime;
	if (embed.startTime) block.startTime = embed.startTime;
	if (embed.maxWidth) {
		block.sizeMode = "maxwidth";
		block.maxWidth = embed.maxWidth;
	}
	if (embed.aspect) block.aspect = Math.round(embed.aspect * 1000) / 1000;
}

/** coywolf-custom-blocks/cloudflare-stream (+ its embed), a stand-alone embed, or a wellbeing marker → coywolf-video. */
function streamVideo(attrs: Record<string, unknown>, embed: StreamEmbed | null): { block: Block; fact: VideoFact } | null {
	const uid = (str(attrs["cs-id"]) || embed?.uid || "").toLowerCase();
	if (!UID.test(uid)) return null;
	const caption = embed?.caption ?? null;
	const block: Block = {
		_type: "coywolf-video",
		uid,
		preset: "standard",
		title: str(attrs["cs-name"]) || embed?.title || undefined,
		caption: caption ?? (str(attrs["cs-description"]) || undefined),
		showName: false,
		showDescription: Boolean(caption),
		showPlays: false,
		showLikes: false,
		showDate: false,
	};
	embedFields(embed, block);
	const host = embed?.host ?? (/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(str(attrs["cs-subdomain"])) ? str(attrs["cs-subdomain"]) : undefined);
	const fact: VideoFact = { uid, name: str(attrs["cs-name"]) || undefined, duration: streamSeconds(attrs) };
	if (embed?.aspect) {
		fact.width = 1920;
		fact.height = HEIGHT_FOR(embed.aspect);
	}
	if (host) fact.host = host;
	return { block, fact };
}

/** wellbeing.io's cloudflare-stream marker ({ id, host, aspect, name, description, seconds }): it played like a GIF. */
function wellbeingVideo(a: Record<string, unknown>): { block: Block; fact: VideoFact } | null {
	const uid = str(a.id).toLowerCase();
	if (!UID.test(uid)) return null;
	const aspect = num(a.aspect);
	const block: Block = { _type: "coywolf-video", uid, preset: "gif", title: str(a.name) || undefined, caption: str(a.description) || undefined };
	if (aspect) block.aspect = aspect;
	const fact: VideoFact = { uid, name: str(a.name) || undefined, duration: num(a.seconds) };
	if (aspect) {
		fact.width = 1920;
		fact.height = HEIGHT_FOR(aspect);
	}
	if (/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(str(a.host))) fact.host = str(a.host);
	return { block, fact };
}

/** Video Manager's coywolf/video → coywolf-video, applying the site defaults where the block had no value. */
function managerVideo(a: Record<string, unknown>, d: VideoDefaults): { block: Block; fact: VideoFact } | null {
	const uid = str(a.videoId).toLowerCase();
	if (!UID.test(uid)) return null;
	const autoplay = bool(a.autoplay) ?? d.autoplay;
	const preload = str(a.preload);
	const block: Block = {
		_type: "coywolf-video",
		uid,
		preset: "standard",
		title: str(a.videoName) || undefined,
		caption: textOf(str(a.videoDescription)) || undefined,
		controls: bool(a.controls) ?? d.controls,
		autoplay,
		loop: bool(a.loop) ?? d.loop,
		muted: (bool(a.mute) ?? d.mute) || autoplay,
		preload: preload === "auto" || preload === "none" || preload === "metadata" ? preload : d.preload,
		showName: bool(a.showName) ?? d.showName,
		showDescription: bool(a.showDescription) ?? d.showDescription,
		showDate: bool(a.showDate) ?? d.showDate,
		showPlays: bool(a.showPlays) ?? d.showPlays,
		showLikes: bool(a.enableLikes) ?? d.showLikes,
	};
	const posterTime = num(a.posterTime);
	if (posterTime && posterTime > 0) block.posterTime = posterTime;
	const startTime = num(a.startTime);
	if (startTime && startTime > 0) block.startTime = startTime;
	if (a.sizeMode === "maxwidth") {
		block.sizeMode = "maxwidth";
		block.maxWidth = num(a.maxWidth) ?? 800;
	}
	const ratio = num(a.aspectRatio);
	if (ratio && ratio > 0) block.aspect = Math.round(ratio * 100_000) / 1000;
	const fact: VideoFact = { uid, name: str(a.videoName) || undefined, duration: num(a.duration) };
	if (ratio && ratio > 0) {
		fact.width = 1920;
		fact.height = Math.round(1920 * ratio);
	}
	const uploaded = str(a.uploaded);
	if (uploaded && !Number.isNaN(Date.parse(uploaded))) fact.created = uploaded;
	return { block, fact };
}

// ── Reviews ──────────────────────────────────────────────────────

/** Text of each <li> (or line) in a WordPress list field. */
export function listItems(html: unknown): string[] {
	if (typeof html !== "string" || !html.trim()) return [];
	const source = html.slice(0, 50_000);
	const items = [...source.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<\/li\s*>|<li\b|<\/[uo]l\s*>|$)/gi)].map((m) => textOf(m[1] as string));
	const list = items.length ? items : source.split(/<br\s*\/?>|<\/p\s*>|\n/i).map((t) => textOf(t));
	return list.filter(Boolean);
}

const SCHEMA_TYPES: Record<string, string> = { product: "Product", software: "SoftwareApplication", softwareapplication: "SoftwareApplication", book: "Book" };

/** `"macOS","Windows"` (the WordPress field held a JSON array body) → "macOS, Windows". */
export function operatingSystems(value: unknown): string {
	const text = str(value);
	if (!text) return "";
	try {
		const list = JSON.parse(`[${text}]`) as unknown;
		if (Array.isArray(list)) return list.map((v) => str(v)).filter(Boolean).join(", ");
	} catch {
		// Not JSON: use it as written.
	}
	return text.replace(/"/g, "").replace(/\s*,\s*/g, ", ");
}

/** Coywolf Custom Blocks' review (or wellbeing's review marker) → coywolf-review. */
export function reviewBlock(a: Record<string, unknown>): Block | null {
	const name = textOf(str(a.name));
	if (!name && !str(a.rating)) return null;
	const explicit = SCHEMA_TYPES[str(a["schema-type"]).toLowerCase()];
	const isBook = Boolean(str(a.author) || str(a.isbn) || str(a.publisher) || str(a.genre));
	const isSoftware = Boolean(operatingSystems(a.os) || str(a.category));
	// WordPress picked the type from the post's category when the field was left at its default.
	const itemType = explicit && explicit !== "Product" ? explicit : isBook ? "Book" : isSoftware ? "SoftwareApplication" : "Product";
	const block: Block = {
		_type: "coywolf-review",
		itemName: name,
		itemType,
		rating: str(a.rating),
		pros: listItems(a.strengths).join("\n"),
		cons: listItems(a.shortcomings).join("\n"),
		headingLevel: "2",
	};
	const brand = textOf(str(a.brand));
	if (brand) block.brand = brand;
	const url = str(a.id) || str(a.url);
	if (/^https?:\/\/\S+$/i.test(url)) block.itemUrl = url;
	if (itemType === "Book") {
		if (str(a.author)) block.bookAuthor = textOf(str(a.author));
		if (str(a.isbn)) block.isbn = str(a.isbn);
		if (str(a.publisher)) block.bookPublisher = textOf(str(a.publisher));
		if (str(a.genre)) block.genre = textOf(str(a.genre));
		if (num(a.copyright)) block.copyrightYear = String(num(a.copyright));
	}
	if (itemType === "SoftwareApplication") {
		const os = operatingSystems(a.os);
		if (os) block.operatingSystem = os;
		if (str(a.category)) block.applicationCategory = textOf(str(a.category));
	}
	return block;
}

// ── Table of contents ────────────────────────────────────────────

/** Coywolf SEO's table-of-contents attributes → coywolf-toc (WordPress defaults made explicit). */
export function tocBlock(a: Record<string, unknown>): Block {
	const levels = Array.isArray(a.levels) ? a.levels.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 2 && n <= 6) : [];
	const style = str(a.listStyle);
	const block: Block = {
		_type: "coywolf-toc",
		levels: (levels.length ? levels : [2, 3]).map(String),
		listStyle: style === "disc" ? "bulleted" : style === "decimal" ? "numbered" : "none",
		display: a.initiallyCollapsed === true ? "collapsed" : a.collapsible === true ? "collapsible" : "open",
		showTitle: a.showTitle === false ? "hide" : "show",
	};
	const title = textOf(str(a.title));
	if (title) block.title = title;
	return block;
}

// ── Files ────────────────────────────────────────────────────────

/** Coywolf Files' coywolf/file → coywolf-file. The id stays the WordPress file id (see the README for moving the file). */
export function fileBlock(a: Record<string, unknown>, d: FileDefaults): Block | null {
	const id = str(a.fileId);
	if (!/^[0-9a-z]{6,40}$/i.test(id)) return null;
	const block: Block = {
		_type: "coywolf-file",
		id,
		showIcon: bool(a.showIcon) ?? d.showIcon,
		showDescription: bool(a.showDescription) ?? d.showDescription,
		showMeta: bool(a.showMeta) ?? d.showMeta,
		showDownload: bool(a.showDownload) ?? d.showDownload,
		showCopyLink: bool(a.showCopyLink) ?? d.showCopyLink,
	};
	const title = textOf(str(a.title));
	if (title) block.title = title;
	const description = textOf(str(a.description));
	if (description) block.description = description;
	return block;
}

// ── Walking ──────────────────────────────────────────────────────

/** Prism names (Code Block Enhancer) the editor's language list spells differently. */
const PRISM_LANGUAGES: Record<string, string> = { markup: "html", svg: "xml", mathml: "xml" };

const isHeading = (b: Block) => b._type === "block" && typeof b.style === "string" && /^h[1-6]$/.test(b.style);
const validAnchor = (id: string) => id.length <= 120 && /^[\p{L}][\p{L}\p{N}_-]*$/u.test(id);

interface Walk {
	opts: Required<Pick<ConvertOptions, "key">> & { videoDefaults: VideoDefaults; fileDefaults: FileDefaults };
	changes: Change[];
	videos: VideoFact[];
	leftovers: Record<string, number>;
}

/** The native block for an imported HTML block, or undefined to leave it. `null` removes it. */
function convertHtmlBlock(block: Block, w: Walk): Block | null | undefined | { anchor: string } {
	const marker: Marker | null = parseMarker(block.html);
	const original = typeof block.originalBlockName === "string" ? block.originalBlockName : null;
	const originalAttrs = (block.originalAttrs && typeof block.originalAttrs === "object" ? block.originalAttrs : null) as Record<string, unknown> | null;
	const name = marker ? (marker.source === "wellbeing" ? `wb:${marker.name}` : marker.name) : original === "coywolf/video" ? "video" : original === "coywolf/file" ? "file" : null;
	const attrs = marker?.attrs ?? originalAttrs ?? {};
	if (!name) {
		if (original && original !== "core/html") w.leftovers[original] = (w.leftovers[original] ?? 0) + 1;
		return undefined;
	}
	const video = (made: { block: Block; fact: VideoFact } | null) => {
		if (!made) return undefined;
		w.videos.push(made.fact);
		return made.block;
	};
	switch (name) {
		case "cloudflare-stream":
			return video(streamVideo(attrs, (attrs.embed as StreamEmbed | null) ?? null));
		case "stream-embed":
			return video(streamVideo({}, (attrs.embed as StreamEmbed | null) ?? null));
		case "wb:cloudflare-stream":
			return video(wellbeingVideo(attrs));
		case "video":
			return video(managerVideo(attrs, w.opts.videoDefaults));
		case "review":
		case "wb:review":
			return reviewBlock(attrs) ?? undefined;
		case "toc":
			return tocBlock(attrs);
		case "file":
			return fileBlock(attrs, w.opts.fileDefaults) ?? undefined;
		case "anchor": {
			const id = decodeHtml(str(attrs.id));
			return validAnchor(id) ? { anchor: id } : null;
		}
		default:
			w.leftovers[`marker:${name}`] = (w.leftovers[`marker:${name}`] ?? 0) + 1;
			return undefined;
	}
}

function convertArray(blocks: unknown[], w: Walk, depth: number): unknown[] | null {
	let out: unknown[] | null = null;
	let pendingAnchor: string | null = null;
	const set = (i: number, value: unknown) => {
		out ??= blocks.slice();
		out[i] = value;
	};
	const REMOVE = Symbol("remove");
	for (let i = 0; i < blocks.length; i++) {
		const item = blocks[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			if (Array.isArray(item)) {
				const inner = convertArray(item, w, depth + 1);
				if (inner) set(i, inner);
			}
			continue;
		}
		const block = item as Block;
		if (block._type === "htmlBlock") {
			const result = convertHtmlBlock(block, w);
			if (result === undefined) continue;
			const from = parseMarker(block.html)?.name ?? String(block.originalBlockName ?? "htmlBlock");
			if (result === null) {
				set(i, REMOVE);
				w.changes.push({ from, to: "removed" });
				continue;
			}
			if ("anchor" in result && typeof result.anchor === "string") {
				pendingAnchor = result.anchor;
				set(i, REMOVE);
				continue;
			}
			const next: Block = { ...(result as Block), _key: typeof block._key === "string" ? block._key : w.opts.key() };
			for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
			set(i, next);
			w.changes.push({ from, to: String(next._type), detail: String(next.uid ?? next.itemName ?? next.id ?? "") || undefined });
			continue;
		}
		if (isHeading(block)) {
			if (pendingAnchor) {
				if (block.anchor !== pendingAnchor) {
					set(i, { ...block, anchor: pendingAnchor });
					w.changes.push({ from: "anchor", to: "heading", detail: pendingAnchor });
				}
				pendingAnchor = null;
			}
			continue;
		}
		if (block._type === "code" && typeof block.language === "string") {
			const lang = PRISM_LANGUAGES[block.language.toLowerCase()];
			if (lang) {
				set(i, { ...block, language: lang });
				w.changes.push({ from: `code:${block.language}`, to: `code:${lang}` });
			}
			continue;
		}
		if (depth < 8) {
			// Nested Portable Text (columns, covers, custom blocks with content arrays).
			let patched: Block | null = null;
			for (const [k, v] of Object.entries(block)) {
				if (!Array.isArray(v) || !v.length) continue;
				const inner = convertArray(v, w, depth + 1);
				if (inner) {
					patched ??= { ...block };
					patched[k] = inner;
				}
			}
			if (patched) set(i, patched);
		}
	}
	// An anchor marker with no heading after it: it was removed (nothing to attach to).
	if (!out) return null;
	return (out as unknown[]).filter((b) => b !== REMOVE);
}

/** An array that looks like Portable Text. */
function isPortableText(value: unknown): value is unknown[] {
	return Array.isArray(value) && value.length > 0 && value.every((b) => b && typeof b === "object" && typeof (b as { _type?: unknown })._type === "string");
}

function walkFor(opts: ConvertOptions): Walk {
	return {
		opts: {
			key: opts.key ?? randomKey,
			videoDefaults: { ...VIDEO_MANAGER_DEFAULTS, ...opts.videoDefaults },
			fileDefaults: { ...FILES_DEFAULTS, ...opts.fileDefaults },
		},
		changes: [],
		videos: [],
		leftovers: {},
	};
}

/** Convert one Portable Text array. */
export function convertPortableText(blocks: unknown[], opts: ConvertOptions = {}): ConvertResult<unknown[]> {
	const w = walkFor(opts);
	const out = convertArray(blocks, w, 0);
	return { value: out ?? blocks, changed: Boolean(out), changes: w.changes, videos: w.videos, leftovers: w.leftovers };
}

/** Convert every Portable Text field of an entry's data. */
export function convertEntryData(data: Record<string, unknown>, opts: ConvertOptions = {}): ConvertResult<Record<string, unknown>> {
	const w = walkFor(opts);
	let out: Record<string, unknown> | null = null;
	for (const [field, value] of Object.entries(data)) {
		if (!isPortableText(value)) continue;
		const next = convertArray(value, w, 0);
		if (next) {
			out ??= { ...data };
			out[field] = next;
		}
	}
	return { value: out ?? data, changed: Boolean(out), changes: w.changes, videos: w.videos, leftovers: w.leftovers };
}

/** Quick check before the full walk: does this data hold anything to convert? */
export function mightNeedConversion(data: unknown): boolean {
	const json = JSON.stringify(data ?? null);
	return /data-coywolf-wp=|data-wb-block=|"originalBlockName":"coywolf\/|"language":"(?:markup|svg|mathml)"/.test(json);
}
