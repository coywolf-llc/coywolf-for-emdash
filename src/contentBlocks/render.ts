/**
 * Content Blocks markup and CSS, shared by the Astro components
 * (src/astro/contentBlocks) and the live previews on the Content Blocks admin
 * page, so the preview is exactly what the site prints. Block fields are
 * cleaned here (normalize*), then rendered with renderRich for their text.
 *
 * Pure, no imports beyond siblings: runs in the Worker, the admin and tests.
 */
import { escapeHtml, plainText, renderRich, safeUrl } from "./rich.js";

export const BLOCK_TYPES = {
	note: "coywolf-note",
	details: "coywolf-details",
	disclosure: "coywolf-disclosure",
	quote: "coywolf-quote",
} as const;

const str = (v: unknown, max = 500_000) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === "open";

/** An id for aria-labelledby, from the block's key (unique per page). */
export function blockId(prefix: string, key: unknown): string {
	const k = typeof key === "string" ? key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) : "";
	return `${prefix}-${k || "block"}`;
}

// ── Note / callout ───────────────────────────────────────────────

export const NOTE_VARIANTS = [
	["note", "Note"],
	["editor", "Editor's note"],
	["tip", "Tip"],
	["warning", "Warning"],
] as const;
export type NoteVariant = (typeof NOTE_VARIANTS)[number][0];
const NOTE_IDS = NOTE_VARIANTS.map(([v]) => v);
export const NOTE_TITLE_TAGS = ["p", "h2", "h3", "h4"] as const;
export type NoteTitleTag = (typeof NOTE_TITLE_TAGS)[number];

export interface Note {
	variant: NoteVariant;
	/** Rich inline text; empty = the variant's name. */
	title: string;
	hideTitle: boolean;
	/** "p": bold text; "h2"–"h4": a heading. */
	titleTag: NoteTitleTag;
	body: string;
}

export function normalizeNote(node: Record<string, unknown>): Note {
	return {
		variant: pick(node.variant, NOTE_IDS, "note"),
		title: str(node.title, 300).trim(),
		hideTitle: truthy(node.hideTitle),
		titleTag: pick(node.titleTag, NOTE_TITLE_TAGS, "p"),
		body: str(node.body),
	};
}

const variantLabel = (v: NoteVariant) => NOTE_VARIANTS.find(([id]) => id === v)?.[1] ?? "Note";

/** `<aside>` labelled by its title (or the variant name when the title is hidden). */
export function renderNoteHtml(note: Note, id: string): string {
	const body = renderRich(note.body);
	const title = renderRich(note.title || escapeHtml(variantLabel(note.variant)), { inline: true });
	if (!body && !note.title) return "";
	const tag = note.titleTag;
	const labelled = note.hideTitle ? `aria-label="${escapeHtml(plainText(note.title) || variantLabel(note.variant))}"` : `aria-labelledby="${escapeHtml(id)}"`;
	const heading = note.hideTitle ? "" : `<${tag} class="cw-note__title" id="${escapeHtml(id)}">${title}</${tag}>`;
	return `<aside class="cw-note cw-note--${note.variant}" ${labelled}>${heading}${body ? `<div class="cw-note__body">${body}</div>` : ""}</aside>`;
}

// ── Details / disclosure ─────────────────────────────────────────

export const DETAILS_VARIANTS = [
	["details", "Details"],
	["transcript", "Transcript"],
] as const;
export type DetailsVariant = (typeof DETAILS_VARIANTS)[number][0];

export interface Details {
	variant: DetailsVariant;
	summary: string;
	body: string;
	open: boolean;
}

export const DEFAULT_SUMMARY: Record<DetailsVariant, string> = { details: "Details", transcript: "Read the transcript" };

export function normalizeDetails(node: Record<string, unknown>): Details {
	const variant = pick(node.variant, DETAILS_VARIANTS.map(([v]) => v), "details");
	return { variant, summary: str(node.summary, 500).trim(), body: str(node.body), open: truthy(node.open) };
}

/** Native <details>/<summary>: keyboard and screen reader support come with it. */
export function renderDetailsHtml(d: Details): string {
	const body = renderRich(d.body);
	if (!body && !d.summary) return "";
	const summary = renderRich(d.summary || DEFAULT_SUMMARY[d.variant], { inline: true });
	return `<details class="cw-details cw-details--${d.variant}"${d.open ? " open" : ""}><summary class="cw-details__summary">${summary}</summary><div class="cw-details__body">${body}</div></details>`;
}

