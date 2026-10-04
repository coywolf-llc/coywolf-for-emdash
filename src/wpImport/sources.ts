/**
 * Reading data exported from WordPress (options and table rows pasted on the
 * WordPress import page). Pure, no imports beyond types.
 */
import type { FileDefaults, VideoDefaults } from "./convert.js";

export interface ImportDefaults {
	video?: Partial<VideoDefaults>;
	files?: Partial<FileDefaults>;
}

const bool = (v: unknown) => (typeof v === "boolean" ? v : v === 1 || v === "1" ? true : v === 0 || v === "0" || v === "" ? false : undefined);

/** Video Manager's coywolf_cvm_settings and Coywolf Files' coywolf_files_settings (as JSON) → converter defaults. */
export function defaultsFromWordPress(cvm: unknown, files: unknown): ImportDefaults {
	const out: ImportDefaults = {};
	if (cvm && typeof cvm === "object") {
		const c = cvm as Record<string, unknown>;
		const video: Partial<VideoDefaults> = {};
		const map: Array<[keyof VideoDefaults, string]> = [
			["controls", "controls"],
			["autoplay", "autoplay"],
			["loop", "loop"],
			["mute", "mute"],
			["showName", "show_title"],
			["showDescription", "show_desc"],
			["showDate", "show_date"],
			["showPlays", "plays_enabled"],
			["showLikes", "likes_enabled"],
		];
		for (const [to, from] of map) {
			const v = bool(c[from]);
			if (v !== undefined) (video as Record<string, unknown>)[to] = v;
		}
		if (c.preload === "auto" || c.preload === "metadata" || c.preload === "none") video.preload = c.preload;
		out.video = video;
	}
	if (files && typeof files === "object") {
		const f = files as Record<string, unknown>;
		const card: Partial<FileDefaults> = {};
		const map: Array<[keyof FileDefaults, string]> = [
			["showIcon", "show_icon"],
			["showDescription", "show_description"],
			["showMeta", "show_meta"],
			["showDownload", "show_download"],
			["showCopyLink", "show_copy_link"],
		];
		for (const [to, from] of map) {
			const v = bool(f[from]);
			if (v !== undefined) card[to] = v;
		}
		out.files = card;
	}
	return out;
}


/** `wp db query` output (tab-separated, header row) or JSON → rows. */
export function parseFileRows(text: string): Array<Record<string, string>> {
	const trimmed = text.trim();
	if (trimmed.startsWith("[")) return JSON.parse(trimmed) as Array<Record<string, string>>;
	const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
	const header = (lines.shift() ?? "").split("\t").map((h) => h.trim());
	return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [header[i] ?? `c${i}`, v.trim()])));
}

