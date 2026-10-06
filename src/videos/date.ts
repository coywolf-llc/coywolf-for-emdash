/**
 * Upload dates under a video: "Oct 6, 2026" or "7 months ago" (Video
 * Manager's style). No imports, so the page script can use it to refresh a
 * relative date on pages served from a cache.
 */

export type DateStyle = "absolute" | "relative";

// UTC, as the site renders on Workers (also in the admin preview and tests).
const absolute = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

const UNITS: Array<[string, number]> = [
	["year", 365 * 86_400],
	["month", 30 * 86_400],
	["week", 7 * 86_400],
	["day", 86_400],
	["hour", 3_600],
	["minute", 60],
];

/** "7 months ago", "1 day ago"; anything under a minute (or in the future) is "just now". */
export function relativeDate(iso: string, now = Date.now()): string {
	const at = new Date(iso).getTime();
	if (Number.isNaN(at)) return "";
	const seconds = Math.floor((now - at) / 1000);
	for (const [unit, size] of UNITS) {
		if (seconds < size) continue;
		const n = Math.floor(seconds / size);
		return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

/** The date text for a video's upload date, or "" when it isn't a date. */
export function videoDateText(iso: string | null | undefined, style: DateStyle, now = Date.now()): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return style === "relative" ? relativeDate(iso, now) : absolute.format(date);
}
