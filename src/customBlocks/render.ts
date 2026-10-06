/**
 * Custom Blocks markup and CSS, shared by the Astro components
 * (src/astro/customBlocks) and the live previews on the Custom Blocks admin
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
	testimonial: "coywolf-testimonial",
	podcast: "coywolf-podcast",
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

// ── Testimonial ──────────────────────────────────────────────────

export interface Testimonial {
	/** Rich text: what the person said. */
	quote: string;
	/** Plain text. */
	name: string;
	/** Plain text: role, company, … */
	title: string;
	/** Headshot URL (http(s) or site-relative), or empty. */
	photo: string;
	/** Link for the name (e.g. a social profile), or empty. */
	nameUrl: string;
	/** Link for the title (e.g. the company's site), or empty. */
	titleUrl: string;
}

/** An http(s) or site-relative URL, else "". */
export function linkUrl(value: unknown): string {
	const raw = typeof value === "string" ? value.trim() : value && typeof value === "object" && "url" in value ? String((value as { url: unknown }).url ?? "").trim() : "";
	if (!raw) return "";
	const safe = safeUrl(raw);
	return safe && (/^https?:\/\/[^\s]+$/i.test(safe) || /^\/(?!\/)\S*$/.test(safe)) ? safe : "";
}

export function normalizeTestimonial(node: Record<string, unknown>): Testimonial {
	return {
		quote: str(node.quote),
		name: str(node.name, 200).trim(),
		title: str(node.title, 300).trim(),
		photo: linkUrl(node.photo),
		nameUrl: linkUrl(node.nameUrl),
		titleUrl: linkUrl(node.titleUrl),
	};
}

/**
 * `<figure><blockquote>…</blockquote><figcaption>photo, name, title</figcaption></figure>`.
 * The photo's alt is empty: the name right after it says who it is. No
 * schema: testimonials a site picks about itself aren't eligible for review
 * rich results. `photoSrc` replaces the photo's URL with resized copies (the
 * media host's 64px and 128px squares) when the caller has them.
 */
export function renderTestimonialHtml(t: Testimonial, photoSrc?: { src: string; srcset?: string } | null): string {
	const body = renderRich(t.quote);
	if (!body) return "";
	const link = (url: string, text: string) => (url ? `<a href="${escapeHtml(url)}">${text}</a>` : text);
	const src = photoSrc?.src || t.photo;
	const srcset = photoSrc?.src && photoSrc.srcset ? ` srcset="${escapeHtml(photoSrc.srcset)}"` : "";
	const photo = t.photo ? `<img class="cw-testimonial__photo" src="${escapeHtml(src)}"${srcset} alt="" width="64" height="64" loading="lazy" decoding="async">` : "";
	const who =
		t.name || t.title
			? `<span class="cw-testimonial__who">${t.name ? `<span class="cw-testimonial__name">${link(t.nameUrl, escapeHtml(t.name))}</span>` : ""}${
					t.title ? `<span class="cw-testimonial__title">${link(t.titleUrl, escapeHtml(t.title))}</span>` : ""
				}</span>`
			: "";
	return `<figure class="cw-testimonial"><blockquote class="cw-testimonial__quote">${body}</blockquote>${
		photo || who ? `<figcaption class="cw-testimonial__person">${photo}${who}</figcaption>` : ""
	}</figure>`;
}

// ── Podcast links ────────────────────────────────────────────────

export const PODCAST_SERVICES = [
	["apple", "Apple Podcasts"],
	["spotify", "Spotify"],
	["youtube", "YouTube"],
	["amazon", "Amazon Music"],
	["overcast", "Overcast"],
	["pocketCasts", "Pocket Casts"],
	["rss", "RSS feed"],
] as const;
export type PodcastService = (typeof PODCAST_SERVICES)[number][0];
export type PodcastLinks = Record<PodcastService, string>;
export const PODCAST_HEADING_TAGS = ["h2", "h3", "h4", "p"] as const;
export type PodcastHeadingTag = (typeof PODCAST_HEADING_TAGS)[number];

export interface PodcastSettings {
	/** Plain text. */
	heading: string;
	/** "p": bold text. */
	headingTag: PodcastHeadingTag;
	showIcons: boolean;
	links: PodcastLinks;
}

const noLinks = (): PodcastLinks => Object.fromEntries(PODCAST_SERVICES.map(([id]) => [id, ""])) as PodcastLinks;

