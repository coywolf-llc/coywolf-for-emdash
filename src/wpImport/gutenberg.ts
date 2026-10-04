/**
 * A small Gutenberg block parser and serializer for the prepare step: it
 * follows WordPress's block-serialization-default-parser grammar, keeps each
 * untouched block's original text byte for byte, and lets the prepare step
 * swap blocks for others (replace an entry in `innerBlocks` and its `null`
 * slot in `innerContent` stays in place). No imports, so it runs in the browser and Node.
 */

export interface GBlock {
	/** Full name ("core/paragraph", "coywolf/video"), or null for HTML between blocks. */
	name: string | null;
	attrs: Record<string, unknown>;
	/** HTML of this block without its inner blocks. */
	innerHTML: string;
	innerBlocks: GBlock[];
	/** Text chunks, with null where each inner block goes. */
	innerContent: Array<string | null>;
	/** The opening comment as written ("" for freeform HTML). */
	opener: string;
	/** The closing comment as written ("" when void, freeform or never closed). */
	closer: string;
	/** Self-closing (`<!-- wp:name /-->`). */
	void: boolean;
}

const TOKEN = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+(\{[\s\S]*?\}\s+)?(\/)?-->/g;

const fullName = (ns: string | undefined, name: string) => `${ns ?? "core/"}${name}`;

function freeform(html: string): GBlock {
	return { name: null, attrs: {}, innerHTML: html, innerBlocks: [], innerContent: [html], opener: "", closer: "", void: false };
}

interface Frame {
	block: GBlock;
	start: number;
	/** Where the next text chunk inside this block starts. */
	cursor: number;
}

/** Parse post content into blocks (top-level HTML between blocks becomes freeform blocks). */
export function parseBlocks(content: string): GBlock[] {
	const out: GBlock[] = [];
	const stack: Frame[] = [];
	let topCursor = 0;
	TOKEN.lastIndex = 0;
	const pushText = (frame: Frame | undefined, end: number) => {
		if (frame) {
			const text = content.slice(frame.cursor, end);
			if (text) {
				frame.block.innerContent.push(text);
				frame.block.innerHTML += text;
			}
		} else if (end > topCursor) {
			out.push(freeform(content.slice(topCursor, end)));
		}
	};
	for (let m = TOKEN.exec(content); m; m = TOKEN.exec(content)) {
		const [whole, closer, ns, short, json, slash] = m;
		const name = fullName(ns, short as string);
		const start = m.index;
		const end = start + whole.length;
		const parent = stack[stack.length - 1];
		if (closer) {
			// Close the nearest open block with this name; ignore stray closers.
			const at = stack.map((f) => f.block.name).lastIndexOf(name);
			if (at < 0) continue;
			while (stack.length - 1 > at) {
				// Unclosed inner blocks: treat their opener as void-ish and keep their text.
				const frame = stack.pop() as Frame;
				pushText(frame, start);
				const up = stack[stack.length - 1] as Frame;
				up.block.innerBlocks.push(frame.block);
				up.block.innerContent.push(null);
				up.cursor = start;
			}
			const frame = stack.pop() as Frame;
			pushText(frame, start);
			frame.block.closer = whole;
			const up = stack[stack.length - 1];
			if (up) {
				up.block.innerBlocks.push(frame.block);
				up.block.innerContent.push(null);
				up.cursor = end;
			} else {
				out.push(frame.block);
				topCursor = end;
			}
			continue;
		}
		let attrs: Record<string, unknown> = {};
		if (json) {
			try {
				const parsed = JSON.parse(json.trim()) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) attrs = parsed as Record<string, unknown>;
			} catch {
				attrs = {};
			}
		}
		const block: GBlock = { name, attrs, innerHTML: "", innerBlocks: [], innerContent: [], opener: whole, closer: "", void: Boolean(slash) };
		pushText(parent, start);
		if (slash) {
			if (parent) {
				parent.block.innerBlocks.push(block);
				parent.block.innerContent.push(null);
				parent.cursor = end;
			} else {
				out.push(block);
				topCursor = end;
			}
		} else {
			if (parent) parent.cursor = start;
			stack.push({ block, start, cursor: end });
		}
	}
	// Unclosed blocks at the end: keep their text as they were.
	while (stack.length) {
		const frame = stack.pop() as Frame;
		pushText(frame, content.length);
		const up = stack[stack.length - 1];
		if (up) {
			up.block.innerBlocks.push(frame.block);
			up.block.innerContent.push(null);
			up.cursor = content.length;
		} else {
			out.push(frame.block);
			topCursor = content.length;
		}
	}
	if (topCursor < content.length) out.push(freeform(content.slice(topCursor)));
	return out;
}

/** The block's rendered-ish HTML: its inner content with inner blocks' HTML filled in (no comments). */
export function blockHtml(block: GBlock): string {
	let i = 0;
	return block.innerContent.map((chunk) => (chunk === null ? blockHtml(block.innerBlocks[i++] as GBlock) : chunk)).join("");
}

/** A Custom HTML block (core/html) holding `html`. */
export function htmlBlock(html: string): GBlock {
	const inner = `\n${html}\n`;
	return { name: "core/html", attrs: {}, innerHTML: inner, innerBlocks: [], innerContent: [inner], opener: "<!-- wp:html -->", closer: "<!-- /wp:html -->", void: false };
}

/** Serialize one block. An untouched block comes back exactly as it was parsed. */
export function serializeBlock(block: GBlock): string {
	if (block.void) return block.opener;
	let i = 0;
	const body = block.innerContent.map((chunk) => (chunk === null ? serializeBlock(block.innerBlocks[i++] as GBlock) : chunk)).join("");
	return block.opener + body + block.closer;
}

/** Serialize blocks back to post content. */
export function serializeBlocks(blocks: GBlock[]): string {
	return blocks.map(serializeBlock).join("");
}
