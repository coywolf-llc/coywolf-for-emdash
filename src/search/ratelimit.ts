/**
 * Rate limiting for search (feature "search.rateLimit"), served through the
 * pack middleware. Each client is keyed by a salted SHA-256 of its IP address
 * (Cloudflare's CF-Connecting-IP, which visitors can't spoof), never the
 * address itself. Two layers: a per-isolate counter, then, when a KV binding
 * is configured, a shared fixed window in KV.
 */
import type { PackMiddleware } from "../core/module.js";
import { MemoryWindowCounter, WINDOW_MS, currentWindow, decide, isLimitedPath, kvKey } from "./ratelimit-core.js";

export interface SearchRateLimitOptions {
	/** Requests per minute per visitor. Default 120; 0 turns limiting off. */
	requestsPerMinute?: number;
	/** KV namespace binding for a limit shared across isolates. Default none (per-isolate memory only). */
	kv?: string;
}

const DEFAULT_RPM = 120;
const SALT_KEY = "coywolf-search-rl:salt";
const SALT_SECRET = "SEARCH_RATE_LIMIT_SALT";

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
let salt: string | null = null;

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Salt: a Worker secret if set, else one stored in KV (so isolates agree), else per isolate. */
async function getSalt(env: Record<string, unknown>, kv: KVNamespace | undefined): Promise<string> {
	if (salt) return salt;
	const fromSecret = env[SALT_SECRET];
	if (typeof fromSecret === "string" && fromSecret) return (salt = fromSecret);
	if (kv) {
		try {
			const stored = await kv.get(SALT_KEY);
			if (stored) return (salt = stored);
			const fresh = randomHex(32);
			await kv.put(SALT_KEY, fresh);
			return (salt = fresh);
		} catch {
			// Fall through to a per-isolate salt.
		}
	}
	return (salt = randomHex(32));
}

async function hashClient(ip: string, saltValue: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${saltValue}:${ip}`));
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
	handle: async (context, env, waitUntil) => {
		if (!isLimitedPath(context.url.pathname)) return undefined;
		const limit = config.requestsPerMinute ?? DEFAULT_RPM;
		if (limit <= 0) return undefined;
		const ip = clientIp(context.request, () => context.clientAddress);
		if (!ip) return undefined;

		const kv = config.kv ? (env[config.kv] as KVNamespace | undefined) : undefined;
		const client = await hashClient(ip, await getSalt(env, kv));
		const now = Date.now();

		const local = memory.hit(client, limit, now);
		if (!local.allowed) return tooMany(local.retryAfter);

		if (kv) {
			const { start } = currentWindow(now, WINDOW_MS);
			const key = kvKey(client, start);
			try {
				const previous = Number((await kv.get(key)) ?? 0) || 0;
				const shared = decide(previous, limit, now);
				if (!shared.allowed) return tooMany(shared.retryAfter);
				// KV's minimum TTL is 60 seconds; keep the key a little past its window.
				waitUntil(kv.put(key, String(shared.count), { expirationTtl: 120 }).catch(() => undefined));
			} catch (error) {
				console.error("coywolf-pack: search rate limit KV unavailable", error);
			}
		}
		return undefined;
	},
};
