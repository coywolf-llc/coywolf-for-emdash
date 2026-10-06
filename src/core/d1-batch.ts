/**
 * Same-tick batching for the pack's own D1 reads. The pack reads the site
 * database through the raw binding (env.DB), which EmDash's per-request
 * session dialect never sees, so its reads were never coalesced: each was its
 * own round trip. Reads issued through here in the same tick (before a
 * zero-delay timer fires) go to D1 as one `db.batch()`: one round trip.
 *
 * A statement that fails fails the whole batch in D1, so on a batch error each
 * statement is retried on its own, and only the failing ones reject. Reads of
 * different requests are never batched together (Workers ties I/O to the
 * request that started it).
 */
import { requestStore } from "./request-memo.js";

interface Pending {
	statement: D1PreparedStatement;
	resolve(result: D1Result<unknown>): void;
	reject(error: unknown): void;
}

/** Request context (or OUTSIDE) → database → reads waiting for this tick's batch. */
const queues = new WeakMap<object, Map<D1Database, Pending[]>>();
const OUTSIDE = {};

function flush(scope: Map<D1Database, Pending[]>, db: D1Database): void {
	const queue = scope.get(db) ?? [];
	scope.delete(db);
	if (!queue.length) return;
	if (queue.length === 1 || typeof db.batch !== "function") {
		for (const p of queue) p.statement.all().then(p.resolve, p.reject);
		return;
	}
	db.batch(queue.map((p) => p.statement)).then(
		(results) => queue.forEach((p, i) => p.resolve(results[i] as D1Result<unknown>)),
		() => {
			// One bad statement fails a D1 batch: run them one by one so the others still answer.
			for (const p of queue) p.statement.all().then(p.resolve, p.reject);
		},
	);
}

/** Run a read with the other reads of this tick, in one D1 batch. Resolves to its rows. */
export function batchedAll<T = Record<string, unknown>>(db: D1Database, statement: D1PreparedStatement): Promise<T[]> {
	return new Promise<D1Result<unknown>>((resolve, reject) => {
		const owner = requestStore() ?? OUTSIDE;
		let scope = queues.get(owner);
		if (!scope) {
			scope = new Map();
			queues.set(owner, scope);
		}
		let queue = scope.get(db);
		if (!queue) {
			queue = [];
			scope.set(db, queue);
			const pending = scope;
			setTimeout(() => flush(pending, db), 0);
		}
		queue.push({ statement, resolve, reject });
	}).then((result) => (result.results ?? []) as T[]);
}

/** Like batchedAll, the first row (null when none). */
export async function batchedFirst<T = Record<string, unknown>>(db: D1Database, statement: D1PreparedStatement): Promise<T | null> {
	return (await batchedAll<T>(db, statement))[0] ?? null;
}
