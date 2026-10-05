/**
 * Coywolf Pack site middleware: everything the pack serves outside EmDash's
 * plugin API (redirects, and module files such as sitemaps or downloads).
 * Add it first in the site's src/middleware.ts:
 *
 * ```ts
 * import { sequence } from "astro:middleware";
 * import { coywolfPack } from "@coywolf/emdash/middleware";
 * export const onRequest = sequence(coywolfPack(), yourMiddleware);
 * ```
 *
 * Each module's handler runs only while its feature is on.
 */
import type { MiddlewareHandler } from "astro";

import { siteFeatures, siteSetting, isOn } from "./core/features.js";
import { injectAdminEnhancements } from "./core/settings-enhance.js";
import type { PackMiddleware } from "./core/module.js";
import { MIDDLEWARE } from "./modules.js";
import { ALWAYS, LIFETIME_DEFAULTS, LIFETIME_SETTINGS } from "./pageCache/pack.js";
import { applyPageLifetime, purgePageCache, purgesAfter } from "./pageCache/lib.js";

export interface CoywolfPackMiddlewareOptions {
	/** D1 binding of the site database. Default "DB". */
	database?: string;
}

const PASS_THROUGH = /^\/(_astro|_image)\//;
/** EmDash admin pages (not its API): the pack adds its admin enhancements (step-by-step guides on the plugin Settings page). */
const ADMIN_PAGE = /^\/_emdash\/admin(\/|$)/;

export function coywolfPack(options: CoywolfPackMiddlewareOptions = {}, handlers: PackMiddleware[] = MIDDLEWARE): MiddlewareHandler {
	return async (context, next) => {
		if (PASS_THROUGH.test(context.url.pathname)) return next();
		if (ADMIN_PAGE.test(context.url.pathname) && context.request.method === "GET") return injectAdminEnhancements(await next());
		let workers: { env: Record<string, unknown>; waitUntil?: (p: Promise<unknown>) => void };
		try {
			workers = (await import("cloudflare:workers")) as unknown as typeof workers;
		} catch {
			return next(); // Not running on Cloudflare.
		}
		const env = workers.env;
		const waitUntil = (p: Promise<unknown>) => (workers.waitUntil ? workers.waitUntil(p) : void p);
		const features = await siteFeatures(options.database);
		// Page cache: a successful pack admin write (settings, redirects, imports…) can change any page.
		if (purgesAfter(context.request.method, context.url.pathname)) {
			const response = await next();
			if (response.status < 400) waitUntil(purgePageCache());
			return response;
		}
		// Page cache lifetimes from Plugins → Performance, on routes the site made cacheable.
		if (context.request.method === "GET") {
			const [maxAgeDays, refreshDays] = await Promise.all([
				siteSetting<number>(LIFETIME_SETTINGS.maxAgeDays, options.database),
				siteSetting<number>(LIFETIME_SETTINGS.refreshDays, options.database),
			]);
			applyPageLifetime(
				(context as unknown as { cache?: Parameters<typeof applyPageLifetime>[0] }).cache,
				maxAgeDays ?? LIFETIME_DEFAULTS.maxAgeDays,
				refreshDays ?? LIFETIME_DEFAULTS.refreshDays,
			);
		}
		for (const handler of handlers) {
			if (handler.feature !== ALWAYS && !isOn(features, handler.feature)) continue;
			try {
				const response = await handler.handle(context, env, waitUntil);
				if (response) return response;
			} catch (error) {
				console.error(`coywolf-pack: ${handler.module} middleware failed`, error);
			}
		}
		return next();
	};
}

/** Earlier name, kept so existing sites keep working. Serves all pack middleware, not just redirects. */
export const coywolfRedirects = coywolfPack;
