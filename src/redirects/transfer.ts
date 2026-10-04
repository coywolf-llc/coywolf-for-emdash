/**
 * Redirect export and import formats, shared by the Redirects page and the
 * tests. An export imports back as is (Import updates rules with the same
 * source), so a site's redirects can move between sites or into a
 * spreadsheet and back.
 *
 *   CSV:  source, target, type, is_regex, enabled, note, then hits, last_hit,
 *         created_at, updated_at (for reference; Import ignores them)
 *   JSON: an array of rules, as the list route returns them
 *
 * Import also takes header-less rows of source, target, type, is_regex
 * separated by commas or tabs, e.g. a Coywolf SEO export from WordPress.
 */
import { type CsvCell, parseCsv, toCsv, unguardCell } from "../core/csv.js";
import type { RedirectInput, RedirectRule } from "./rules.js";

export const REDIRECT_CSV_COLUMNS = ["source", "target", "type", "is_regex", "enabled", "note", "hits", "last_hit", "created_at", "updated_at"] as const;

/**
 * All rules as CSV. Cells are guarded against spreadsheet formulas; Import
 * removes the guard again (see src/core/csv.ts), so the round trip is exact.
 */
export function redirectsToCsv(rules: RedirectRule[]): string {
	const rows: CsvCell[][] = [[...REDIRECT_CSV_COLUMNS]];
	for (const r of rules) rows.push([r.source, r.target, r.type, r.isRegex, r.enabled, r.note ?? "", r.hits, r.lastHit ?? "", r.createdAt, r.updatedAt]);
	return toCsv(rows, { guard: true });
}

export function redirectsToJson(rules: RedirectRule[]): string {
	return `${JSON.stringify(rules, null, "\t")}\n`;
}

const truthy = (value: string | undefined) => /^(1|true|yes|y)$/i.test((value ?? "").trim());
const falsy = (value: string | undefined) => /^(0|false|no|n|off)$/i.test((value ?? "").trim());

/** One import row to a rule; enabled and note are left out when the file doesn't have them. */
function fromCells(cells: { source?: string; target?: string; type?: string; regex?: string; enabled?: string; note?: string }): RedirectInput {
	const type = (cells.type ?? "").trim();
	const rule: RedirectInput = {
		source: (cells.source ?? "").trim(),
		target: (cells.target ?? "").trim(),
		type: type ? Number(type) : 301,
		isRegex: truthy(cells.regex),
	};
	if (cells.enabled !== undefined && cells.enabled.trim() !== "") rule.enabled = !falsy(cells.enabled);
	if (cells.note !== undefined) rule.note = cells.note.trim() || null;
	return rule;
}

function fromJson(value: unknown): RedirectInput[] {
	const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { redirects?: unknown }).redirects) ? (value as { redirects: unknown[] }).redirects : null;
	if (!list) throw new Error("The JSON must be a list of redirects.");
	return list.map((item, i) => {
		if (!item || typeof item !== "object") throw new Error(`Item ${i + 1} isn't a redirect.`);
		const r = item as Record<string, unknown>;
		const rule: RedirectInput = {
			source: typeof r.source === "string" ? r.source : "",
			target: typeof r.target === "string" ? r.target : "",
			type: r.type === undefined ? 301 : Number(r.type),
			isRegex: r.isRegex === true,
		};
		if (typeof r.enabled === "boolean") rule.enabled = r.enabled;
		if (typeof r.note === "string" || r.note === null) rule.note = r.note;
		return rule;
	});
}

/** Parse pasted or uploaded rules: a JSON array, or CSV/tab-separated rows with or without a header. */
export function parseRedirectsImport(text: string): RedirectInput[] {
	const trimmed = text.replace(/^﻿/, "").trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`That isn't valid JSON: ${(error as Error).message}`);
		}
		return fromJson(parsed);
	}
	const rows = parseCsv(trimmed).map((row) => row.map(unguardCell));
	const header = rows[0].map((c) => c.trim().toLowerCase());
	if (!header.includes("source")) {
		return rows.map((r) => fromCells({ source: r[0], target: r[1], type: r[2], regex: r[3] }));
	}
	const at = (...names: string[]) => header.findIndex((h) => names.includes(h));
	const [s, t, ty, rx, en, no] = [at("source"), at("target", "destination"), at("type", "code", "status"), at("is_regex", "regex", "isregex"), at("enabled"), at("note")];
	const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "") : undefined);
	return rows.slice(1).map((r) =>
		fromCells({ source: cell(r, s), target: cell(r, t), type: cell(r, ty), regex: cell(r, rx), enabled: cell(r, en), note: cell(r, no) }),
	);
}
