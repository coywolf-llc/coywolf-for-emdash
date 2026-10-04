/**
 * OR fallback for EmDash search. EmDash matches every word (AND, with prefix
 * matching); when that finds nothing, we retry with any word (OR) and rank
 * the results by how many of the words they contain, then by BM25.
 *
 * The OR query is handed to EmDash's own search, whose query escaping passes
 * strings containing FTS5 operators through with double quotes escaped. So
 * the terms here are bare words (letters and digits only), never quoted,
 * which keeps the expression valid FTS5 whatever the visitor typed.
 *
 * Pure functions (no imports) so they can be unit tested in Node.
 */

/** Most words an OR query may contain (query cost cap, as in Coywolf Search). */
export const MAX_OR_TERMS = 16;

/** Common English words dropped from OR queries; matching any of them would match nearly everything. */
const STOPWORDS = new Set(
	(
		"a an and are as at be but by for from has have how i if in into is it its of on or that the their them then there these they this " +
		"to was we were what when where which who why will with you your"
	).split(" "),
);

/** FTS5 operators are only operators in upper case; a visitor who typed them wrote their own boolean query. */
const EXPLICIT_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/;

/** Split a query into lower-case word tokens (letters and digits), de-duplicated, in order. */
export function queryTerms(query: string): string[] {
	const seen = new Set<string>();
	for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
		if (raw) seen.add(raw);
	}
	return [...seen];
}

/**
 * Build the query to try when the AND search found nothing: any of the
 * words, without stopwords. Null when a fallback can't find anything new
 * (a one-word search, or the visitor already wrote operators).
 */
export function buildOrQuery(query: string, maxTerms = MAX_OR_TERMS): string | null {
	const trimmed = query.trim();
	if (!trimmed || EXPLICIT_OPERATORS.test(trimmed)) return null;
	const all = queryTerms(trimmed);
	if (all.length < 2) return null;
	// One-letter Latin words match too much as prefixes; keep digits and single CJK characters.
	let terms = all.filter((t) => t.length > 1 || /[\d\u0080-\uffff]/.test(t));
	const meaningful = terms.filter((t) => !STOPWORDS.has(t));
	if (meaningful.length > 0) terms = meaningful;
	terms = terms.slice(0, maxTerms);
	if (terms.length === 0) return null;
	// A single word goes through EmDash's normal escaping (quoted, prefix-matched).
	if (terms.length === 1) return terms[0];
	return terms.map((t) => `${t}*`).join(" OR ");
}

interface Rankable {
	title?: string;
	snippet?: string;
	score: number;
}

/** How many of the query's terms appear (as a word prefix) in the result's title and snippet. */
export function coverage(result: Rankable, terms: string[]): number {
	const text = `${result.title ?? ""} ${(result.snippet ?? "").replace(/<\/?mark>/g, "")}`.toLowerCase();
	const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	let n = 0;
	for (const term of terms) if (words.some((w) => w.startsWith(term))) n++;
	return n;
}

/** Order OR results by coverage (more of the visitor's words first), then by BM25 score. */
export function rankByCoverage<T extends Rankable>(results: T[], query: string): T[] {
	const terms = queryTerms(query);
	return results
		.map((result, index) => ({ result, index, covered: coverage(result, terms) }))
		.sort((a, b) => b.covered - a.covered || b.result.score - a.result.score || a.index - b.index)
		.map((r) => r.result);
}
