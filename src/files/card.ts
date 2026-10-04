/**
 * Download card markup and CSS, shared by the coywolf-file block
 * (src/astro/files/FileCard.astro) and the live preview on the Files
 * settings tab, so the preview is exactly what the site prints. No imports
 * beyond format.ts, so `node --test` can load it.
 */
import { extensionOf, formatDate, formatSize, iconFor, safeColor } from "./format.js";

export interface FileCardData {
	title: string;
	description: string;
	/** File name, for the type badge. */
	name: string;
	size: number;
	uploadedAt: string;
	/** Download link (site-relative). */
	href: string;
	/** Absolute download URL for Copy link. */
	absolute: string;
}

export interface FileCardOptions {
	scheme: "auto" | "light" | "dark";
	/** Hex accent, or "" for the default. */
	accent: string;
	showIcon?: boolean;
	showDescription?: boolean;
	showMeta?: boolean;
	showDownload?: boolean;
	showCopyLink?: boolean;
}

const escapeHtml = (text: string) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const ICON_DOWNLOAD =
	'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>';
const ICON_LINK =
	'<svg class="cw-file__ic-link" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>';
const ICON_CHECK =
	'<svg class="cw-file__ic-check" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5" /></svg>';

/** "PDF · 2.4 MB · Uploaded Mar 4, 2026". */
export function fileMeta(name: string, size: number, uploadedAt: string): string {
	const ext = extensionOf(name);
	const uploaded = formatDate(uploadedAt);
	return [ext.toUpperCase(), size > 0 ? formatSize(size) : "", uploaded ? `Uploaded ${uploaded}` : ""].filter(Boolean).join(" · ");
}

/** The card's HTML. Options left undefined count as on, like the block's toggles. */
export function renderFileCardHtml(card: FileCardData, o: FileCardOptions): string {
	const on = (value: boolean | undefined) => value !== false;
	const icon = iconFor(extensionOf(card.name));
	const title = escapeHtml(card.title);
	const meta = fileMeta(card.name, card.size, card.uploadedAt);
	const scheme = ["auto", "light", "dark"].includes(o.scheme) ? o.scheme : "auto";
	const accent = safeColor(o.accent);
	const parts: string[] = [];
	if (on(o.showIcon))
		parts.push(
			`<div class="cw-file__icon"><svg width="40" height="48" viewBox="0 0 40 48" fill="none" aria-hidden="true" focusable="false"><path d="M10 3 h14 l10 10 v28 a4 4 0 0 1 -4 4 H10 a4 4 0 0 1 -4 -4 V7 a4 4 0 0 1 4 -4 z" fill="var(--cw-file-page)" stroke="var(--cw-file-stroke)" stroke-width="1.5" /><path d="M24 3 L24 13 L34 13" fill="var(--cw-file-fold)" stroke="var(--cw-file-stroke)" stroke-width="1.5" stroke-linejoin="round" /><rect x="2" y="26" width="27" height="15" rx="3.5" fill="${escapeHtml(icon.color)}" /><text x="15.5" y="36.5" text-anchor="middle" font-size="8.5" font-weight="700" fill="#fff" style="letter-spacing:0.02em">${escapeHtml(icon.label)}</text></svg></div>`,
		);
	parts.push(
		`<div class="cw-file__body"><div class="cw-file__name">${title}</div>${
			on(o.showDescription) && card.description ? `<div class="cw-file__desc">${escapeHtml(card.description)}</div>` : ""
		}${on(o.showMeta) && meta ? `<div class="cw-file__meta">${escapeHtml(meta)}</div>` : ""}</div>`,
	);
	const actions = [
		on(o.showDownload)
			? `<a class="cw-file__btn cw-file__download" href="${escapeHtml(card.href)}" download aria-label="Download ${title}" title="Download">${ICON_DOWNLOAD}</a>`
			: "",
		on(o.showCopyLink)
			? `<button type="button" class="cw-file__btn cw-file__copy" data-cw-file-url="${escapeHtml(card.absolute)}" aria-label="Copy download link for ${title}" title="Copy link">${ICON_LINK}${ICON_CHECK}</button>`
			: "",
	].join("");
	parts.push(`<div class="cw-file__actions">${actions}</div>`);
	parts.push('<span class="cw-file__sr" role="status" aria-live="polite"></span>');
	return `<div class="cw-file cw-file--${scheme}"${accent ? ` style="--cw-file-accent:${accent}"` : ""}>${parts.join("")}</div>`;
}

