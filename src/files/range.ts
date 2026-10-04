/**
 * HTTP byte ranges for downloads (RFC 9110 §14). Only single ranges are
 * served; multiple ranges, malformed headers and a mismatched If-Range fall
 * back to the full file (200). No imports, so `node --test` can load this file.
 */

export type ByteRange = { offset: number; end?: number } | { suffix: number };

/** Parse a Range header. Null means "ignore it and send the whole file". */
export function parseRange(header: string | null | undefined): ByteRange | null {
	if (!header) return null;
	const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
	if (!match) return null; // Malformed, another unit, or several ranges.
	const [, first, last] = match;
	if (first === "" && last === "") return null;
	if (first === "") {
		const suffix = Number(last);
		return suffix > 0 ? { suffix } : null;
	}
	const offset = Number(first);
	if (last === "") return { offset };
	const end = Number(last);
	return end >= offset ? { offset, end } : null;
}

/** The bytes a range covers in a file of `size`, clamped; null when unsatisfiable. */
export function resolveRange(range: ByteRange, size: number): { offset: number; length: number } | null {
	if ("suffix" in range) {
		if (size === 0) return null;
		const length = Math.min(range.suffix, size);
		return { offset: size - length, length };
	}
	if (range.offset >= size) return null;
	const end = Math.min(range.end ?? size - 1, size - 1);
	return { offset: range.offset, length: end - range.offset + 1 };
}

/**
 * Whether an If-Range validator still matches the file. A strong ETag must
 * match exactly; a date must equal Last-Modified (to the second). Weak ETags
 * never match.
 */
export function ifRangeMatches(ifRange: string | null | undefined, etag: string, lastModified: Date): boolean {
	if (!ifRange) return true;
	const value = ifRange.trim();
	if (value.startsWith("W/")) return false;
	if (value.startsWith('"')) return value === etag;
	const date = Date.parse(value);
	return !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(lastModified.getTime() / 1000);
}
