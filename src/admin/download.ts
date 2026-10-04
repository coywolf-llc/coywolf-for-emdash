/** Save text the admin built in the browser (an export) as a file. */

/** Start a download of `content` as `filename`. CSV gets a byte-order mark so Excel reads it as UTF-8. */
export function saveFile(content: string | Blob, filename: string, type = "text/plain"): void {
	const blob =
		content instanceof Blob ? content : new Blob(type.startsWith("text/csv") ? ["﻿", content] : [content], { type: `${type};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.style.display = "none";
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Some browsers read the blob after click() returns.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** "2026-10-04", for export file names. */
export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

/** A host name for file names ("example.com" -> "example-com"); empty when there is none. */
export function siteSlug(): string {
	return typeof location === "undefined" ? "" : location.hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
}

