/**
 * Save-time stamping (content:beforeSave). EmDash's Portable Text renderer
 * emits headings without ids, and a block component only sees its own node,
 * so everything the site needs is written into the content when it's saved:
 *
 * - each H2–H6 heading block gets an `anchor` field (e.g. "jump-pricing"),
 *   unique within its field and kept across edits (matched to the previous
 *   save by block `_key`, then by text), because the editor drops unknown
 *   fields on heading blocks;
 * - each `coywolf-toc` block gets `_headings`, the field's heading list.
 *
 * (Breadcrumbs blocks are stamped by the Breadcrumb Nav module, src/breadcrumbs/stamp.ts.)
 *
 * Pure: returns new objects and never mutates its input. Running it twice
 * gives the same result (`changed: false` the second time).
 */
import { blockText, headingLevel, uniqueSlug, validAnchor } from "./slug.js";
import type { TocHeading } from "./toc.js";

export const TOC_BLOCK = "coywolf-toc";
export const ANCHOR_LEVELS = [2, 3, 4, 5, 6];

export interface StampOptions {
	/** Stamp heading anchors (and TOC heading lists, when `toc`). */
	anchors: boolean;
	toc: boolean;
	prefix: string;
	/** The entry's stored data before this save, to keep anchors stable. */
	previous?: Record<string, unknown> | null;
}

type Block = Record<string, unknown> & { _type: string; _key?: string };

/** An array that looks like Portable Text: every item is an object with a string `_type`. */
function isPortableText(value: unknown): value is Block[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((b) => b && typeof b === "object" && typeof (b as { _type?: unknown })._type === "string")
	);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Previous anchors of one field, by block key and by heading text. */
function previousAnchors(previous: unknown) {
	const byKey = new Map<string, string>();
	const byText = new Map<string, string>();
	if (isPortableText(previous)) {
		for (const block of previous) {
			if (!headingLevel(block) || !validAnchor(block.anchor)) continue;
			if (typeof block._key === "string") byKey.set(block._key, block.anchor);
			const text = blockText(block);
			if (text && !byText.has(text)) byText.set(text, block.anchor);
		}
	}
	return { byKey, byText };
}

/** Stamp one Portable Text field. Returns the new array, or null when nothing changed. */
export function stampField(blocks: Block[], options: StampOptions, previousField: unknown): Block[] | null {
	const out = blocks.slice();
	let changed = false;
	const set = (i: number, patch: Record<string, unknown>, remove?: string) => {
		const next: Block = { ...out[i], ...patch };
		if (remove) delete next[remove];
		out[i] = next;
		changed = true;
	};

	const headings: TocHeading[] = [];
	if (options.anchors) {
		const { byKey, byText } = previousAnchors(previousField);
		const taken = new Set<string>();
		const pending: { index: number; level: number; text: string; kept: string | null; byText: string | null }[] = [];

		blocks.forEach((block, index) => {
			const level = headingLevel(block);
			if (!level || !ANCHOR_LEVELS.includes(level)) return;
			const text = blockText(block);
			if (!text) {
				if ("anchor" in block) set(index, {}, "anchor");
				return;
			}
			const kept = (validAnchor(block.anchor) ? block.anchor : null) ?? (typeof block._key === "string" ? byKey.get(block._key) : undefined) ?? null;
			pending.push({ index, level, text, kept, byText: byText.get(text) ?? null });
		});

		// Claim anchors in priority order (first claim wins): the block's own or its previous
		// anchor (by _key), then a previous anchor with the same text, then a new slug.
		const ids = new Map<number, string>();
		const claim = (pick: (p: (typeof pending)[number]) => string | null) => {
			for (const p of pending) {
				const id = ids.has(p.index) ? null : pick(p);
				if (id && !taken.has(id)) {
					taken.add(id);
					ids.set(p.index, id);
				}
			}
		};
		claim((p) => p.kept);
		claim((p) => p.byText);
		for (const p of pending) if (!ids.has(p.index)) ids.set(p.index, uniqueSlug(p.text, taken, options.prefix));

		for (const p of pending) {
			const id = ids.get(p.index) as string;
			if (blocks[p.index].anchor !== id) set(p.index, { anchor: id });
			headings.push({ level: p.level, id, text: p.text });
		}
	}

	if (options.toc && options.anchors) {
		blocks.forEach((block, index) => {
			if (block._type === TOC_BLOCK && !sameJson(block._headings, headings)) set(index, { _headings: headings });
		});
	}

	return changed ? out : null;
}

/** Stamp every Portable Text field of an entry. Returns the new content, or null when nothing changed. */
export function stampContent(content: Record<string, unknown>, options: StampOptions): Record<string, unknown> | null {
	let result: Record<string, unknown> | null = null;
	for (const [field, value] of Object.entries(content)) {
		if (!isPortableText(value)) continue;
		const stamped = stampField(value, options, options.previous?.[field]);
		if (stamped) {
			result ??= { ...content };
			result[field] = stamped;
		}
	}
	return result;
}

/** Whether any field has a heading without a valid anchor (so the previous version is worth reading). */
export function needsPrevious(content: Record<string, unknown>): boolean {
	return Object.values(content).some(
		(value) => isPortableText(value) && value.some((block) => headingLevel(block) && !validAnchor(block.anchor)),
	);
}
