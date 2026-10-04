/**
 * Table of Contents markup and CSS, shared by the coywolf-toc block
 * (src/astro/headings/TableOfContents.astro) and the live preview on the
 * Headings & TOC admin page, so the preview is exactly what the site prints.
 * Only type imports, so `node --test` can load it.
 */
import type { TocDisplay, TocListStyle } from "./settings.js";
import type { TocNode } from "./toc.js";

export interface TocRenderOptions {
	title: string;
	showTitle: boolean;
	listStyle: TocListStyle;
	display: TocDisplay;
	smooth: boolean;
	/** Id for the title element (unique per block on a page). */
	titleId: string;
}

const escapeHtml = (text: string) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function listHtml(nodes: readonly TocNode[], ordered: boolean, root: boolean): string {
	const tag = ordered ? "ol" : "ul";
	const items = nodes
		.map(
			(n) =>
				`<li><a href="#${escapeHtml(n.id)}">${escapeHtml(n.text)}</a>${n.children.length ? listHtml(n.children, ordered, false) : ""}</li>`,
		)
		.join("");
	return `<${tag}${root ? ' class="cw-toc__list"' : ""}>${items}</${tag}>`;
}

/** The <nav> for a TOC tree. */
export function renderTocHtml(tree: readonly TocNode[], o: TocRenderOptions): string {
	const id = escapeHtml(o.titleId);
	const title = escapeHtml(o.title);
	const list = listHtml(tree, o.listStyle === "numbered", true);
	const labelled = o.display !== "open" || o.showTitle;
	const attrs = [
		`class="cw-toc cw-toc--${o.listStyle}"`,
		labelled ? `aria-labelledby="${id}"` : `aria-label="${title}"`,
		o.smooth ? "data-smooth" : "",
	]
		.filter(Boolean)
		.join(" ");
	const body =
		o.display === "open"
			? `${o.showTitle ? `<h2 id="${id}" class="cw-toc__title">${title}</h2>` : ""}${list}`
			: `<details class="cw-toc__details"${o.display === "collapsible" ? " open" : ""}><summary class="cw-toc__summary"><span id="${id}" class="cw-toc__title">${title}</span></summary>${list}</details>`;
	return `<nav ${attrs}>${body}</nav>`;
}

/** Sample headings for the admin preview (H2–H4, so level choices show). */
export const SAMPLE_TOC_HEADINGS = [
	{ level: 2, id: "jump-getting-started", text: "Getting started" },
	{ level: 3, id: "jump-what-you-need", text: "What you need" },
	{ level: 3, id: "jump-first-steps", text: "First steps" },
	{ level: 4, id: "jump-a-quick-tip", text: "A quick tip" },
	{ level: 2, id: "jump-how-it-works", text: "How it works" },
	{ level: 3, id: "jump-the-details", text: "The details" },
	{ level: 2, id: "jump-final-thoughts", text: "Final thoughts" },
];

export const TOC_CSS = `.cw-toc {
	--cw-toc-line: color-mix(in srgb, currentColor 18%, transparent);
	--cw-toc-bg: color-mix(in srgb, currentColor 4%, transparent);
	margin-block: 1.5em;
	padding: 1em 1.25em;
	border: 1px solid var(--cw-toc-line);
	border-radius: 0.5em;
	background: var(--cw-toc-bg);
}
@media (prefers-color-scheme: dark) {
	.cw-toc {
		--cw-toc-bg: color-mix(in srgb, currentColor 7%, transparent);
	}
}
.cw-toc .cw-toc__title {
	margin: 0 0 0.5em;
	font-size: 1.1em;
}
.cw-toc ul,
.cw-toc ol {
	margin: 0;
}
.cw-toc li {
	margin: 0.25em 0;
}
.cw-toc--none ul,
.cw-toc--numbered ol {
	list-style: none;
	padding-inline-start: 0;
}
.cw-toc--none li > ul,
.cw-toc--bulleted ul {
	padding-inline-start: 1.25em;
}
.cw-toc--numbered ol {
	counter-reset: cw-toc;
}
.cw-toc--numbered li > ol {
	padding-inline-start: 1.5em;
}
.cw-toc--numbered li {
	counter-increment: cw-toc;
}
.cw-toc--numbered li > a::before {
	content: counters(cw-toc, ".") ". ";
}
.cw-toc__summary {
	cursor: pointer;
}
.cw-toc__summary .cw-toc__title {
	display: inline;
	margin: 0;
	font-size: inherit;
	font-weight: 600;
}
.cw-toc__details[open] > .cw-toc__summary {
	margin-bottom: 0.5em;
}
@media (prefers-reduced-motion: no-preference) {
	html:has(.cw-toc[data-smooth]) {
		scroll-behavior: smooth;
	}
}`;
