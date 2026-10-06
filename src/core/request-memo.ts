/**
 * Request-scoped memo: share a read between everything that renders one page
 * (page:metadata hooks, block components, public plugin routes they call), so
 * the same data is read from D1 once per request instead of once per caller.
 *
 * Keyed on EmDash's request context (an AsyncLocalStorage store that EmDash's
 * middleware opens for every request; found through its global symbol, so no
 * import of emdash is needed here). Outside a request (tests, cron, scripts)
 * nothing is shared: each call runs its read.
 *
 * Promises are cached, so callers that start at the same time share one
 * in-flight read; a read that fails is forgotten, so the next caller retries.
 */

const ALS_KEY = Symbol.for("emdash:request-context");
const memos = new WeakMap<object, Map<string, Promise<unknown>>>();

/** The current request's EmDash context object (undefined outside a request). */
export function requestStore(): object | undefined {
	const als = (globalThis as Record<symbol, { getStore?(): unknown } | undefined>)[ALS_KEY];
	const store = als?.getStore?.();
	return store && typeof store === "object" ? store : undefined;
}

function memoFor(create: boolean): Map<string, Promise<unknown>> | undefined {
	const store = requestStore();
	if (!store) return undefined;
	let memo = memos.get(store);
	if (!memo && create) {
		memo = new Map();
		memos.set(store, memo);
	}
	return memo;
}

/** `read()` once per request for `key`; later callers in the same request get the same promise. */
export function requestMemo<T>(key: string, read: () => Promise<T>): Promise<T> {
	const memo = memoFor(true);
	if (!memo) return read();
	const hit = memo.get(key);
	if (hit) return hit as Promise<T>;
	const promise = read().catch((error) => {
		if (memo.get(key) === promise) memo.delete(key);
		throw error;
	});
	memo.set(key, promise);
	return promise;
}

/** The value already read (or being read) for `key` in this request, if any. */
export function peekRequestMemo<T>(key: string): Promise<T> | undefined {
	return memoFor(false)?.get(key) as Promise<T> | undefined;
}

/** Share a read that's already under way (e.g. one batched read for many keys) with later callers in this request. */
export function seedRequestMemo<T>(key: string, value: Promise<T>): void {
	const memo = memoFor(true);
	if (!memo || memo.has(key)) return;
	const promise = value.catch((error) => {
		if (memo.get(key) === promise) memo.delete(key);
		throw error;
	});
	// The caller handles `value`'s failure; a seeded copy nobody reads must not be an unhandled rejection.
	promise.catch(() => {});
	memo.set(key, promise);
}

/** Forget `key` in this request (after a write that changes it). */
export function forgetRequestMemo(key: string): void {
	memoFor(false)?.delete(key);
}
