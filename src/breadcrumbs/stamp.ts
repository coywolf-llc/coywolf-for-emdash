/**
 * Save-time stamping for Breadcrumbs blocks (content:beforeSave). A block
 * component only sees its own node, so each `coywolf-breadcrumbs` block gets
 * `_title`, the entry's title, for the last crumb of a trail derived from the
 * URL. Pure: returns new objects, never mutates its input, and is idempotent.
 */

export const BREADCRUMBS_BLOCK = "coywolf-breadcrumbs";

type Block = Record<string, unknown> & { _type: string };

/** An array that looks like Portable Text: every item is an object with a string `_type`. */
function isPortableText(value: unknown): value is Block[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((b) => b && typeof b === "object" && typeof (b as { _type?: unknown })._type === "string")
	);
}

/** Stamp the title into every Breadcrumbs block. Returns the new content, or null when nothing changed. */
export function stampBreadcrumbs(content: Record<string, unknown>): Record<string, unknown> | null {
	const title = typeof content.title === "string" ? content.title.trim() || null : null;
	if (title === null) return null;
	let result: Record<string, unknown> | null = null;
	for (const [field, value] of Object.entries(content)) {
		if (!isPortableText(value)) continue;
		let out: Block[] | null = null;
		value.forEach((block, i) => {
			if (block._type !== BREADCRUMBS_BLOCK || block._title === title) return;
			out ??= value.slice();
			out[i] = { ...block, _title: title };
		});
		if (out) {
			result ??= { ...content };
			result[field] = out;
		}
	}
	return result;
}
