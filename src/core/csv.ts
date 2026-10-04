/**
 * CSV for exports and imports (RFC 4180): quoted fields, doubled quotes,
 * commas and line breaks inside quotes. No imports, so the admin bundle and
 * `node --test` can both load it.
 *
 * Spreadsheet apps run a cell that starts with = + - @ (or a tab or carriage
 * return) as a formula, so exports meant for spreadsheets pass `guard: true`:
 * such cells get a leading apostrophe, which spreadsheets hide. Cells that
 * start with apostrophes followed by one of those characters get one more, so
 * `unguardCell` can always undo the guard exactly and a guarded export still
 * imports back to the same values.
 */

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA = /^'*[=+\-@\t\r]/;
const GUARDED = /^'+[=+\-@\t\r]/;

/** Neutralize a cell a spreadsheet would treat as a formula. Reversible with unguardCell. */
export function guardCell(value: string): string {
	return FORMULA.test(value) ? `'${value}` : value;
}

/** Undo guardCell. Values that weren't guarded come back unchanged. */
export function unguardCell(value: string): string {
	return GUARDED.test(value) ? value.slice(1) : value;
}

function cellText(value: CsvCell): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "1" : "0";
	return String(value);
}

/** Quote a field when it holds a comma, quote, tab or line break (or leading/trailing spaces, which some readers trim). */
function quote(text: string): string {
	return /[",\t\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows to CSV text (CRLF line ends, as RFC 4180 and Excel expect). */
export function toCsv(rows: CsvCell[][], options: { guard?: boolean } = {}): string {
	return `${rows
		.map((row) =>
			row
				.map((value) => {
					const text = cellText(value);
					return quote(options.guard && typeof value === "string" ? guardCell(text) : text);
				})
				.join(","),
		)
		.join("\r\n")}\r\n`;
}

/**
 * Parse CSV (or tab-separated) text into rows. The delimiter defaults to a
 * tab when the first line has one (toCsv quotes tabs, so its header never
 * does), else a comma. A leading
 * byte-order mark is dropped, and blank lines are skipped.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
	const source = text.replace(/^﻿/, "");
	const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
	const sep = delimiter ?? (firstLine.includes("\t") ? "\t" : ",");
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;
	const endRow = () => {
		row.push(field);
		if (row.length > 1 || row[0] !== "") rows.push(row);
		row = [];
		field = "";
	};
	while (i < source.length) {
		const c = source[i];
		if (quoted) {
			if (c === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}
		if (c === '"' && field.trim() === "") {
			// A quote opens a quoted field only at its start (spaces before it are dropped).
			field = "";
			quoted = true;
			i++;
		} else if (c === sep) {
			row.push(field);
			field = "";
			i++;
		} else if (c === "\r" || c === "\n") {
			endRow();
			i += c === "\r" && source[i + 1] === "\n" ? 2 : 1;
		} else {
			field += c;
			i++;
		}
	}
	if (field !== "" || row.length) endRow();
	return rows;
}

/** CSV rows to objects keyed by the (lowercased, trimmed) header row. */
export function csvRecords(text: string, delimiter?: string): Array<Record<string, string>> {
	const [header, ...rows] = parseCsv(text, delimiter);
	if (!header) return [];
	const keys = header.map((h) => h.trim().toLowerCase());
	return rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i] ?? ""])));
}
