/**
 * Restorable SQL dump of a D1 database, built from inside the Worker.
 *
 * Same output order as scripts/backup/d1-backup.sh, so either kind of dump
 * restores with scripts/backup/d1-restore.sh:
 *
 *   1. CREATE TABLE for every regular table
 *   2. FTS5 search tables and the triggers that maintain them
 *   3. INSERT rows, one statement per line (the search triggers re-index
 *      content rows as they load)
 *   4. indexes and the remaining triggers
 *
 * FTS5 shadow tables are skipped: SQLite recreates them with the virtual table.
 *
 * D1 rejects any statement over 100 KB (SQLITE_TOOBIG), but the site writes
 * rows with bound parameters, so a long post can be bigger than that. A row
 * whose INSERT would be too long is written with its long text values cut
 * short, followed by UPDATEs that append the rest in pieces under the limit.
 */

interface MasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

const PAGE_SIZE = 500;
const SEARCH_PREFIX = "_emdash_fts_";
/** Longest statement written, in UTF-8 bytes; D1's limit is 100,000. */
export const MAX_STATEMENT_BYTES = 90_000;
/** Most UTF-8 bytes of escaped text per piece of a split value. */
const PIECE_BYTES = 60_000;
/** In a row too long for one INSERT, text values longer than this are appended separately. */
const SHORT_BYTES = 2_000;
/**
 * Line breaks are written as '||char(10)||', two operators each, and SQLite
 * refuses expressions deeper than 1,000: at most this many per statement.
 */
const MAX_BREAKS = 400;
const breaks = (s: string) => s.match(/[\r\n]/g)?.length ?? 0;
/** Option rows that the plugin rebuilds on demand; not worth backing up. */
const SKIP_OPTION = /^plugin:coywolf-pack:cache:/;

function isInternal(name: string): boolean {
	return name.startsWith("sqlite_") || name.startsWith("_cf_");
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** SQL literal for a D1 value, keeping every statement on one line (like sqlite3 .dump). */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "boolean") return value ? "1" : "0";
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: Array.isArray(value)
					? Uint8Array.from(value as number[])
					: new Uint8Array((value as ArrayBufferView).buffer, (value as ArrayBufferView).byteOffset, (value as ArrayBufferView).byteLength);
		let hex = "";
		for (const b of bytes) hex += b.toString(16).padStart(2, "0");
		return `X'${hex}'`;
	}
	// Newlines become ||char(10)|| so each INSERT stays on one line.
	return `'${escapeText(String(value))}'`;
}

function escapeText(text: string): string {
	return text.replace(/'/g, "''").replace(/\r/g, "'||char(13)||'").replace(/\n/g, "'||char(10)||'");
}

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

/** Split text into pieces whose escaped form stays under PIECE_BYTES (never inside a surrogate pair). */
export function splitText(text: string): string[] {
	const pieces: string[] = [];
	let start = 0;
	let size = 0;
	let lines = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
		const char = pair ? text.slice(i, i + 2) : text[i];
		const cost = bytes(escapeText(char));
		const isBreak = char === "\n" || char === "\r";
		if ((size + cost > PIECE_BYTES || (isBreak && lines >= MAX_BREAKS)) && i > start) {
			pieces.push(text.slice(start, i));
			start = i;
			size = 0;
			lines = 0;
		}
		size += cost;
		if (isBreak) lines++;
		if (pair) i++;
	}
	pieces.push(text.slice(start));
	return pieces;
}

/**
 * One row as statements: a single INSERT when it fits, otherwise an INSERT
 * with each long text value's first piece, then UPDATEs appending the rest.
 * `key` names the columns that identify the row (primary key, or rowid).
 */
export function rowStatements(table: string, row: Record<string, unknown>, key: Record<string, unknown>): string[] {
	const columns = Object.keys(row).filter((c) => c !== ROWID);
	const insert = (values: Record<string, unknown>) =>
		`INSERT INTO ${table} (${columns.map(quoteIdent).join(",")}) VALUES(${columns.map((c) => sqlLiteral(values[c])).join(",")});`;
	const whole = insert(row);
	const lineCount = columns.reduce((n, c) => n + (typeof row[c] === "string" ? breaks(row[c] as string) : 0), 0);
	if (bytes(whole) <= MAX_STATEMENT_BYTES && lineCount <= MAX_BREAKS) return [whole];

	// Long text values start empty and are appended piece by piece, so the
	// INSERT holds only short values however many long columns the row has.
	const first: Record<string, unknown> = { ...row };
	const rest: Array<[string, string]> = [];
	for (const c of columns) {
		const value = row[c];
		if (typeof value !== "string" || (bytes(sqlLiteral(value)) <= SHORT_BYTES && breaks(value) <= 20)) continue;
		first[c] = "";
		for (const piece of splitText(value)) rest.push([c, piece]);
	}
	const where = Object.entries(key)
		.map(([c, v]) => `${c === ROWID ? "rowid" : quoteIdent(c)}=${sqlLiteral(v)}`)
		.join(" AND ");
	return [
		insert(first),
		...rest.map(([c, piece]) => `UPDATE ${table} SET ${quoteIdent(c)}=${quoteIdent(c)}||${sqlLiteral(piece)} WHERE ${where};`),
	];
}

