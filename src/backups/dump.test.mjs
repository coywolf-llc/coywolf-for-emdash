// Unit tests for the D1 dump: rows bigger than D1's statement limit restore intact.
// Run: node --test src/backups/dump.test.mjs   (Node 22.6+ strips the types from dump.ts)
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { dumpDatabase, splitText, MAX_STATEMENT_BYTES } = await import("./dump.ts");

/** The slice of the D1 binding that dumpDatabase uses, over node:sqlite. */
function d1(db) {
	return {
		prepare(sql) {
			let params = [];
			const stmt = {
				bind(...args) {
					params = args;
					return stmt;
				},
				async all() {
					return { results: db.prepare(sql).all(...params) };
				},
			};
			return stmt;
		},
	};
}

function seed() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT, revision INTEGER);
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, slug TEXT, content TEXT, excerpt TEXT);
		CREATE TABLE log (line TEXT);`);
	const insert = (sql, ...v) => db.prepare(sql).run(...v);
	// 250 KB with quotes, CR/LF, emoji (surrogate pairs) and accents, so pieces split on awkward characters.
	const big = Array.from({ length: 5000 }, (_, i) => `Line ${i}: it's "quoted" — café 🦊\r\n`).join("");
	insert("INSERT INTO ec_posts VALUES (?, ?, ?, ?)", "p1", "long", big, big.slice(0, 120_000));
	insert("INSERT INTO ec_posts VALUES (?, ?, ?, ?)", "p2", "short", "hello\nworld", null);
	insert("INSERT INTO options VALUES (?, ?, ?)", "site:title", "Coywolf", 1);
	insert("INSERT INTO options VALUES (?, ?, ?)", "plugin:coywolf-pack:cache:discovery:llms", big, 1);
	insert("INSERT INTO log VALUES (?)", big);
	return { db, big };
}

test("oversized rows are split into statements under the limit and restore intact", async () => {
	const { db, big } = seed();
	const { sql } = await dumpDatabase(d1(db));
	const statements = sql.trim().split("\n");
	for (const s of statements) assert.ok(new TextEncoder().encode(s).length <= MAX_STATEMENT_BYTES, `statement of ${s.length} chars`);
	assert.ok(statements.some((s) => s.startsWith('UPDATE "ec_posts"')), "long post written in pieces");

	const restored = new DatabaseSync(":memory:");
	for (const s of statements) restored.exec(s);
	const post = restored.prepare("SELECT * FROM ec_posts WHERE id = 'p1'").get();
	assert.equal(post.content, big);
	assert.equal(post.excerpt, big.slice(0, 120_000));
	assert.equal(restored.prepare("SELECT content FROM ec_posts WHERE id = 'p2'").get().content, "hello\nworld");
	assert.equal(restored.prepare("SELECT line FROM log").get().line, big, "table without a primary key uses rowid");
});

test("plugin caches are left out; other options are kept", async () => {
	const { db } = seed();
	const { sql, rows } = await dumpDatabase(d1(db));
	assert.ok(!sql.includes("cache:discovery:llms"));
	assert.ok(sql.includes("site:title"));
	assert.equal(rows, 4);
});

test("splitText never cuts a surrogate pair and rejoins exactly", () => {
	const text = "🦊".repeat(40_000);
	const pieces = splitText(text);
	assert.ok(pieces.length > 1);
	assert.equal(pieces.join(""), text);
	for (const p of pieces) assert.ok(!/^[\udc00-\udfff]/.test(p));
});