// ── Affiliate disclosure ─────────────────────────────────────────

export const DISCLOSURE_KINDS = [
	["affiliate", "Affiliate links"],
	["amazon", "Amazon Associates"],
] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number][0];

export interface DisclosureSettings {
	/** Rich inline text for affiliate links. */
	affiliateText: string;
	/** Rich inline text for Amazon Associates links. */
	amazonText: string;
	/** Optional page explaining the site's disclosures, linked after the text. */
	linkUrl: string;
	linkText: string;
}

export const DEFAULT_DISCLOSURE: DisclosureSettings = {
	affiliateText: "This page contains affiliate links. If you buy something through one of them, we may earn a commission at no extra cost to you.",
	amazonText: "As an Amazon Associate I earn from qualifying purchases.",
	linkUrl: "",
	linkText: "Learn more",
};

export const MAX_DISCLOSURE_TEXT = 1000;

export function normalizeDisclosureSettings(value: unknown): DisclosureSettings {
	const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const text = (x: unknown, fallback: string) => (typeof x === "string" && x.trim() ? x.trim().slice(0, MAX_DISCLOSURE_TEXT) : fallback);
	const url = typeof v.linkUrl === "string" ? (safeUrl(v.linkUrl.trim()) ?? "") : "";
	return {
		affiliateText: text(v.affiliateText, DEFAULT_DISCLOSURE.affiliateText),
		amazonText: text(v.amazonText, DEFAULT_DISCLOSURE.amazonText),
		linkUrl: url,
		linkText: text(v.linkText, DEFAULT_DISCLOSURE.linkText).slice(0, 100),
	};
}

export interface Disclosure {
	kind: DisclosureKind;
	/** This block's own wording; empty = the site's. */
	text: string;
}

export function normalizeDisclosure(node: Record<string, unknown>): Disclosure {
	return { kind: pick(node.kind, DISCLOSURE_KINDS.map(([k]) => k), "affiliate"), text: str(node.text, MAX_DISCLOSURE_TEXT).trim() };
}

export function renderDisclosureHtml(d: Disclosure, s: DisclosureSettings): string {
	const text = renderRich(d.text || (d.kind === "amazon" ? s.amazonText : s.affiliateText), { inline: true });
	if (!text) return "";
	const link = s.linkUrl ? ` <a class="cw-disclosure__link" href="${escapeHtml(s.linkUrl)}">${escapeHtml(s.linkText || DEFAULT_DISCLOSURE.linkText)}</a>` : "";
	const label = d.kind === "amazon" ? "Amazon Associates disclosure" : "Affiliate disclosure";
	return `<aside class="cw-disclosure cw-disclosure--${d.kind}" aria-label="${label}"><p class="cw-disclosure__text">${text}${link}</p></aside>`;
}

// ── Quote with citation ──────────────────────────────────────────

export interface Quote {
	quote: string;
	/** Rich inline: who said it (may hold a link). */
	citation: string;
	/** The source's URL, for the blockquote's cite attribute. */
	sourceUrl: string;
}