export const DEFAULT_PODCAST: PodcastSettings = { heading: "Subscribe to the podcast", headingTag: "h2", showIcons: true, links: noLinks() };

function podcastLinks(value: unknown): PodcastLinks {
	const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	const links = noLinks();
	for (const [id] of PODCAST_SERVICES) links[id] = linkUrl(v[id]);
	return links;
}

export function normalizePodcastSettings(value: unknown): PodcastSettings {
	const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
	return {
		heading: str(v.heading, 200).trim() || DEFAULT_PODCAST.heading,
		headingTag: pick(v.headingTag, PODCAST_HEADING_TAGS, DEFAULT_PODCAST.headingTag),
		showIcons: v.showIcons === undefined ? DEFAULT_PODCAST.showIcons : truthy(v.showIcons),
		links: podcastLinks(v.links),
	};
}

export interface Podcast {
	/** "site": the links on the Custom Blocks page; "block": this block's own. */
	source: "site" | "block";
	/** Plain text; empty = the site's heading. */
	heading: string;
	links: PodcastLinks;
}

export function normalizePodcast(node: Record<string, unknown>): Podcast {
	return { source: pick(node.source, ["site", "block"] as const, "site"), heading: str(node.heading, 200).trim(), links: podcastLinks(node) };
}

const svg = (body: string) =>
	`<svg class="cw-podcast__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/** Simple line icons drawn for the pack (not the services' logos), with the service's name always next to them. */
export const PODCAST_ICONS: Record<PodcastService, string> = {
	apple: svg('<circle cx="12" cy="10" r="2.2" fill="currentColor" stroke="none"/><path d="M12 14v7"/><path d="M8.2 15.6a5.6 5.6 0 1 1 7.6 0"/><path d="M5.6 18.6a9.2 9.2 0 1 1 12.8 0"/>'),
	spotify: svg('<circle cx="12" cy="12" r="9.5"/><path d="M7 9.6c3.4-1 6.9-.7 10 1"/><path d="M7.6 12.9c2.9-.8 5.7-.5 8.2.8"/><path d="M8.2 16c2.3-.6 4.4-.4 6.4.6"/>'),
	youtube: svg('<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor"/>'),
	amazon: svg('<path d="M9 17V5.5l10-2V15"/><circle cx="6.5" cy="17" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>'),
	overcast: svg('<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="11" r="1.4" fill="currentColor" stroke="none"/><path d="M12 13l-2.4 6.6M12 13l2.4 6.6"/><path d="M9.2 8.2a4 4 0 0 0 0 5.6M14.8 8.2a4 4 0 0 1 0 5.6"/>'),
	pocketCasts: svg('<circle cx="12" cy="12" r="9.5"/><path d="M12 17.5a5.5 5.5 0 1 1 5.5-5.5"/><path d="M12 14.5a2.5 2.5 0 1 1 2.5-2.5"/>'),
	rss: svg('<circle cx="5.5" cy="18.5" r="1.6" fill="currentColor" stroke="none"/><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/>'),
};

/** A labelled `<section>` with a heading and a list of links, each named by its service. Empty when there are no links. */
export function renderPodcastHtml(p: Podcast, s: PodcastSettings, id: string): string {
	const links = p.source === "block" ? p.links : s.links;
	const items = PODCAST_SERVICES.filter(([svc]) => links[svc]).map(
		([svc, label]) =>
			`<li><a class="cw-podcast__link cw-podcast__link--${svc}" href="${escapeHtml(links[svc])}"${svc === "rss" ? ' type="application/rss+xml"' : ""}>${
				s.showIcons ? PODCAST_ICONS[svc] : ""
			}<span>${escapeHtml(label)}</span></a></li>`,
	);
	if (!items.length) return "";
	const tag = s.headingTag;
	const heading = escapeHtml(p.heading || s.heading || DEFAULT_PODCAST.heading);
	return `<section class="cw-podcast" aria-labelledby="${escapeHtml(id)}"><${tag} class="cw-podcast__title" id="${escapeHtml(id)}">${heading}</${tag}><ul class="cw-podcast__links" role="list">${items.join("")}</ul></section>`;
}

// ── CSS ──────────────────────────────────────────────────────────

/**
 * One stylesheet for all the blocks, printed once per page before the first
 * one. Theme-agnostic: colors are mixed from the text color (currentColor), so
 * the blocks follow the theme's light or dark text; each variant adds a hue
 * through a custom property a site can override (--cw-note-accent, …).
 */
export const CUSTOM_BLOCKS_CSS = `.cw-note,.cw-details,.cw-disclosure,.cw-quote,.cw-testimonial,.cw-podcast{box-sizing:border-box;margin-block:1.5em}
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
.cw-disclosure .cw-disclosure__text{margin:0;font-size:.875em;line-height:1.5;color:color-mix(in srgb,currentColor 82%,transparent)}
.cw-disclosure a{color:inherit;text-decoration-thickness:1px;text-underline-offset:.15em}
.cw-quote{margin-inline:0}
.cw-quote .cw-quote__text{margin:0;padding:.25em 0 .25em 1.25em;border-inline-start:4px solid color-mix(in srgb,currentColor 30%,transparent);font-size:1.05em}
.cw-quote .cw-quote__text>:first-child{margin-top:0}
.cw-quote .cw-quote__text>:last-child{margin-bottom:0}
.cw-quote .cw-quote__caption{margin:.6em 0 0 1.5em;font-size:.9em;color:color-mix(in srgb,currentColor 82%,transparent)}
.cw-quote .cw-quote__caption::before{content:"— "}
.cw-quote .cw-quote__caption cite{font-style:normal}
.cw-testimonial{margin-inline:0;text-align:start}
.cw-testimonial .cw-testimonial__quote{position:relative;margin:0 0 1.4em;padding:1em 1.25em;border:0;border-radius:.75em;background:color-mix(in srgb,currentColor 6%,transparent);font-size:1.05em}
.cw-testimonial .cw-testimonial__quote::after{content:"";position:absolute;top:100%;left:1.75em;width:1.1em;height:.7em;background:inherit;clip-path:polygon(0 0,100% 0,0 100%)}
.cw-testimonial .cw-testimonial__quote>:first-child{margin-top:0}
.cw-testimonial .cw-testimonial__quote>:last-child{margin-bottom:0}
.cw-testimonial .cw-testimonial__quote>:first-child::before{content:"\\201C";content:"\\201C"/""}
.cw-testimonial .cw-testimonial__quote>:last-child::after{content:"\\201D";content:"\\201D"/""}
.cw-testimonial .cw-testimonial__person{display:flex;align-items:center;gap:.75em;margin:0 0 0 1em;font-size:.9em;line-height:1.35}
.cw-testimonial .cw-testimonial__photo{flex:none;width:3.5em;height:3.5em;margin:0;border-radius:50%;object-fit:cover;background:color-mix(in srgb,currentColor 12%,transparent)}
.cw-testimonial .cw-testimonial__name{display:block;font-weight:700;text-transform:uppercase;letter-spacing:.02em}
.cw-testimonial .cw-testimonial__title{display:block;color:color-mix(in srgb,currentColor 82%,transparent)}
.cw-testimonial .cw-testimonial__person a{color:inherit;text-decoration-thickness:1px;text-underline-offset:.15em}
.cw-podcast .cw-podcast__title{margin:0 0 .6em;font-weight:700}
.cw-podcast p.cw-podcast__title{font-size:1em}
.cw-podcast .cw-podcast__links{display:flex;flex-wrap:wrap;gap:.5em;margin:0;padding:0;list-style:none}
.cw-podcast .cw-podcast__links li{margin:0;padding:0}
.cw-podcast .cw-podcast__link{display:inline-flex;align-items:center;gap:.45em;padding:.4em .9em;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:999px;color:inherit;font-size:.95em;line-height:1.3;text-decoration:none}
.cw-podcast .cw-podcast__link:hover{background:color-mix(in srgb,currentColor 7%,transparent)}
.cw-podcast .cw-podcast__link:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.cw-podcast .cw-podcast__icon{flex:none;width:1.15em;height:1.15em}`;

// ── Samples for the admin preview ────────────────────────────────

export const SAMPLE_TESTIMONIAL: Testimonial = {
	quote: "Clear, practical and always worth the read. I learn something new every time.",
	name: "Alex Rivera",
	title: "Head of Content, Example Co.",
	photo: "",
	nameUrl: "https://example.com/alex/",
	titleUrl: "",
};

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
