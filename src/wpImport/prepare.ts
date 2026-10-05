/**
 * Prepare a WordPress export (WXR) for EmDash's importer.
 *
 * EmDash converts Gutenberg with @emdash-cms/gutenberg-to-portable-text,
 * which plugins can't extend: blocks it doesn't know become an `htmlBlock`
 * of the block's saved HTML, and self-closing blocks (which keep everything in
 * their attributes) are dropped. Heading ids are dropped too. This rewrites,
 * inside each post's content:
 *
 * For any WordPress site:
 *
 * - heading ids into "anchor" markers, so imported headings keep their ids and
 *   old #links keep working;
 * - reusable blocks (synced patterns, `core/block` with a `ref`) into the
 *   blocks they hold, from the export's `wp_block` items (EmDash would drop
 *   the reference);
 * - core Details blocks (EmDash would drop the summary) into markers that
 *   become Details blocks;
 * - WordPress's &#91; (and bold markup) inside code blocks, which would
 *   otherwise show up as literal text;
 * - Yoast's related links into Custom HTML with the markup WordPress
 *   rendered, so their content isn't lost;
 * - blocks with nothing to import (Gravity Forms) into empty markers a theme
 *   can find;
 * - and it counts other self-closing third-party blocks, which EmDash drops,
 *   so the report lists what to rebuild.
 *
 * For sites that used Coywolf's WordPress plugins (each only runs when the
 * block is in the content):
 *
 * - Coywolf blocks the pack has native blocks for (Cloudflare Stream videos and
 *   their embed HTML, Video Manager videos, reviews, tables of contents, file
 *   downloads) into marker HTML blocks (see ./markers.ts) that the pack's
 *   import hook turns into Coywolf Video, Coywolf Review, Table of Contents and
 *   File download blocks;
 * - Coywolf Custom Blocks that were templates: sidenotes and editor's notes,
 *   transcripts and accordions, and blockquotes into markers with their exact
 *   content, which become Note, Details and Quote blocks (Custom Blocks
 *   module); affiliate disclosures (ftc, amazon, plus any block named in
 *   `disclosureBlocks`) into markers that become Affiliate disclosure blocks;
 *   testimonials into markers that become
 *   Testimonial blocks; the podcast links block (it had no fields: the
 *   template printed the show's links) into a marker that becomes a Podcast
 *   links block using the site's links. Each marker also holds the HTML
 *   WordPress rendered (where it had content of its own), so the content shows
 *   even if it isn't converted.
 *
 * Everything else is left byte for byte. Pure (no imports beyond siblings), so
 * it runs in the admin (browser), a Node script, and tests.
 */
import { type GBlock, blockHtml, htmlBlock, parseBlocks, serializeBlocks } from "./gutenberg.js";
import { type GuestAuthor, wxrGuestAuthors } from "./guests.js";
import { escapeAttr, markerHtml, parseMarker } from "./markers.js";
import { type WxrCategory, type WxrPage, wxrCategories, wxrPages } from "./parents.js";
import { hasStreamPlayer, parseStreamEmbed } from "./stream.js";

export interface PrepareOptions {
	/** WordPress attachment id → URL (from the WXR), for testimonial headshots. */
	attachments?: Map<number, string>;
	/** Reusable block (`wp_block`) id → its content (from the WXR), to inline `core/block` references. */
	reusableBlocks?: Map<number, string>;
	/**
	 * More self-closing blocks that printed an affiliate disclosure (the site's
	 * wording) and become Affiliate disclosure blocks, e.g.
	 * `genesis-custom-blocks/disclosure` on coywolf.com. Coywolf Custom Blocks'
	 * ftc and amazon blocks always do.
	 */
	disclosureBlocks?: string[];
	/** Internal: how many reusable blocks deep this content is. */
	reusableDepth?: number;
}

/** How deep reusable blocks may nest inside each other. */
const MAX_REUSABLE_DEPTH = 5;

