/**
 * Abuse limits for the public plays and likes routes (pure; unit tested in Node).
 *
 * Visitors are told apart by a daily-salted hash of the IP address alone: the
 * user agent is set by the client, so mixing it in let one address count as
 * any number of visitors. On top of that, each address may only play and like
 * so often per minute (per isolate, like the search fallback limiter), and
 * only add so many likes per day (counted in plugin KV, so across isolates).
 */
import { MemoryWindowCounter } from "../search/ratelimit-core.js";

/**
 * Sent by the Coywolf Video script with every play and like. A cross-site form
 * or image can't set a custom header, and a cross-site fetch with one needs a
 * CORS preflight the route never grants, so likes can't be forged from another site.
 */
export const ENGAGEMENT_HEADER = "x-coywolf-video";

export const ENGAGEMENT_LIMITS = {
	/** Play requests per address per minute. */
	playsPerMinute: 10,
	/** Like and unlike requests per address per minute. */
	likesPerMinute: 20,
	/** New likes per address per day. */
	likesPerDay: 100,
} as const;

const DAY_MS = 86_400_000;

export function hasEngagementHeader(headers: Headers): boolean {
	return headers.get(ENGAGEMENT_HEADER) === "1";
}

/** Per-isolate counters for one address (by its visitor hash, never the address itself). */
export class EngagementLimiter {
	private readonly plays = new MemoryWindowCounter(10_000, 60_000);
	private readonly likes = new MemoryWindowCounter(10_000, 60_000);
	private readonly daily = new MemoryWindowCounter(10_000, DAY_MS);

	/** Count a play request; false when the address is over its per-minute limit. */
	play(visitor: string, now = Date.now()): boolean {
		return this.plays.hit(visitor, ENGAGEMENT_LIMITS.playsPerMinute, now).allowed;
	}

	/** Count a like or unlike request; false when the address is over its per-minute limit. */
	like(visitor: string, now = Date.now()): boolean {
		return this.likes.hit(visitor, ENGAGEMENT_LIMITS.likesPerMinute, now).allowed;
	}

	/** Count a new like in this isolate; false once the address has used the day's likes. */
	newLike(visitor: string, now = Date.now()): boolean {
		return this.daily.hit(visitor, ENGAGEMENT_LIMITS.likesPerDay, now).allowed;
	}
}

/** KV key for the number of likes one address added on `day` (pruned by the daily likes task). */
export const LIKES_BY_PREFIX = "state:videos:likesBy:";
export const likesByKey = (day: string, visitor: string) => `${LIKES_BY_PREFIX}${day}:${visitor}`;

/** True when a likesBy key is from before `cutoff` (YYYY-MM-DD). */
export function staleLikesByKey(key: string, cutoff: string): boolean {
	const day = key.slice(LIKES_BY_PREFIX.length, LIKES_BY_PREFIX.length + 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff;
}

/**
 * What a like request does. New scripts send the state the visitor wants, so
 * two people behind one address (who now share a visitor id) don't undo each
 * other's like; without it the request toggles, as it always did.
 */
export function likeAction(liked: boolean | undefined, exists: boolean): "add" | "remove" | "keep" {
	if (liked === undefined) return exists ? "remove" : "add";
	if (liked) return exists ? "keep" : "add";
	return exists ? "remove" : "keep";
}
