/**
 * Rate limiting for search (feature "search.rateLimit"), served through the
 * pack middleware. Each client is keyed by a salted SHA-256 of its IP address
 * (Cloudflare's CF-Connecting-IP, which visitors can't spoof), never the
 * address itself. With a Workers Rate Limiting binding (option
 * `rateLimiter`), Cloudflare counts across isolates; without one, a
 * per-isolate in-memory counter does, best effort.
 */
import type { PackMiddleware } from "../core/module.js";
import { MemoryWindowCounter, type RateLimitBinding, isLimitedPath, limitClient } from "./ratelimit-core.js";

export interface SearchRateLimitOptions {
	/** Requests per minute per visitor for the in-memory fallback. Default 120; 0 turns the fallback off. With a binding, the binding's own limit applies. */
	requestsPerMinute?: number;
	/** Name of a Workers Rate Limiting binding (wrangler "ratelimits"). Default none (per-isolate memory only). */
	rateLimiter?: string;
}

const DEFAULT_RPM = 120;
const SALT_SECRET = "SEARCH_RATE_LIMIT_SALT";
/** Used when no secret is set. Keys must agree across isolates for the binding, so this can't be random per isolate. */
const DEFAULT_SALT = "coywolf-pack:search-rate-limit";

/**
 * Options from coywolfPlugin({ search }). EmDash instantiates plugins when the
 * Worker starts (the generated plugins module calls createPlugin at import),
 * so this is set before any request reaches the middleware.
 */
let config: SearchRateLimitOptions = {};
export function configureSearchRateLimit(options: SearchRateLimitOptions): void {
	config = { ...options };
}

const memory = new MemoryWindowCounter();

async function hashClient(ip: string, salt: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
	return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(request: Request, fallback: () => string | undefined): string | null {
	const header = request.headers.get("cf-connecting-ip");
	if (header) return header.trim();
	try {
		return fallback() ?? null;
	} catch {
		return null;
	}
}

/** Every limited path is a JSON API, so answer in EmDash's error shape. */
function tooMany(retryAfter: number): Response {
	return Response.json(
		{ success: false, error: { code: "RATE_LIMITED", message: "Too many searches. Try again shortly." } },
		{ status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } },
	);
}

export const searchRateLimitMiddleware: PackMiddleware = {
	module: "search",
	feature: "search.rateLimit",
	handle: async (context, env) => {
		if (!isLimitedPath(context.url.pathname)) return undefined;
		const binding = config.rateLimiter ? (env[config.rateLimiter] as RateLimitBinding | undefined) : undefined;
		const limit = config.requestsPerMinute ?? DEFAULT_RPM;
		if (!binding && limit <= 0) return undefined;
		const ip = clientIp(context.request, () => context.clientAddress);
		if (!ip) return undefined;
		const secret = env[SALT_SECRET];
		const client = await hashClient(ip, typeof secret === "string" && secret ? secret : DEFAULT_SALT);
		const result = await limitClient(client, { limit, now: Date.now(), memory, binding });
		return result.allowed ? undefined : tooMany(result.retryAfter);
	},
};