/** What happened to one kind of block. */
export type PrepareAction =
	| "video"
	| "video-embed"
	| "review"
	| "toc"
	| "file"
	| "anchor"
	| "note"
	| "details"
	| "quote"
	| "disclosure"
	| "testimonial"
	| "podcast"
	| "html"
	| "flag"
	| "code"
	| "removed"
	/** A reusable block's content took the reference's place. */
	| "inlined"
	/** A reusable block reference whose block isn't in the export (left as is; EmDash drops it). */
	| "missing"
	/** A self-closing block EmDash will drop (counted only; nothing changes). */
	| "dropped";

export interface PrepareCounts {
	/** `${wordpress block name} → ${action}` → count. */
	[key: string]: number;
}

export interface PrepareResult {
	content: string;
	counts: PrepareCounts;
	changed: boolean;
}

const WRAP = (html: string) => htmlBlock(html);

/** Coywolf Custom Blocks' transcript block's default Summary (not saved when left as is). */
export const TRANSCRIPT_SUMMARY = "Read the audio transcript";

/** Blocks that render nothing on WordPress and are removed. */
const REMOVE = new Set(["coywolf-custom-blocks/newsletter"]);
/** Affiliate disclosures: no content of their own (the theme printed the wording); they become Affiliate disclosure blocks. */
const DISCLOSURES = new Set(["coywolf-custom-blocks/ftc", "coywolf-custom-blocks/amazon"]);
/** Blocks kept as empty markers for the theme (their output came from the theme or another plugin). */
const FLAG: Record<string, string> = {
	"gravityforms/form": "gravity-form",
};

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Repair JSON-escaped HTML that lost its backslashes on the way into the database ("u003cpu003e" → "<p>"). */
export function repairUnicodeEscapes(html: string): string {
	if (!/u003[ce]/.test(html)) return html;
	return html.replace(/u00([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Wrap bare text (no block-level tags) in a paragraph. */
const asParagraphs = (html: string) => (/<(p|ul|ol|div|blockquote|figure|h[1-6]|table|pre)\b/i.test(html) ? html : `<p>${html}</p>`);

/** The custom blockquote's fields: the quote, who said it, and the URL from its ` cite="…"` field. */
export function blockquoteFields(attrs: Record<string, unknown>): { quote: string; cite: string; url: string } {
	return {
		quote: repairUnicodeEscapes(str(attrs["block-quote"])).trim(),
		cite: repairUnicodeEscapes(str(attrs["block-cite"])).trim(),
		// Some lost their backslashes: ` cite=u0022https://…u0022`.
		url: str(attrs["block-url"]).replace(/\\?u0022/g, '"').match(/cite\s*=\s*"([^"]*)"/)?.[1]?.trim() ?? "",
	};
}

function blockquoteHtml(f: { quote: string; cite: string; url: string }): string {
	return `<figure class="wp-custom-blockquote"><blockquote${f.url ? ` cite="${escapeAttr(f.url)}"` : ""}>${asParagraphs(f.quote)}</blockquote>${
		f.cite ? `<figcaption><cite>${f.cite}</cite></figcaption>` : ""
	}</figure>`;
}

function noteHtml(kind: "sidenote" | "editorsnote", text: string): string {
	const heading = kind === "sidenote" ? "&#x1F4CC; Sidenote" : "&#x1F4DD; Editor's Note";
	return `<aside class="sidenote${kind === "editorsnote" ? " editorsnote" : ""}"><h2>${heading}</h2>${asParagraphs(text.trim())}</aside>`;
}

function detailsHtml(summary: string, body: string, className: string): string {
	return `<details class="${className}"><summary>${summary}</summary><div class="${className}__body">${body}</div></details>`;
}

/**
 * A core Quote block's fields: its paragraphs (the quote) and its <cite> (who
 * said it). EmDash's own converter keeps only the citation, dropping the quote.
 */
export function coreQuoteFields(block: GBlock): { quote: string; cite: string; url: string } {
	const html = blockHtml(block).trim();
	const m = html.match(/^<blockquote\b([^>]*)>([\s\S]*)<\/blockquote>$/i);
	const inner = m?.[2] ?? html;
	// Only a <cite> directly inside the blockquote is its citation; one inside a paragraph
	// (a cited title) or a nested quote stays in the quote.
	const cites = directChildren(inner, "cite");
	let rest = inner;
	for (const c of [...cites].reverse()) rest = rest.slice(0, c.start) + rest.slice(c.end);
	const cite = cites.length
		? cites
				.map((c) => c.inner.trim())
				.filter(Boolean)
				.join(", ")
		: typeof block.attrs.citation === "string"
			? block.attrs.citation
			: "";
	const quote = collapseBlockWhitespace(stripTagAttributes(rest, /^(?:class|id)$/i)).trim();
	const url = m?.[1]?.match(/\scite="([^"]*)"/i)?.[1]?.trim() ?? "";
	return { quote, cite: cite.trim(), url };
}

/** Elements without a closing tag. */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** A start or end tag, with quoted attribute values that may contain ">". */
const TAG = /<(\/?)([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

/** `tag` elements at the top level of `html` (not inside another element): their range and inner HTML. */
function directChildren(html: string, tag: string): { start: number; end: number; inner: string }[] {
	const out: { start: number; end: number; inner: string }[] = [];
	let depth = 0;
	let open: { start: number; innerStart: number } | null = null;
	for (const t of html.matchAll(TAG)) {
		const closing = t[1] === "/";
		const name = (t[2] as string).toLowerCase();
		const at = t.index ?? 0;
		if (closing) {
			depth = Math.max(0, depth - 1);
			if (open && depth === 0 && name === tag) {
				out.push({ start: open.start, end: at + t[0].length, inner: html.slice(open.innerStart, at) });
				open = null;
			}
			continue;
		}
		if (VOID_TAGS.has(name) || /\/\s*$/.test(t[3] as string)) continue;
		if (depth === 0 && name === tag) open = { start: at, innerStart: at + t[0].length };
		depth++;
	}
	return out;
}

/** Remove attributes whose name matches `names` from every tag (never from the text between tags). */
function stripTagAttributes(html: string, names: RegExp): string {
	return html.replace(TAG, (whole, slash: string, name: string, attrs: string) => {
		if (slash || !attrs) return whole;
		const kept = attrs.replace(/\s+([^\s=/>"']+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g, (attr, attrName: string) => (names.test(attrName) ? "" : attr));
		return `<${name}${kept}>`;
	});
}

/** Block-level tags: whitespace between two of them is only source formatting. */
const BLOCK_TAG = "(?:address|article|aside|blockquote|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)";
const AFTER_BLOCK = new RegExp(`(<\\/?${BLOCK_TAG}\\b(?:[^>"']|"[^"]*"|'[^']*')*>)\\s+(?=<)`, "gi");
const BEFORE_BLOCK = new RegExp(`>\\s+(?=<\\/?${BLOCK_TAG}\\b)`, "gi");

/**
 * Drop whitespace between two tags when one of them is block-level (`</p>\n<p>`,
 * `</p>\n<cite>`): it's source formatting that never renders. Whitespace between
 * inline elements (`<a>one</a> <a>two</a>`) and in text is kept.
 */
function collapseBlockWhitespace(html: string): string {
	return html.replace(AFTER_BLOCK, "$1").replace(BEFORE_BLOCK, ">");
}

/** A core Details block's summary (HTML), body (its inner blocks' HTML) and whether it starts open. */
export function coreDetailsFields(block: GBlock): { summary: string; body: string; open: boolean } {
	const html = blockHtml(block).trim();
	const m = html.match(/^<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>$/i);
	return { summary: (m?.[1] ?? "").trim(), body: (m?.[2] ?? html).trim(), open: block.attrs.showContent === true };
}

/** The testimonial's fields (Name, Title, Quote, Headshot, Social URL, Work URL); the headshot's URL comes from the export's attachments. */
export function testimonialFields(
	attrs: Record<string, unknown>,
	attachments?: Map<number, string>,
): { quote: string; name: string; title: string; photo: string; photoId: number | null; nameUrl: string; titleUrl: string } {
	const id = Number(attrs["t-image"]);
	const photoId = Number.isInteger(id) && id > 0 ? id : null;
	return {
		quote: repairUnicodeEscapes(str(attrs["t-quote"])).trim(),
		name: str(attrs["t-name"]).trim(),
		title: str(attrs["t-title"]).trim(),
		photo: photoId ? (attachments?.get(photoId) ?? "") : "",
		photoId,
		nameUrl: str(attrs["t-social"]).trim(),
		titleUrl: str(attrs["t-work"]).trim(),
	};
}

/** What WordPress's template printed (without its onclick handlers). */
function testimonialHtml(f: ReturnType<typeof testimonialFields>): string {
	const link = (href: string, text: string) => (href ? `<a href="${escapeAttr(href)}">${text}</a>` : text);
	return `<blockquote class="testimonial"><div class="quote"><p><q>${f.quote}</q></p></div><div class="influencer">${
		f.photo ? `<img alt="${escapeAttr(f.name)}" height="60" width="60" src="${escapeAttr(f.photo)}">` : ""
	}<p>${link(f.nameUrl, f.name)}</p><p>${link(f.titleUrl, f.title)}</p></div></blockquote>`;
}

/**
 * Code Block Enhancer let authors bold parts of a code block (real <strong>
 * tags inside <code>), and WordPress stores "[" as &#91; to keep shortcodes
 * from running. EmDash's importer decodes only the basic entities and keeps
 * tags as text, so both would show up literally: drop the formatting tags and
 * decode the brackets. Returns null when there's nothing to fix.
 */
export function cleanCodeHtml(html: string): string | null {
	const m = html.match(/^([\s\S]*?<code\b[^>]*>)([\s\S]*)(<\/code>[\s\S]*)$/i);
	if (!m) return null;
	const body = (m[2] as string)
		.replace(/<\/?(?:strong|b|em|i|mark|u|code|span)\b[^>]*>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/&#0*91;/g, "[")
		.replace(/&#0*93;/g, "]");
	return body === m[2] ? null : `${m[1]}${body}${m[3]}`;
}

/** The marker HTML block replacing a WordPress block, plus its action for the report. */
function replacement(block: GBlock, opts: PrepareOptions): { blocks: GBlock[]; action: PrepareAction } | null {
	const a = block.attrs;
	switch (block.name) {
		case "coywolf-custom-blocks/cloudflare-stream":
			return { blocks: [WRAP(markerHtml("cloudflare-stream", { ...a, embed: null }))], action: "video" };
		case "coywolf/video":
			return { blocks: [WRAP(markerHtml("video", a, block.innerHTML.trim()))], action: "video" };
		case "coywolf-custom-blocks/review":
			return { blocks: [WRAP(markerHtml("review", a))], action: "review" };
		case "coywolf-seo/table-of-contents":
			return { blocks: [WRAP(markerHtml("toc", a))], action: "toc" };
		case "coywolf/file":
			return { blocks: [WRAP(markerHtml("file", a, block.innerHTML.trim()))], action: "file" };
		case "coywolf-custom-blocks/blockquote": {
			const f = blockquoteFields(a);
			return { blocks: [WRAP(markerHtml("blockquote", f, blockquoteHtml(f)))], action: "quote" };
		}
		case "coywolf-custom-blocks/sidenote":
		case "coywolf-custom-blocks/editorsnote": {
			const kind = block.name === "coywolf-custom-blocks/sidenote" ? "sidenote" : "editorsnote";
			const text = repairUnicodeEscapes(str(a[kind])).trim();
			return { blocks: [WRAP(markerHtml(kind, { text }, noteHtml(kind, text)))], action: "note" };
		}
		case "coywolf-custom-blocks/transcript":
		case "coywolf-custom-blocks/accordion": {
			const kind = block.name === "coywolf-custom-blocks/transcript" ? "transcript" : "accordion";
			// The transcript's Summary field defaulted to "Read the audio transcript" (not saved when left as is).
			const summary = str(a.summary).trim() || (kind === "transcript" ? TRANSCRIPT_SUMMARY : "");
			const body = repairUnicodeEscapes(str(a.details)).trim();
			return { blocks: [WRAP(markerHtml(kind, { summary, body }, detailsHtml(summary, body, kind)))], action: "details" };
		}
		case "coywolf-custom-blocks/testimonial": {
			const f = testimonialFields(a, opts.attachments);
			return { blocks: [WRAP(markerHtml("testimonial", f, testimonialHtml(f)))], action: "testimonial" };
		}
		case "coywolf-custom-blocks/podcast-rss":
			// Same marker name and attrs as 0.10/0.11 (then a theme placeholder), so older markers convert too.
			return { blocks: [WRAP(markerHtml("podcast-links", { block: block.name, ...a }))], action: "podcast" };
		case "core/quote": {
			const f = coreQuoteFields(block);
			if (!f.quote) return null;
			return { blocks: [WRAP(markerHtml("blockquote", f, blockquoteHtml(f)))], action: "quote" };
		}
		case "core/details":
			return { blocks: [WRAP(markerHtml("details", coreDetailsFields(block), blockHtml(block).trim()))], action: "details" };
		case "yoast-seo/related-links":
			// EmDash would turn each list item into its own HTML block.
			return { blocks: [WRAP(markerHtml("related-links", {}, blockHtml(block).trim()))], action: "html" };
		default:
			if (block.name && REMOVE.has(block.name)) return { blocks: [], action: "removed" };
			if (block.name && (DISCLOSURES.has(block.name) || opts.disclosureBlocks?.includes(block.name))) return { blocks: [WRAP(markerHtml("disclosure", { block: block.name, ...a }))], action: "disclosure" };
			if (block.name && FLAG[block.name]) return { blocks: [WRAP(markerHtml(FLAG[block.name] as string, { block: block.name, ...a }))], action: "flag" };
			return null;
	}
}

const isBlank = (b: GBlock) => b.name === null && !b.innerHTML.trim();

/** Transform one list of sibling blocks. Returns, for each original block, what replaces it. */
function transformList(list: GBlock[], opts: PrepareOptions, counts: PrepareCounts): GBlock[][] {
	const out: GBlock[][] = list.map((b) => [b]);
	const count = (name: string | null, action: PrepareAction) => {
		const key = `${name ?? "html"} → ${action}`;
		counts[key] = (counts[key] ?? 0) + 1;
	};
	for (let i = 0; i < list.length; i++) {
		const block = list[i] as GBlock;
		if (block.name === "coywolf-custom-blocks/cloudflare-stream") {
			// Pair with the embed HTML right before it (the schema block followed the player).
			let j = i - 1;
			while (j >= 0 && isBlank(list[j] as GBlock)) j--;
			const prev = j >= 0 ? (list[j] as GBlock) : null;
			const embed = prev?.name === "core/html" && out[j]?.[0] === prev ? parseStreamEmbed(prev.innerHTML.trim()) : null;
			const uid = typeof block.attrs["cs-id"] === "string" ? block.attrs["cs-id"].toLowerCase() : "";
			if (embed && (embed.uid === null || embed.uid === uid)) {
				out[j] = [];
				count("core/html", "removed");
			}
			out[i] = [WRAP(markerHtml("cloudflare-stream", { ...block.attrs, embed: embed && (embed.uid === null || embed.uid === uid) ? embed : null }))];
			count(block.name, "video");
			continue;
		}
		if (block.name === "core/html" && hasStreamPlayer(block.innerHTML)) {
			// A player with no schema block after it.
			let k = i + 1;
			while (k < list.length && isBlank(list[k] as GBlock)) k++;
			if (list[k]?.name === "coywolf-custom-blocks/cloudflare-stream") continue; // Paired above.
			const embed = parseStreamEmbed(block.innerHTML.trim());
			if (embed?.uid) {
				out[i] = [WRAP(markerHtml("stream-embed", { embed }))];
				count(block.name, "video-embed");
			}
			continue;
		}
		if (block.name === "core/heading") {
			const id = block.innerHTML.match(/<h[1-6]\b[^>]*\sid="([^"]+)"/i)?.[1];
			let j = i - 1;
			while (j >= 0 && isBlank(list[j] as GBlock)) j--;
			const prev = j >= 0 ? parseMarker((list[j] as GBlock).innerHTML.trim()) : null;
			const marked = prev?.name === "anchor" && prev.attrs.id === id;
			if (id && !marked) {
				out[i] = [WRAP(markerHtml("anchor", { id })), block];
				count(block.name, "anchor");
			}
			continue;
		}
		if (block.name === "core/code") {
			const cleaned = cleanCodeHtml(block.innerHTML);
			if (cleaned !== null) {
				// innerContent is the HTML alone (code blocks have no inner blocks).
				out[i] = [{ ...block, innerHTML: cleaned, innerContent: [cleaned] }];
				count(block.name, "code");
			}
			continue;
		}
		if (block.name === "core/block") {
			// A reusable block (synced pattern): put its blocks in place of the reference.
			const ref = Number(block.attrs.ref);
			const depth = opts.reusableDepth ?? 0;
			const body = Number.isInteger(ref) && depth < MAX_REUSABLE_DEPTH ? opts.reusableBlocks?.get(ref) : undefined;
			if (body !== undefined) {
				out[i] = flatten(transformList(parseBlocks(body), { ...opts, reusableDepth: depth + 1 }, counts));
				count(block.name, "inlined");
			} else if (block.attrs.ref !== undefined) {
				count(block.name, "missing");
			}
			continue;
		}
		const rep = replacement(block, opts);
		if (rep) {
			out[i] = rep.blocks;
			count(block.name, rep.action);
			continue;
		}
		// Self-closing blocks keep everything in attributes, and EmDash drops the ones it doesn't know.
		if (block.void && block.name && !block.name.startsWith("core/")) count(block.name, "dropped");
		if (block.innerBlocks.length) rebuildInner(block, opts, counts);
	}
	return out;
}

const SPACER = (): GBlock => ({ name: null, attrs: {}, innerHTML: "\n\n", innerBlocks: [], innerContent: ["\n\n"], opener: "", closer: "", void: false });

/** One list from the replacement groups, with a blank line between blocks that replaced one. */
function flatten(replaced: GBlock[][]): GBlock[] {
	const flat: GBlock[] = [];
	for (const group of replaced) {
		group.forEach((b, n) => {
			if (n > 0) flat.push(SPACER());
			flat.push(b);
		});
	}
	return flat;
}

/** Transform a block's inner blocks in place, keeping its own markup. */
function rebuildInner(block: GBlock, opts: PrepareOptions, counts: PrepareCounts): void {
	const replaced = transformList(block.innerBlocks, opts, counts);
	const innerBlocks: GBlock[] = [];
	const innerContent: Array<string | null> = [];
	let slot = 0;
	for (const chunk of block.innerContent) {
		if (chunk !== null) {
			innerContent.push(chunk);
			continue;
		}
		const group = replaced[slot++] ?? [];
		group.forEach((b, n) => {
			if (n > 0) innerContent.push("\n\n");
			innerBlocks.push(b);
			innerContent.push(null);
		});
	}
	block.innerBlocks = innerBlocks;
	block.innerContent = innerContent;
}

/** Prepare one post's content. */
export function prepareContent(content: string, opts: PrepareOptions = {}): PrepareResult {
	const counts: PrepareCounts = {};
	if (!content || !content.includes("<!-- wp:")) return { content, counts, changed: false };
	const blocks = parseBlocks(content);
	const next = serializeBlocks(flatten(transformList(blocks, opts, counts)));
	return { content: next, counts, changed: next !== content };
}

// ── WXR ──────────────────────────────────────────────────────────

const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** The text of an element body that may be CDATA (WordPress splits "]]>" across sections). */
function cdataText(body: string): string {
	if (!body.includes("<![CDATA[")) return body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	let text = "";
	for (const m of body.matchAll(CDATA)) text += m[1];
	return text;
}

const toCdata = (text: string) => `<![CDATA[${text.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;

function tag(item: string, name: string): string | null {
	const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return m ? cdataText(m[1] as string) : null;
}

/** Attachment id → URL from a WXR file. */
export function wxrAttachments(xml: string): Map<number, string> {
	const map = new Map<number, string>();
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		if (tag(item, "wp:post_type") !== "attachment") continue;
		const id = Number(tag(item, "wp:post_id"));
		const url = tag(item, "wp:attachment_url");
		if (Number.isInteger(id) && url) map.set(id, url.trim());
	}
	return map;
}

/** Reusable block (`wp_block`, "synced pattern") id → its content, from a WXR file. */
export function wxrReusableBlocks(xml: string): Map<number, string> {
	const map = new Map<number, string>();
	for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		const item = m[1] as string;
		if (tag(item, "wp:post_type") !== "wp_block") continue;
		const id = Number(tag(item, "wp:post_id"));
		const content = tag(item, "content:encoded");
		if (Number.isInteger(id) && content !== null) map.set(id, content);
	}
	return map;
}

export interface PreparedPost {
	id: number | null;
	title: string;
	type: string;
	counts: PrepareCounts;
}

export interface PrepareWxrResult {
	xml: string;
	posts: PreparedPost[];
	/** Totals over every post (including what's only counted, like blocks EmDash will drop). */
	counts: PrepareCounts;
	/** Posts credited to authors other than their WordPress user (co-authors, guest authors), for the bylines step. */
	guestAuthors: GuestAuthor[];
	/** Categories with their parents, and pages with their parent pages, for the parents step (EmDash's importer drops both). */
	categories: WxrCategory[];
	pages: WxrPage[];
}

/** Prepare a whole WXR export. Only `content:encoded` bodies change. */
export function prepareWxr(xml: string, opts: PrepareOptions = {}): PrepareWxrResult {
	const attachments = opts.attachments ?? wxrAttachments(xml);
	const reusableBlocks = opts.reusableBlocks ?? wxrReusableBlocks(xml);
	const posts: PreparedPost[] = [];
	const totals: PrepareCounts = {};
	const out = xml.replace(/<item>([\s\S]*?)<\/item>/g, (whole, item: string) => {
		const m = item.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/);
		if (!m) return whole;
		const result = prepareContent(cdataText(m[1] as string), { ...opts, attachments, reusableBlocks });
		for (const [k, v] of Object.entries(result.counts)) totals[k] = (totals[k] ?? 0) + v;
		if (!result.changed) return whole;
		posts.push({
			id: Number(tag(item, "wp:post_id")) || null,
			title: tag(item, "title") ?? "",
			type: tag(item, "wp:post_type") ?? "",
			counts: result.counts,
		});
		return `<item>${item.replace(m[0], () => `<content:encoded>${toCdata(result.content)}</content:encoded>`)}</item>`;
	});
	return { xml: out, posts, counts: totals, guestAuthors: wxrGuestAuthors(xml, attachments), categories: wxrCategories(xml), pages: wxrPages(xml) };
}
