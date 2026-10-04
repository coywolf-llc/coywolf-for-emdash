/**
 * Files CSV export: an inventory of download files with their links, sizes,
 * download counts and where each is used. Pure, so the admin page and the
 * tests share it.
 */
import { type CsvCell, toCsv } from "../core/csv.js";

export interface ExportFile {
	id: string;
	source: string;
	status: string;
	name: string;
	type: string;
	size: number;
	uploadedAt: string | null;
	url: string | null;
	downloads: number;
	lastDownload: string | null;
	usedIn: Array<{ collection: string; id: string; title: string }>;
}

export const FILE_CSV_COLUMNS = ["name", "download_url", "type", "size_bytes", "source", "status", "uploaded_at", "downloads", "last_download", "entries", "used_in", "id"] as const;

/** Spreadsheet-safe CSV. `origin` turns site-relative download links into full URLs. */
export function filesToCsv(files: ExportFile[], origin = ""): string {
	const rows: CsvCell[][] = [[...FILE_CSV_COLUMNS]];
	for (const f of files) {
		rows.push([
			f.name,
			f.url ? `${origin}${f.url}` : "",
			f.type,
			f.size,
			f.source === "upload" ? "large upload" : f.source === "media" ? "media library" : "missing",
			f.status,
			f.uploadedAt ?? "",
			f.downloads,
			f.lastDownload ?? "",
			f.usedIn.length,
			f.usedIn.map((u) => `${u.title || u.id} (${u.collection}/${u.id})`).join(" | "),
			f.id,
		]);
	}
	return toCsv(rows, { guard: true });
}
