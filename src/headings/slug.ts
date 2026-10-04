/**
 * Heading anchor slugs, ported from Coywolf SEO (WordPress `sanitize_title`
 * plus a `jump-` prefix): lowercase, accents removed, punctuation dropped,
 * spaces to hyphens, unique within the document.
 */

/** A Portable Text heading level from a block's style ("h2" → 2), or null. */
export function headingLevel(block: unknown): number | null {
	if (!block || typeof block !== "object") return null;
	const b = block as { _type?: unknown; style?: unknown };
	if (b._type !== "block" || typeof b.style !== "string") return null;
	const match = /^h([1-6])$/.exec(b.style);
	return match ? Number(match[1]) : null;
}

/**
 * The plain text of a Portable Text block. Walks nested `children`, so it
 * also works on the marks tree astro-portabletext hands block components.
 */
export function blockText(block: unknown): string {
	const parts: string[] = [];
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const { text, children } = node as { text?: unknown; children?: unknown };
		if (typeof text === "string") parts.push(text);
		else if (Array.isArray(children)) children.forEach(walk);
	};
	const children = (block as { children?: unknown })?.children;
	if (Array.isArray(children)) children.forEach(walk);
	return parts.join("").replace(/\s+/g, " ").trim();
}

const MAX_SLUG = 80;

/** A URL-safe slug for heading text ("Don't Panic!" → "dont-panic"). Empty text gives "". */
export function slugify(text: string): string {
	const slug = text
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/&[a-z0-9#]+;/g, "")
		.replace(/[^\p{L}\p{N}\s_-]+/gu, "")
		.trim()
		.replace(/[\s_]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > MAX_SLUG ? slug.slice(0, MAX_SLUG).replace(/-+$/, "") : slug;
}

/** A prefix is empty or a short id-safe string starting with a letter. */
export function validPrefix(prefix: unknown): prefix is string {
	return typeof prefix === "string" && /^(?:[A-Za-z][A-Za-z0-9_-]{0,19})?$/.test(prefix);
}

/** Whether a stored anchor is safe to emit as an HTML id and in a fragment link. */
export function validAnchor(anchor: unknown): anchor is string {
	return typeof anchor === "string" && anchor.length <= 120 && /^[\p{L}][\p{L}\p{N}_-]*$/u.test(anchor);
}

/** `prefix + slug(text)`, with -2, -3… appended until it's not in `taken`. Adds the result to `taken`. */
export function uniqueSlug(text: string, taken: Set<string>, prefix = "jump-"): string {
	let base = `${prefix}${slugify(text) || "section"}`;
	if (!/^\p{L}/u.test(base)) base = `h-${base}`;
	let slug = base;
	for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
	taken.add(slug);
	return slug;
}