export function normalizeQuote(node: Record<string, unknown>): Quote {
	const url = str(node.sourceUrl, 2000).trim();
	const safe = url ? safeUrl(url) : null;
	return { quote: str(node.quote), citation: str(node.citation, 2000).trim(), sourceUrl: safe && /^(?:https?:)?\/\//i.test(safe) ? safe : safe?.startsWith("/") ? safe : "" };
}

/** `<figure><blockquote cite>…</blockquote><figcaption><cite>…</cite></figcaption></figure>`, like WordPress's custom block. */
export function renderQuoteHtml(q: Quote): string {
	const body = renderRich(q.quote);
	if (!body) return "";
	const caption = renderRich(q.citation, { inline: true });
	return `<figure class="cw-quote"><blockquote class="cw-quote__text"${q.sourceUrl ? ` cite="${escapeHtml(q.sourceUrl)}"` : ""}>${body}</blockquote>${
		caption ? `<figcaption class="cw-quote__caption"><cite>${caption}</cite></figcaption>` : ""
	}</figure>`;
}

// ── CSS ──────────────────────────────────────────────────────────

/**
 * One stylesheet for all four blocks, printed once per page before the first
 * one. Theme-agnostic: colors are mixed from the text color (currentColor), so
 * the blocks follow the theme's light or dark text; each variant adds a hue
 * through a custom property a site can override (--cw-note-accent, …).
 */
export const CONTENT_BLOCKS_CSS = `.cw-note,.cw-details,.cw-disclosure,.cw-quote{box-sizing:border-box;margin-block:1.5em}
.cw-note{--cw-note-accent:#2f6fde;--cw-note-mix:9%;padding:1em 1.25em;border:1px solid color-mix(in srgb,var(--cw-note-accent) 35%,transparent);border-inline-start:4px solid var(--cw-note-accent);border-radius:.5em;background:color-mix(in srgb,var(--cw-note-accent) var(--cw-note-mix),transparent)}
.cw-note--editor{--cw-note-accent:#8a6a00}
.cw-note--tip{--cw-note-accent:#1f8a4c}
.cw-note--warning{--cw-note-accent:#c2410c}
@media (prefers-color-scheme:dark){.cw-note{--cw-note-mix:16%}.cw-note--editor{--cw-note-accent:#d9b22b}.cw-note--note{--cw-note-accent:#6aa0ff}.cw-note--tip{--cw-note-accent:#4cc27e}.cw-note--warning{--cw-note-accent:#f08a4b}}
.cw-note .cw-note__title{margin:0 0 .4em;padding:0;font-size:1em;font-weight:700;line-height:1.35}
.cw-note .cw-note__body>:first-child{margin-top:0}
.cw-note .cw-note__body>:last-child{margin-bottom:0}
.cw-details{--cw-details-line:color-mix(in srgb,currentColor 18%,transparent);border:1px solid var(--cw-details-line);border-radius:.5em;padding:0 1.25em}
.cw-details .cw-details__summary{cursor:pointer;padding:.75em 0;font-weight:600}
.cw-details .cw-details__summary:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:.25em}
.cw-details[open]>.cw-details__summary{border-bottom:1px solid var(--cw-details-line);margin-bottom:.75em}
.cw-details .cw-details__body{padding-bottom:.75em}
.cw-details .cw-details__body>:first-child{margin-top:0}
.cw-details--transcript .cw-details__body{padding:.75em 1em;margin-bottom:.75em;border-radius:.375em;background:color-mix(in srgb,currentColor 5%,transparent)}
.cw-disclosure .cw-disclosure__text{margin:0;font-size:.875em;line-height:1.5;color:color-mix(in srgb,currentColor 68%,transparent)}
.cw-disclosure a{color:inherit;text-decoration-thickness:1px;text-underline-offset:.15em}
.cw-quote{margin-inline:0}
.cw-quote .cw-quote__text{margin:0;padding:.25em 0 .25em 1.25em;border-inline-start:4px solid color-mix(in srgb,currentColor 30%,transparent);font-size:1.05em}
.cw-quote .cw-quote__text>:first-child{margin-top:0}
.cw-quote .cw-quote__text>:last-child{margin-bottom:0}
.cw-quote .cw-quote__caption{margin:.6em 0 0 1.5em;font-size:.9em;color:color-mix(in srgb,currentColor 72%,transparent)}
.cw-quote .cw-quote__caption::before{content:"— "}
.cw-quote .cw-quote__caption cite{font-style:normal}`;

// ── Samples for the admin preview ────────────────────────────────

export const SAMPLE_NOTE: Note = {
	variant: "note",
	title: "",
	hideTitle: false,
	titleTag: "p",
	body: "Notes stand apart from the article. Use them for an aside, an update, or a tip, with **bold** and [links](https://example.com/).",
};

export const SAMPLE_DETAILS: Details = {
	variant: "details",
	summary: "What's included?",
	body: "Everything in the box: the device, a charging cable and a quick start guide.\n\nOpen and close it with a click or the keyboard.",
	open: true,
};

export const SAMPLE_QUOTE: Quote = {
	quote: "Make it work, make it right, make it fast.",
	citation: "Kent Beck",
	sourceUrl: "",
};
