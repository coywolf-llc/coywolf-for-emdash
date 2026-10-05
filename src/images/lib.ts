/**
 * Clean image URLs: resized copies of media-library images at
 *
 *   /media/<file id>-<width>x<height>.<format>     (cropped to fill)
 *   /media/<file id>-<width>w.<format>              (width only, keeps the ratio)
 *
 * instead of Astro's /_image?href=…&w=…&h=… endpoint. Pure helpers (no
 * imports) so tests can load them; the middleware is in pack.ts.
 */

export const IMAGE_PATH = "/media/";
/** Media library files: /_emdash/api/media/file/<id>.<ext> (EmDash's media route). */
const MEDIA_FILE = /^(?:https?:\/\/[^/]+)?\/_emdash\/api\/media\/file\/([A-Za-z0-9_-]+)\.([a-z0-9]{2,5})(?:[?#].*)?$/i;
const CLEAN = /^\/media\/([A-Za-z0-9_-]+)-(?:(\d{1,4})x(\d{1,4})|(\d{1,4})w)\.(webp|avif|jpe?g|png)$/i;
export const MAX_DIMENSION = 2560;
export const FORMATS: Record<string, string> = { webp: "image/webp", avif: "image/avif", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

export interface ImageRequest {
	id: string;
	width: number;
	height?: number;
	format: string;
}

/** The file id and extension of a media-library URL, or null for anything else. */
export function mediaFile(src: string | null | undefined): { id: string; ext: string } | null {
	const m = MEDIA_FILE.exec(String(src ?? "").trim());
	return m ? { id: m[1], ext: m[2].toLowerCase() } : null;
}

/** Build a clean URL; null when `src` isn't a media-library file or the size is out of range. */
export function cleanImagePath(src: string | null | undefined, options: { width: number; height?: number; format?: string }): string | null {
	const file = mediaFile(src);
	if (!file) return null;
	const width = Math.round(options.width);
	const height = options.height === undefined ? undefined : Math.round(options.height);
	if (!(width >= 1 && width <= MAX_DIMENSION) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	const format = (options.format ?? "webp").toLowerCase();
	if (!FORMATS[format]) return null;
	return `${IMAGE_PATH}${file.id}-${height === undefined ? `${width}w` : `${width}x${height}`}.${format}`;
}

/** Parse a clean URL path; null when it isn't one (or the size is out of range). */
export function parseImagePath(pathname: string): ImageRequest | null {
	const m = CLEAN.exec(pathname);
	if (!m) return null;
	const width = Number(m[2] ?? m[4]);
	const height = m[3] ? Number(m[3]) : undefined;
	if (!(width >= 1 && width <= MAX_DIMENSION) || (height !== undefined && !(height >= 1 && height <= MAX_DIMENSION))) return null;
	return { id: m[1], width, height, format: m[5].toLowerCase() };
}
