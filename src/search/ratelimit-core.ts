/**
 * Fixed-window rate limiting: the pure parts (no imports, unit tested in Node).
 */

export const WINDOW_MS = 60_000;

export interface Window {
	/** Start of the current window (ms since epoch). */
	start: number;
	/** When the window ends and the count resets. */
	resetAt: number;
}

export function currentWindow(now: number, windowMs = WINDOW_MS): Window {
	const start = Math.floor(now / windowMs) * windowMs;
	return { start, resetAt: start + windowMs };
}

export interface Decision {
	allowed: boolean;
	/** Requests counted in this window, including this one when allowed. */
	count: number;
	/** Whole seconds until the window resets (for Retry-After), at least 1. */
	retryAfter: number;
}

/** Decide on a request given how many were already counted in its window. A limit of 0 disables limiting. */
export function decide(previousCount: number, limit: number, now: number, windowMs = WINDOW_MS): Decision {
	const { resetAt } = currentWindow(now, windowMs);
	const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
	if (limit <= 0) return { allowed: true, count: previousCount + 1, retryAfter };
	if (previousCount >= limit) return { allowed: false, count: previousCount, retryAfter };
	return { allowed: true, count: previousCount + 1, retryAfter };
}

/**
 * Per-isolate counter. Best effort on its own (Workers spread traffic across
 * isolates), and the first layer in front of KV, which is eventually
 * consistent and catches bursts late.
 */
export class MemoryWindowCounter {
	private readonly counts = new Map<string, { start: number; count: number }>();
	private readonly maxKeys: number;
	private readonly windowMs: number;

	constructor(maxKeys = 10_000, windowMs = WINDOW_MS) {
		this.maxKeys = maxKeys;
		this.windowMs = windowMs;
	}

	/** Count a request for `key` and return the decision. */
	hit(key: string, limit: number, now: number): Decision {
		const { start } = currentWindow(now, this.windowMs);
		const entry = this.counts.get(key);
		const previous = entry && entry.start === start ? entry.count : 0;
		const decision = decide(previous, limit, now, this.windowMs);
		if (decision.allowed) {
			if (!entry && this.counts.size >= this.maxKeys) this.prune(start);
			this.counts.set(key, { start, count: decision.count });
		}
		return decision;
	}

	/** Drop entries from earlier windows; if still full, drop the oldest half. */
	prune(currentStart: number): void {
		for (const [key, entry] of this.counts) if (entry.start !== currentStart) this.counts.delete(key);
		if (this.counts.size >= this.maxKeys) {
			let drop = Math.ceil(this.counts.size / 2);
			for (const key of this.counts.keys()) {
				if (drop-- <= 0) break;
				this.counts.delete(key);
			}
		}
	}

	get size(): number {
		return this.counts.size;
	}
}

/** KV key for a client's window. */
export function kvKey(clientHash: string, windowStart: number): string {
	return `coywolf-search-rl:${clientHash}:${windowStart}`;
}

/** Search URLs the limiter covers: EmDash's public search and suggest endpoints, and the pack's search route. Admin endpoints (enable, rebuild, stats) aren't limited. */
export function isLimitedPath(pathname: string): boolean {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
	return (
		path === "/_emdash/api/search" ||
		path === "/_emdash/api/search/suggest" ||
		path === "/_emdash/api/plugins/coywolf-pack/search/query"
	);
}
