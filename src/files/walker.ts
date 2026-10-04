/**
 * Find coywolf-file blocks in saved content. Portable Text can sit in any
 * field and nest (columns, sections, repeaters), so the walk is generic:
 * every object with `_type: "coywolf-file"` and a string `id` counts.
 * No imports, so `node --test` can load this file directly.
 */

export const BLOCK_TYPE = "coywolf-file";

export interface FileBlockRef {
	/** File id (large-upload id or media library id). */
	id: string;
	/** Top-level field the block was found in. */
	field: string;
}

const MAX_DEPTH = 64;

/** Every coywolf-file block in a content record, in document order. */
export function findFileBlocks(content: unknown): FileBlockRef[] {
	const out: FileBlockRef[] = [];
	const seen = new WeakSet<object>();
	// The field is the first key below the record (or below `data`, where EmDash keeps fields).
	const visit = (value: unknown, path: string[], depth: number) => {
		if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item, path, depth + 1);
			return;
		}
		const record = value as Record<string, unknown>;
		if (record._type === BLOCK_TYPE && typeof record.id === "string" && record.id.trim()) {
			out.push({ id: record.id.trim(), field: (path[0] === "data" ? path[1] : path[0]) ?? "" });
		}
		for (const [key, child] of Object.entries(record)) {
			if (child && typeof child === "object") visit(child, path.length < 2 ? [...path, key] : path, depth + 1);
		}
	};
	visit(content, [], 0);
	return out;
}

/** Distinct file ids referenced by a content record. */
export function fileIdsIn(content: unknown): string[] {
	return [...new Set(findFileBlocks(content).map((b) => b.id))];
}

/** A readable title for a content record (EmDash puts fields under `data`). */
export function entryTitle(content: Record<string, unknown>): string {
	const data = (content.data && typeof content.data === "object" ? content.data : content) as Record<string, unknown>;
	for (const key of ["title", "name", "headline"]) {
		const value = data[key] ?? content[key];
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
	}
	if (typeof content.slug === "string" && content.slug) return content.slug;
	return String(content.id ?? "Untitled");
}
