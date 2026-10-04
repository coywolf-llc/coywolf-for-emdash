/**
 * Pure helpers shared by the download card, the download middleware and the
 * admin page: file-type badges, sizes, safe names, and Content-Disposition.
 * No imports, so `node --test` can load this file directly.
 */

/** Badge color per extension (the palette Coywolf Files uses in WordPress). */
const ICON_COLORS: Record<string, string> = {};
const FAMILIES: Array<[string, string[]]> = [
	["#B42318", ["pdf"]],
	["#155EEF", ["doc", "docx", "rtf", "odt", "pages"]],
	["#475467", ["txt", "md"]],
	["#067647", ["xls", "xlsx", "csv", "ods", "numbers"]],
	["#C4320A", ["ppt", "pptx", "key", "odp"]],
	["#C11574", ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "heic", "bmp", "tif", "tiff"]],
	["#93264A", ["mp4", "mov", "webm", "mkv", "avi", "m4v"]],
	["#026AA2", ["mp3", "wav", "m4a", "aac", "ogg", "flac"]],
	["#6941E0", ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "dmg", "iso"]],
	["#B54708", ["json", "js", "jsx", "ts", "tsx", "html", "css", "xml", "yml", "yaml"]],
];
for (const [color, exts] of FAMILIES) for (const ext of exts) ICON_COLORS[ext] = color;

export const DEFAULT_ICON_COLOR = "#667085";

/** Lowercase extension of a file name, without the dot ("" when there is none). */
export function extensionOf(name: string): string {
	const match = /\.([a-z0-9]+)$/i.exec(String(name ?? "").trim());
	return match ? match[1].toLowerCase() : "";
}

/** Badge color and label (at most four characters) for an extension. */
export function iconFor(ext: string): { color: string; label: string } {
	const clean = String(ext ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	return { color: ICON_COLORS[clean] ?? DEFAULT_ICON_COLOR, label: clean ? clean.toUpperCase().slice(0, 4) : "FILE" };
}

/** 1024-based size with one decimal, e.g. "2.4 MB". */
export function formatSize(bytes: number): string {
	const n = Math.max(0, Math.floor(Number(bytes) || 0));
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB", "PB"];
	let value = n / 1024;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(1)} ${units[i]}`;
}

/** "Mar 4, 2026" (UTC, so server and build output agree). */
export function formatDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/**
 * A file name that is safe in an object key and a URL path segment: ASCII
 * letters, digits, dot, dash and underscore. Keeps the extension.
 */
export function safeFilename(name: string): string {
	const base = String(name ?? "")
		.split(/[\\/]/)
		.pop()!
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/-+\./g, ".")
		.replace(/^[-.]+|[-.]+$/g, "");
	return (base || "file").slice(0, 120);
}

/** RFC 3986 percent-encoding as RFC 5987 requires (attr-char only). */
function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Content-Disposition for a download: an ASCII `filename` fallback plus a
 * UTF-8 `filename*` (RFC 6266 / RFC 5987) when the name isn't plain ASCII.
 */
export function contentDisposition(filename: string, type: "attachment" | "inline" = "attachment"): string {
	const name = String(filename ?? "")
		.replace(/[\r\n\t\0]/g, " ")
		.split(/[\\/]/)
		.pop()!
		.trim() || "download";
	const fallback = name
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\x20-\x7e]/g, "_")
		.replace(/["\\]/g, "_")
		.replace(/%/g, "_");
	if (fallback === name) return `${type}; filename="${fallback}"`;
	return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/** Download URL path: /<base>/<id>/<filename>. */
export function downloadPath(base: string, id: string, filename: string): string {
	return `/${base}/${encodeURIComponent(id)}/${encodeURIComponent(safeFilename(filename))}`;
}

/** A valid base slug: one lowercase path segment. */
export function normalizeBase(value: unknown): string {
	const slug = String(value ?? "")
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) && !slug.startsWith("_") ? slug : "download";
}

/** A #rgb / #rrggbb accent color, or "" when the value isn't one. */
export function safeColor(value: unknown): string {
	const color = String(value ?? "").trim();
	return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : "";
}

/** Large-upload ids: "f" + 15 lowercase base-32 characters. Media library ids are ULIDs (26 uppercase). */
export const UPLOAD_ID = /^f[a-z2-7]{15}$/;
export const MEDIA_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isFileId(id: string): boolean {
	return UPLOAD_ID.test(id) || MEDIA_ID.test(id);
}

export function newUploadId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	const bytes = crypto.getRandomValues(new Uint8Array(15));
	let id = "f";
	for (const b of bytes) id += alphabet[b & 31];
	return id;
}

/** Parse /<base>/<id>[/<filename>] (null when it isn't a download URL). */
export function parseDownloadPath(pathname: string, base: string): { id: string; filename: string | null } | null {
	const prefix = `/${base}/`;
	if (!pathname.startsWith(prefix)) return null;
	const rest = pathname.slice(prefix.length).split("/");
	if (rest.length > 2 || !rest[0]) return null;
	let id: string;
	try {
		id = decodeURIComponent(rest[0]);
	} catch {
		return null;
	}
	if (!isFileId(id)) return null;
	return { id, filename: rest[1] ? rest[1] : null };
}
