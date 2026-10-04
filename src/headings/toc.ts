/**
 * Table of contents tree: the flat heading list stamped into a TOC block,
 * filtered to the block's levels and nested by level. Tolerant of skipped
 * levels (an H4 straight after an H2 nests under the H2).
 */

export interface TocHeading {
	level: number;
	id: string;
	text: string;
}

export interface TocNode extends TocHeading {
	children: TocNode[];
}

export function buildTocTree(headings: readonly TocHeading[], levels: readonly number[]): TocNode[] {
	const wanted = new Set(levels);
	const root: TocNode[] = [];
	const stack: TocNode[] = [];
	for (const heading of headings) {
		if (!wanted.has(heading.level)) continue;
		const node: TocNode = { level: heading.level, id: heading.id, text: heading.text, children: [] };
		while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
		(stack.length ? stack[stack.length - 1].children : root).push(node);
		stack.push(node);
	}
	return root;
}

/** Count every node in a tree. */
export function countToc(nodes: readonly TocNode[]): number {
	return nodes.reduce((n, node) => n + 1 + countToc(node.children), 0);
}

/** Clean the heading list stored on a TOC block (it's content data, so treat it as untrusted). */
export function storedHeadings(value: unknown): TocHeading[] {
	if (!Array.isArray(value)) return [];
	const out: TocHeading[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const { level, id, text } = item as Record<string, unknown>;
		if (typeof level !== "number" || level < 1 || level > 6) continue;
		if (typeof id !== "string" || !id || typeof text !== "string" || !text) continue;
		out.push({ level, id, text });
	}
	return out;
}
