/**
 * Redirect rules: storage (a table in the site's D1 database, so backups and
 * rewinds include it), validation, and matching. Shared by the plugin routes
 * and the site middleware.
 *
 * Complements EmDash's built-in redirects, which only accept site-relative
 * destinations and skip any path with a file extension.
 */

export const REDIRECT_TYPES = [301, 302, 307, 308, 410] as const;
export type RedirectType = (typeof REDIRECT_TYPES)[number];

export interface RedirectRule {
	id: string;
	source: string;
	target: string;
	type: RedirectType;
	isRegex: boolean;
	enabled: boolean;
	hits: number;
	lastHit: string | null;
	note: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface RedirectInput {
	source: string;
	target?: string;
	type?: number;
	isRegex?: boolean;
	enabled?: boolean;
	note?: string | null;
}

const TABLE = "coywolf_redirects";

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS ${TABLE} (
		id TEXT PRIMARY KEY,
		source TEXT NOT NULL,
		target TEXT NOT NULL DEFAULT '',
		type INTEGER NOT NULL DEFAULT 301,
		is_regex INTEGER NOT NULL DEFAULT 0,
		enabled INTEGER NOT NULL DEFAULT 1,
		hits INTEGER NOT NULL DEFAULT 0,
		last_hit TEXT,
		note TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_source ON ${TABLE} (source, is_regex)`,
];

export async function ensureTable(db: D1Database): Promise<void> {
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

interface Row {
	id: string;
	source: string;
	target: string;
	type: number;
	is_regex: number;
	enabled: number;
	hits: number;
	last_hit: string | null;
	note: string | null;
	created_at: string;
	updated_at: string;
}

const toRule = (r: Row): RedirectRule => ({
	id: r.id,
	source: r.source,
	target: r.target,
	type: r.type as RedirectType,
	isRegex: r.is_regex === 1,
	enabled: r.enabled === 1,
	hits: r.hits,
	lastHit: r.last_hit,
	note: r.note,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** Exact sources match with or without a trailing slash, so store them without one. */
export function normalizePath(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export class RedirectValidationError extends Error {}

/** Validate and normalize a rule; throws RedirectValidationError with a readable message. */
export function validate(input: RedirectInput): Omit<RedirectInput, "type"> & { type: RedirectType; target: string } {
	const source = (input.source ?? "").trim();
	const target = (input.target ?? "").trim();
	const type = (input.type ?? 301) as RedirectType;
	const isRegex = input.isRegex === true;

	if (!REDIRECT_TYPES.includes(type)) throw new RedirectValidationError(`Type must be one of ${REDIRECT_TYPES.join(", ")}.`);
	if (isRegex) {
		if (!source) throw new RedirectValidationError("Enter a pattern.");
		try {
			new RegExp(source);
		} catch (error) {
			throw new RedirectValidationError(`Invalid pattern: ${(error as Error).message}`);
		}
	} else if (!source.startsWith("/") || source.startsWith("//")) {
		throw new RedirectValidationError("The source must be a path starting with /.");
	}
	if (type !== 410) {
		if (!target) throw new RedirectValidationError("Enter a destination.");
		const sitePath = target.startsWith("/") && !target.startsWith("//");
		if (!sitePath && !/^https?:\/\/[^\s]+$/i.test(target)) {
			throw new RedirectValidationError("The destination must be a path starting with / or an http(s) URL.");
		}
		if (!isRegex && sitePath && normalizePath(target.split("?")[0]) === normalizePath(source)) {
			throw new RedirectValidationError("A redirect can't point to itself.");
		}
	}
	return {
		source: isRegex ? source : normalizePath(source),
		target: type === 410 ? "" : target,
		type,
		isRegex,
		enabled: input.enabled !== false,
		note: input.note?.trim() || null,
	};
}

export async function listRules(db: D1Database): Promise<RedirectRule[]> {
	await ensureTable(db);
	const { results } = await db.prepare(`SELECT * FROM ${TABLE} ORDER BY is_regex, source`).all<Row>();
	return results.map(toRule);
}

/** Create or update (by id, or by source when importing). Returns the saved rule. */
export async function saveRule(db: D1Database, input: RedirectInput & { id?: string }): Promise<RedirectRule> {
	await ensureTable(db);
	const rule = validate(input);
	const now = new Date().toISOString();
	const existing = input.id
		? await db.prepare(`SELECT id FROM ${TABLE} WHERE id = ?`).bind(input.id).first<{ id: string }>()
		: await db
				.prepare(`SELECT id FROM ${TABLE} WHERE source = ? AND is_regex = ?`)
				.bind(rule.source, rule.isRegex ? 1 : 0)
				.first<{ id: string }>();
	const id = existing?.id ?? input.id ?? crypto.randomUUID();
	if (existing) {
		await db
			.prepare(
				`UPDATE ${TABLE} SET source = ?, target = ?, type = ?, is_regex = ?, enabled = ?, note = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(rule.source, rule.target, rule.type, rule.isRegex ? 1 : 0, rule.enabled ? 1 : 0, rule.note, now, id)
			.run();
	} else {
		await db
			.prepare(
				`INSERT INTO ${TABLE} (id, source, target, type, is_regex, enabled, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, rule.source, rule.target, rule.type, rule.isRegex ? 1 : 0, rule.enabled ? 1 : 0, rule.note, now, now)
			.run();
	}
	const saved = await db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).bind(id).first<Row>();
	return toRule(saved!);
}

export async function deleteRule(db: D1Database, id: string): Promise<boolean> {
	await ensureTable(db);
	const result = await db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).bind(id).run();
	return result.meta.changes > 0;
}

// ─── Matching ───────────────────────────────────────────────────────────────

export interface CompiledRules {
	exact: Map<string, RedirectRule>;
	patterns: Array<{ rule: RedirectRule; regex: RegExp }>;
}

export function compile(rules: RedirectRule[]): CompiledRules {
	const exact = new Map<string, RedirectRule>();
	const patterns: CompiledRules["patterns"] = [];
	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (rule.isRegex) {
			try {
				patterns.push({ rule, regex: new RegExp(rule.source) });
			} catch {
				// Saved rules are validated; skip anything unparseable rather than fail every request.
			}
		} else {
			exact.set(rule.source, rule);
		}
	}
	return { exact, patterns };
}

export interface Match {
	rule: RedirectRule;
	/** Absolute or site-relative URL; empty for 410. */
	location: string;
}

/**
 * Find the rule for a request path. Exact rules win over patterns; patterns are
 * tried in source order. `$1`…`$9` in a pattern's target are replaced with its
 * capture groups. The request's query string is kept unless the target has one.
 */
export function match(compiled: CompiledRules, pathname: string, search: string): Match | null {
	let rule = compiled.exact.get(normalizePath(pathname));
	let location = rule?.target ?? "";
	if (!rule) {
		for (const candidate of compiled.patterns) {
			const m = pathname.match(candidate.regex);
			if (!m) continue;
			rule = candidate.rule;
			location = rule.target.replace(/\$(\d)/g, (_, n: string) => m[Number(n)] ?? "");
			break;
		}
	}
	if (!rule) return null;
	if (rule.type !== 410 && search && !location.includes("?")) location += search;
	return { rule, location };
}

export async function recordHit(db: D1Database, id: string): Promise<void> {
	await db
		.prepare(`UPDATE ${TABLE} SET hits = hits + 1, last_hit = ? WHERE id = ?`)
		.bind(new Date().toISOString(), id)
		.run();
}
