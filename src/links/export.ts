/**
 * Link Manager CSV export: one row per link with its check result and the
 * entries that use it, for a spreadsheet or a hand-off to whoever fixes
 * links. Pure, so the admin page and the tests share it.
 */
import { type CsvCell, toCsv } from "../core/csv.js";

export interface ExportLink {
	url: string;
	resolved: string | null;
	host: string;
	internal: boolean;
	ignored: boolean;
	status: string;
	code: number | null;
	finalUrl: string | null;
	note: string;
	checkedAt: string | null;
	usedIn: Array<{ collection: string; entryId: string; title: string; anchors?: string[]; count?: number }>;
}

export const LINK_CSV_COLUMNS = [
	"url",
	"checked_url",
	"status",
	"http_code",
	"final_url",
	"note",
	"host",
	"internal",
	"ignored",
	"checked_at",
	"entries",
	"used_in",
	"anchor_text",
] as const;

/** Spreadsheet-safe CSV (cells that look like formulas are guarded). Entries are joined with " | ". */
export function linksToCsv(links: ExportLink[]): string {
	const rows: CsvCell[][] = [[...LINK_CSV_COLUMNS]];
	for (const l of links) {
		rows.push([
			l.url,
			l.resolved ?? "",
			l.status,
			l.code ?? "",
			l.finalUrl ?? "",
			l.note,
			l.host,
			l.internal,
			l.ignored,
			l.checkedAt ?? "",
			l.usedIn.length,
			l.usedIn.map((u) => `${u.title || u.entryId} (${u.collection}/${u.entryId})`).join(" | "),
			[...new Set(l.usedIn.flatMap((u) => u.anchors ?? []).filter(Boolean))].join(" | "),
		]);
	}
	return toCsv(rows, { guard: true });
}