/** Alias for rowid in dump queries of tables without a primary key. */
const ROWID = "__coywolf_rowid";

/**
 * Parents before children. D1 may apply a large import in several batches, so
 * PRAGMA defer_foreign_keys can't be relied on to cover forward references.
 */
async function orderByForeignKeys(db: D1Database, tables: MasterRow[]): Promise<MasterRow[]> {
	const names = new Set(tables.map((t) => t.name));
	const parents = new Map<string, Set<string>>();
	for (const t of tables) {
		const { results } = await db.prepare(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`).all<{ table: string }>();
		parents.set(t.name, new Set(results.map((r) => r.table).filter((p) => p !== t.name && names.has(p))));
	}
	const ordered: MasterRow[] = [];
	const done = new Set<string>();
	const visiting = new Set<string>();
	const byName = new Map(tables.map((t) => [t.name, t]));
	const visit = (name: string) => {
		if (done.has(name) || visiting.has(name)) return; // a cycle falls back to name order
		visiting.add(name);
		for (const parent of parents.get(name) ?? []) visit(parent);
		visiting.delete(name);
		done.add(name);
		ordered.push(byName.get(name)!);
	};
	for (const t of tables) visit(t.name);
	return ordered;
}

export interface DumpResult {
	sql: string;
	tables: number;
	rows: number;
}

export async function dumpDatabase(db: D1Database): Promise<DumpResult> {
	const { results: master } = await db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")
		.all<MasterRow>();

	const isSearch = (row: MasterRow) =>
		row.name.startsWith(SEARCH_PREFIX) || row.tbl_name.startsWith(SEARCH_PREFIX) || (row.sql ?? "").includes(SEARCH_PREFIX);

	const tables = master.filter((r) => r.type === "table" && !isInternal(r.name) && !r.name.startsWith(SEARCH_PREFIX));
	const searchTables = master.filter(
		(r) => r.type === "table" && r.name.startsWith(SEARCH_PREFIX) && /^CREATE VIRTUAL TABLE/i.test(r.sql ?? ""),
	);
	const searchTriggers = master.filter((r) => r.type === "trigger" && r.name.startsWith(SEARCH_PREFIX));
	const indexes = master.filter((r) => r.type === "index" && !isInternal(r.name) && !isSearch(r));
	const triggers = master.filter((r) => r.type === "trigger" && !isSearch(r));

	const ordered = await orderByForeignKeys(db, tables);

	const statement = (sql: string) => `${sql.trim().replace(/;$/, "")};`;
	const out: string[] = ["PRAGMA defer_foreign_keys=TRUE;"];

	for (const t of tables) out.push(statement((t.sql ?? "").replace(/^CREATE TABLE /i, "CREATE TABLE IF NOT EXISTS ")));
	for (const t of searchTables) out.push(statement(t.sql ?? ""));
	for (const t of searchTriggers) out.push(statement(t.sql ?? ""));

	let rows = 0;
	for (const t of ordered) {
		const table = quoteIdent(t.name);
		const withRowid = !/WITHOUT\s+ROWID/i.test(t.sql ?? "");
		const { results: info } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; pk: number }>();
		const pk = info.filter((c) => c.pk > 0).map((c) => c.name);
		// Rows are identified by primary key for split values; tables without one by rowid.
		const select = pk.length || !withRowid ? "*" : `rowid AS ${ROWID}, *`;
		const keyColumns = pk.length || !withRowid ? pk : [ROWID];
		const order = withRowid ? " ORDER BY rowid" : "";
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const { results } = await db
				.prepare(`SELECT ${select} FROM ${table}${order} LIMIT ? OFFSET ?`)
				.bind(PAGE_SIZE, offset)
				.all<Record<string, unknown>>();
			for (const row of results) {
				if (t.name === "options" && typeof row.name === "string" && SKIP_OPTION.test(row.name)) continue;
				const key = Object.fromEntries(keyColumns.map((c) => [c, row[c]]));
				out.push(...rowStatements(table, row, key));
				rows++;
			}
			if (results.length < PAGE_SIZE) break;
		}
	}

	for (const i of indexes) out.push(statement(i.sql ?? ""));
	for (const t of triggers) out.push(statement(t.sql ?? ""));

	return { sql: `${out.join("\n")}\n`, tables: tables.length, rows };
}
