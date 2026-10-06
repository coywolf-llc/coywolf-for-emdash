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
import { applyPageLifetime, purgePageCache, purgeScope, purgesAfter, shortenStopgapPage } from "./pageCache/lib.js";
import { STOPGAP_HEADER, WARMER_AGENT, WARM_SETTING, startWarm, warmStep } from "./pageCache/warm.js";
import { notePackMiddleware } from "./search/live-serve.js";
import { pendingPosterRenders, renderedPendingPoster } from "./videos/poster.js";

/** Per isolate: when this isolate last started a warming step (one at a time, at most every few seconds). */
let warmingUntil = 0;
const WARM_EVERY_MS = 5_000;
const WARM_BUDGET_MS = 20_000;

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
		// Pages rendered in this isolate may now load the live search client as a file (it's served below).
		notePackMiddleware();
		const env = workers.env;
		const waitUntil = (p: Promise<unknown>) => (workers.waitUntil ? workers.waitUntil(p) : void p);
		const features = await siteFeatures(options.database);
		// Page cache: a successful pack admin write (settings, redirects, imports…) can change any page.
		if (purgesAfter(context.request.method, context.url.pathname)) {
			const response = await next();
			const scope = purgeScope(context.url.pathname);
			if (response.status < 400 && scope) {
				waitUntil(
					purgePageCache(scope).then(async (purged) => {
						const db = env[options.database ?? "DB"] as D1Database | undefined;
						if (purged && "purgeEverything" in scope && db && (await siteSetting<boolean>(WARM_SETTING, options.database))) await startWarm(db, "settings");
					}),
				);
			}
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
		// Cache warming rides on real page traffic (see src/pageCache/warm.ts): after this
		// response, claim a small batch of cold pages and visit them in the background.
		if (
			context.request.method === "GET" &&
			!context.url.pathname.startsWith("/_emdash/") &&
			context.request.headers.get("user-agent") !== WARMER_AGENT &&
			Date.now() > warmingUntil &&
			(await siteSetting<boolean>(WARM_SETTING, options.database))
		) {
			const db = env[options.database ?? "DB"] as D1Database | undefined;
			const self = env.SELF as { fetch(request: Request): Promise<Response> } | undefined;
			if (db && self) {
				warmingUntil = Date.now() + WARM_BUDGET_MS + WARM_EVERY_MS;
				const origin = (context.site ?? context.url).origin;
				waitUntil(
					warmStep(db, self, origin, { budgetMs: WARM_BUDGET_MS, batchSize: 4 })
						.catch((error) => console.error("coywolf-pack: cache warming failed", error))
						.finally(() => {
							warmingUntil = Date.now() + WARM_EVERY_MS;
						}),
				);
			}
		}
		for (const handler of handlers) {
			if (handler.feature !== ALWAYS && !isOn(features, handler.feature)) continue;
			try {
				const response = await handler.handle(context, env, waitUntil);
				if (response) {
					// The pack's own responses (redirects, robots.txt, files…) set their own
					// Cache-Control. Without this, a site route rule (e.g. on a catch-all page
					// route) would add its edge lifetime to them too, so redirects would be
					// cached and stop counting hits.
					(context as unknown as { cache?: { set?(options: false): void } }).cache?.set?.(false);
					return response;
				}
			} catch (error) {
				console.error(`coywolf-pack: ${handler.module} middleware failed`, error);
			}
		}
		// A page that showed a video's Stream poster while its media-host copy is made
		// (src/videos/poster.ts) is cached for minutes, not days, so the next render uses the copy.
		// The cache warmer's render of such a page isn't cached; it's told so (STOPGAP_HEADER) and visits again.
		if (context.request.method === "GET" && isOn(features, "images")) {
			const before = pendingPosterRenders();
			const response = await next();
			return shortenStopgapPage(
				(context as unknown as { cache?: Parameters<typeof shortenStopgapPage>[0] }).cache,
				response,
				() => renderedPendingPoster(context.locals, before),
				context.request.headers.get("user-agent") === WARMER_AGENT ? STOPGAP_HEADER : undefined,
			);
		}
		return next();
	};
}

/** Earlier name, kept so existing sites keep working. Serves all pack middleware, not just redirects. */
export const coywolfRedirects = coywolfPack;
