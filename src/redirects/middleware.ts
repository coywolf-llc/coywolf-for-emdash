/**
 * Astro middleware that serves Coywolf redirects. Add it to the site's
 * src/middleware.ts:
 *
 * ```ts
 * import { sequence } from "astro:middleware";
 * import { coywolfRedirects } from "@coywolf/emdash/middleware";
 * export const onRequest = sequence(coywolfRedirects(), yourMiddleware);
 * ```
 *
 * Rules are read from D1 at most once a minute per Worker isolate; hits are
 * counted after the response is sent.
 */
import type { MiddlewareHandler } from "astro";

import { type CompiledRules, compile, listRules, match, recordHit } from "./rules.js";

export interface CoywolfRedirectsOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
	/** Seconds to cache rules per isolate. Default 60. */
	cacheSeconds?: number;
}

let cache: { compiled: CompiledRules; loadedAt: number } | null = null;

/** Drop the in-memory rules so the next request reloads them (called after admin edits). */
export function invalidateRedirectCache(): void {
	cache = null;
}

const SKIP = /^\/(_emdash|_astro|_image)\//;

export function coywolfRedirects(options: CoywolfRedirectsOptions = {}): MiddlewareHandler {
	const ttl = (options.cacheSeconds ?? 60) * 1000;
	return async (context, next) => {
		const { pathname, search } = context.url;
		if (SKIP.test(pathname)) return next();

		let workers: { env: Record<string, unknown>; waitUntil?: (p: Promise<unknown>) => void };
		try {
			workers = (await import("cloudflare:workers")) as unknown as typeof workers;
		} catch {
			return next(); // Not running on Cloudflare.
		}
		const db = workers.env[options.database ?? "DB"] as D1Database | undefined;
		if (!db) return next();

		if (!cache || Date.now() - cache.loadedAt > ttl) {
			try {
				cache = { compiled: compile(await listRules(db)), loadedAt: Date.now() };
			} catch (error) {
				console.error("coywolf redirects: could not load rules", error);
				return next();
			}
		}

		const found = match(cache.compiled, pathname, search);
		if (!found) return next();

		const hit = recordHit(db, found.rule.id).catch(() => undefined);
		if (workers.waitUntil) workers.waitUntil(hit);

		if (found.rule.type === 410) return new Response("Gone", { status: 410 });
		const location = found.location.startsWith("/") ? new URL(found.location, context.url).href : found.location;
		return new Response(null, { status: found.rule.type, headers: { Location: location } });
	};
}
