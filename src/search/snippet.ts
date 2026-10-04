/**
 * Live results highlighting: the excerpt under each result and the matched
 * words in titles. Ported from the Coywolf Search WordPress plugin (a
 * window of text around the first match, ellipses at cut ends, matches
 * wrapped in <mark>), with two changes: matching is by word prefix, the
 * way EmDash's FTS5 prefix search matched the entry, and the text is
 * escaped piece by piece around the matches rather than highlighted after
 * escaping, so a typed "amp" can never land inside "&amp;".
 *
 * The output is escaped HTML whose only tags are <mark> and </mark>.
 *
 * Pure functions (no imports) so they can be unit tested in Node.
 */

/** Characters of text in a snippet (as in Coywolf Search). */
export const SNIPPET_WIDTH = 180;
/** Characters of context kept before the first match. */
export const SNIPPET_LEAD = 40;
/** Most words highlighted from one query. */
export const MAX_HIGHLIGHT_WORDS = 10;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The words to highlight: what the visitor typed (not index terms, which
 * stemming changes), two characters or longer, longest first so "photograph"
 * wins over "photo" and the shorter word can't split the longer one's mark.
 */
export function highlightWords(query: string): string[] {
	const seen = new Set<string>();
	for (const part of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if ([...part].length >= 2) seen.add(part);
	}
	return [...seen].sort((a, b) => b.length - a.length).slice(0, MAX_HIGHLIGHT_WORDS);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches any of the words at the start of a word (case-insensitive). Null when there are none. */
export function wordPattern(words: string[]): RegExp | null {
	if (!words.length) return null;
	return new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escapeRegExp).join("|")})`, "giu");
}

/** Escape `text` and wrap each match of the words in <mark>. */
export function highlightHtml(text: string, words: string[]): string {
	const pattern = wordPattern(words);
	if (!pattern) return escapeHtml(text);
	let out = "";
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		out += `${escapeHtml(text.slice(last, start))}<mark>${escapeHtml(match[0])}</mark>`;
		last = start + match[0].length;
	}
	return out + escapeHtml(text.slice(last));
}

/** Collapse whitespace (indexed Portable Text is spans joined by spaces). */
export function cleanText(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

const isLowSurrogate = (text: string, i: number) => {
	const c = text.charCodeAt(i);
	return c >= 0xdc00 && c <= 0xdfff;
};

/**
 * A window of about `width` characters around the first match of any of the
 * words (or the start, when none match), cut at word boundaries where the
 * text has them, with "…" where it was cut, highlighted and escaped.
 */
export function buildSnippet(text: string, words: string[], width = SNIPPET_WIDTH, lead = SNIPPET_LEAD): string {
	const clean = cleanText(text);
	if (!clean) return "";
	const pattern = wordPattern(words);
	const first = pattern ? pattern.exec(clean) : null;

	let start = first ? Math.max(0, first.index - lead) : 0;
	let end = Math.min(clean.length, start + width);
	// Pull the window back when the end of the text leaves room, so a match near the end keeps its context.
	if (end === clean.length) start = Math.max(0, end - width);

	// Snap inward to word boundaries (not past the match), so no word is shown cut in half.
	if (start > 0) {
		const space = clean.indexOf(" ", start);
		if (space !== -1 && space < (first ? first.index : end) && space - start < 20) start = space + 1;
		else if (isLowSurrogate(clean, start)) start++;
	}
	if (end < clean.length) {
		const space = clean.lastIndexOf(" ", end);
		if (space > start && end - space < 20 && (!first || space >= first.index + first[0].length)) end = space;
		else if (isLowSurrogate(clean, end)) end--;
	}

	const body = highlightHtml(clean.slice(start, end).trim(), words);
	return `${start > 0 ? "…" : ""}${body}${end < clean.length ? "…" : ""}`;
}

/**
 * The readable text of a Portable Text field (stored as JSON): the spans of
 * text blocks (paragraphs, headings, lists) only. Image alt text, captions
 * and other blocks' data, which EmDash's search index includes, are left out
 * so excerpts read like the post. Returns "" for anything that isn't Portable
 * Text.
 */
export function portableTextProse(value: unknown, maxChars = 20_000): string {
	let blocks: unknown = value;
	if (typeof value === "string") {
		try {
			blocks = JSON.parse(value);
		} catch {
			return "";
		}
	}
	if (!Array.isArray(blocks)) return "";
	const parts: string[] = [];
	let length = 0;
	for (const block of blocks) {
		if (!block || typeof block !== "object" || (block as { _type?: unknown })._type !== "block") continue;
		const children = (block as { children?: unknown }).children;
		if (!Array.isArray(children)) continue;
		const text = children.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
		if (!text.trim()) continue;
		parts.push(text);
		length += text.length + 1;
		if (length >= maxChars) break;
	}
	return parts.join(" ").slice(0, maxChars);
}
