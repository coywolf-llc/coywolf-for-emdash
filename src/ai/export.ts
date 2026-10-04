/**
 * AI Enrichment CSV export: every analyzed entry with the entities found in
 * it (one row per entity) and its AI-written description. Pure, so the admin
 * page and the tests share it.
 */
import { type CsvCell, toCsv } from "../core/csv.js";

export interface ExportEntry {
	collection: string;
	entryId: string;
	title: string;
	status: string;
	error: string;
	entities: Array<{ name: string; type: string; description: string; qid: string; wikipedia: string; website: string; primary: boolean }>;
	description: string;
	descriptionStatus: string;
	updated: string;
}

export const ENTITY_CSV_COLUMNS = [
	"collection",
	"entry_id",
	"entry_title",
	"analysis",
	"entity",
	"entity_type",
	"role",
	"wikidata_id",
	"wikidata_url",
	"wikipedia",
	"website",
	"entity_description",
	"ai_description",
	"description_status",
	"updated",
] as const;

/** Spreadsheet-safe CSV. An entry with no entities still gets one row, so its description and errors are kept. */
export function entitiesToCsv(entries: ExportEntry[]): string {
	const rows: CsvCell[][] = [[...ENTITY_CSV_COLUMNS]];
	for (const e of entries) {
		const base = [e.collection, e.entryId, e.title, e.status === "error" ? `error: ${e.error}` : "ok"];
		const tail = [e.description, e.descriptionStatus, e.updated];
		if (!e.entities.length) rows.push([...base, "", "", "", "", "", "", "", "", ...tail]);
		for (const x of e.entities) {
			rows.push([
				...base,
				x.name,
				x.type,
				x.primary ? "about" : "mentions",
				x.qid,
				x.qid ? `https://www.wikidata.org/wiki/${x.qid}` : "",
				x.wikipedia,
				x.website,
				x.description,
				...tail,
			]);
		}
	}
	return toCsv(rows, { guard: true });
}
