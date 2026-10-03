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
 */

interface MasterRow {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

const PAGE_SIZE = 500;
const SEARCH_PREFIX = "_emdash_fts_";

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
	return `'${String(value)
		.replace(/'/g, "''")
		.replace(/\r/g, "'||char(13)||'")
		.replace(/\n/g, "'||char(10)||'")}'`;
}

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
		const order = /WITHOUT\s+ROWID/i.test(t.sql ?? "") ? "" : " ORDER BY rowid";
		for (let offset = 0; ; offset += PAGE_SIZE) {
			const { results } = await db
				.prepare(`SELECT * FROM ${table}${order} LIMIT ? OFFSET ?`)
				.bind(PAGE_SIZE, offset)
				.all<Record<string, unknown>>();
			for (const row of results) {
				const columns = Object.keys(row);
				out.push(
					`INSERT INTO ${table} (${columns.map(quoteIdent).join(",")}) VALUES(${columns.map((c) => sqlLiteral(row[c])).join(",")});`,
				);
			}
			rows += results.length;
			if (results.length < PAGE_SIZE) break;
		}
	}

	for (const i of indexes) out.push(statement(i.sql ?? ""));
	for (const t of triggers) out.push(statement(t.sql ?? ""));

	return { sql: `${out.join("\n")}\n`, tables: tables.length, rows };
}