/** Sample file for the admin preview. */
export const SAMPLE_FILE: FileCardData = {
	title: "Annual report 2026.pdf",
	description: "Our year in numbers, with highlights from every team.",
	name: "annual-report-2026.pdf",
	size: 2_516_582,
	uploadedAt: "2026-03-04T12:00:00Z",
	href: "#",
	absolute: "https://example.com/download/sample/annual-report-2026.pdf",
};

export const FILE_CSS = `.cw-file {
	--cw-file-bg: #fff;
	--cw-file-border: #e6e6e6;
	--cw-file-text: #1e2a3b;
	--cw-file-muted: #5b6472;
	--cw-file-hover: rgba(0, 0, 0, 0.06);
	--cw-file-accent: #007392;
	--cw-file-page: #fff;
	--cw-file-stroke: #d0d5dd;
	--cw-file-fold: #eaecf0;
	position: relative;
	display: flex;
	align-items: center;
	gap: 1rem;
	margin: 0 0 1.25em;
	padding: 12px 14px;
	border: 1px solid var(--cw-file-border);
	border-radius: 12px;
	background: var(--cw-file-bg);
	color: var(--cw-file-text);
}
.cw-file--dark {
	--cw-file-bg: #1b1b1c;
	--cw-file-border: #343437;
	--cw-file-text: #d5d8dc;
	--cw-file-muted: #9ea3a8;
	--cw-file-hover: rgba(255, 255, 255, 0.08);
	--cw-file-accent: #21a1c4;
	--cw-file-page: #e7eaee;
	--cw-file-stroke: #aab1ba;
	--cw-file-fold: #d0d5dd;
}
@media (prefers-color-scheme: dark) {
	.cw-file--auto {
		--cw-file-bg: #1b1b1c;
		--cw-file-border: #343437;
		--cw-file-text: #d5d8dc;
		--cw-file-muted: #9ea3a8;
		--cw-file-hover: rgba(255, 255, 255, 0.08);
		--cw-file-accent: #21a1c4;
		--cw-file-page: #e7eaee;
		--cw-file-stroke: #aab1ba;
		--cw-file-fold: #d0d5dd;
	}
}
.cw-file__icon {
	flex-shrink: 0;
	line-height: 0;
}
.cw-file__icon svg {
	display: block;
	width: 40px;
	height: 48px;
}
.cw-file__body {
	flex: 1 1 auto;
	min-width: 0;
}
.cw-file__name {
	font-weight: 500;
	line-height: 1.35;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cw-file__desc,
.cw-file__meta {
	margin-top: 2px;
	font-size: 0.875em;
	line-height: 1.4;
	color: var(--cw-file-muted);
}
.cw-file__meta {
	font-variant-numeric: tabular-nums;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.cw-file__actions {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: 4px;
}
.cw-file__btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	margin: 0;
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: transparent;
	color: var(--cw-file-muted);
	cursor: pointer;
	text-decoration: none;
	box-shadow: none;
	appearance: none;
	transition: background 0.15s ease, color 0.15s ease;
}
.cw-file__btn:hover {
	background: var(--cw-file-hover);
	color: var(--cw-file-text);
}
.cw-file__btn:focus-visible {
	outline: 2px solid var(--cw-file-accent);
	outline-offset: 2px;
}
.cw-file__download,
.cw-file__copy.is-copied {
	color: var(--cw-file-accent);
}
.cw-file__btn svg {
	display: block;
}
.cw-file__copy .cw-file__ic-check,
.cw-file__copy.is-copied .cw-file__ic-link {
	display: none;
}
.cw-file__copy.is-copied .cw-file__ic-check {
	display: block;
}
.cw-file__sr {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}
@media (prefers-reduced-motion: reduce) {
	.cw-file__btn {
		transition: none;
	}
}`;
