/**
 * WordPress import markers. EmDash's importer turns Gutenberg into Portable
 * Text with @emdash-cms/gutenberg-to-portable-text, which has no hook for
 * plugins and drops every self-closing block it doesn't know (most Coywolf
 * blocks store everything in attributes, so they'd vanish). The prepare step
 * (./prepare.ts) rewrites those blocks into Custom HTML blocks holding a
 * marker element:
 *
 *   <div data-coywolf-wp="NAME" data-coywolf-attrs="{…html-escaped JSON…}">fallback HTML</div>
 *
 * which the importer keeps verbatim as an `htmlBlock`. The convert step
 * (./convert.ts) then turns markers into native Coywolf Pack blocks. The
 * attributes live in the HTML itself, so they survive an editor round trip
 * (the editor drops the importer's `originalAttrs`).
 *
 * Also reads the markers wellbeing.io's import script wrote
 * (`<div data-wb-block="NAME" data-wb-attrs="{…}"></div>`).
 *
 * Pure, no imports: runs in the Worker, the admin (browser) and tests.
 */

export interface Marker {
	/** Short block name, e.g. "cloudflare-stream", "review", "anchor". */
	name: string;
	attrs: Record<string, unknown>;
	/** HTML inside the marker element (the fallback rendering), possibly empty. */
	inner: string;
	/** Which marker format it came in. */
	source: "coywolf" | "wellbeing";
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const UNESCAPES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&apos;": "'" };

/** Escape text for an HTML attribute value or text node. */
export function escapeAttr(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

function unescapeAttr(text: string): string {
	return text.replace(/&(?:amp|lt|gt|quot|#39|#x27|apos);/g, (e) => UNESCAPES[e] as string);
}

/** The marker element for a block. `inner` is trusted fallback HTML (already escaped where needed). */
export function markerHtml(name: string, attrs: Record<string, unknown>, inner = ""): string {
	return `<div data-coywolf-wp="${escapeAttr(name)}" data-coywolf-attrs="${escapeAttr(JSON.stringify(attrs))}">${inner}</div>`;
}

const COYWOLF = /^\s*<div data-coywolf-wp="([a-z0-9-]+)" data-coywolf-attrs="([^"]*)">([\s\S]*)<\/div>\s*$/;
const WELLBEING = /^\s*<div data-wb-block="([a-z0-9-]+)" data-wb-attrs="([^"]*)"><\/div>\s*$/;

/** Parse a marker HTML block, or null when the HTML isn't one (or its JSON is unreadable). */
export function parseMarker(html: unknown): Marker | null {
	if (typeof html !== "string" || html.length > 2_000_000) return null;
	const m = html.match(COYWOLF);
	const w = m ? null : html.match(WELLBEING);
	const hit = m ?? w;
	if (!hit) return null;
	try {
		const attrs = JSON.parse(unescapeAttr(hit[2] as string)) as unknown;
		if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return null;
		return { name: hit[1] as string, attrs: attrs as Record<string, unknown>, inner: m ? (m[3] as string) : "", source: m ? "coywolf" : "wellbeing" };
	} catch {
		return null;
	}
}
