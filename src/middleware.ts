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

import { invalidateFeatures, knownFeatures, registerSiteOption, rememberSiteOption, siteFeatures, siteOption, siteSetting, isOn } from "./core/features.js";
import { claimSettle, recordSettingsChange } from "./core/generation.js";
import { injectAdminEnhancements } from "./core/settings-enhance.js";
import type { PackMiddleware } from "./core/module.js";
import { MIDDLEWARE } from "./modules.js";
import { ALWAYS, LIFETIME_DEFAULTS, LIFETIME_SETTINGS } from "./pageCache/pack.js";
import { type PurgeScope, applyPageLifetime, purgePageCache, purgeScope, purgesAfter, shortenStopgapPage, watchInvalidation } from "./pageCache/lib.js";
import { STOPGAP_HEADER, WARMER_AGENT, WARM_DAILY_SETTING, WARM_SETTING, WARM_STATE_OPTION, scheduleRewarm, startWarm, warmMayHaveWork, warmStep } from "./pageCache/warm.js";
import { prefetchRedirects } from "./redirects/middleware.js";
import { notePackMiddleware } from "./search/live-serve.js";
import { pendingPosterRenders, renderedPendingPoster } from "./videos/poster.js";

// The warming progress row is read with the feature switches, so requests can skip an idle warmer without a query.
registerSiteOption(WARM_STATE_OPTION);

/**
 * False when the progress row as last read with the switches says there's
 * nothing to warm (the run is done or failed, and no rewarm or daily refresh is due), so
 * the request skips its warming step and that step's read. A run started (or
 * rewarm scheduled) in another isolate is seen on this isolate's next read of
 * the switches (FEATURES_TTL_MS at most); one started here is remembered at
 * once. True when unknown.
 */
function warmingMayHaveWork(daily: boolean): boolean {
	return warmMayHaveWork(siteOption(WARM_STATE_OPTION), Date.now(), daily);
}

/** The daily refresh is on unless turned off (read with the switches, so no extra query). */
async function warmDaily(database?: string): Promise<boolean> {
	return (await siteSetting<boolean>(WARM_DAILY_SETTING, database)) !== false;
}

/** Start warming, and remember the new run in this isolate's copy of the progress row. */
async function startWarming(db: D1Database, reason: string): Promise<void> {
	const state = await startWarm(db, reason);
	rememberSiteOption(WARM_STATE_OPTION, JSON.stringify(state));
}

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
		// This request's redirect lookup goes to D1 in the same batch as the switches (when they aren't cached).
		// (Skipped when the switches this isolate last read have Redirects off.)
		const known = knownFeatures();
		if (!known || isOn(known, "redirects")) prefetchRedirects(context.url, env, { database: options.database });
		const features = await siteFeatures(options.database);
		const db = env[options.database ?? "DB"] as D1Database | undefined;
		/** Clear cached pages, then (for a full purge, when warming is on) start warming them again. */
		const purge = (scope: PurgeScope) =>
			purgePageCache(scope).then(async (purged) => {
				if (purged && "purgeEverything" in scope && db && (await siteSetting<boolean>(WARM_SETTING, options.database))) await startWarming(db, "settings");
			});
		// Page cache: a successful pack admin write (settings, redirects, imports…) can change any page.
		if (purgesAfter(context.request.method, context.url.pathname)) {
			const response = await next();
			const scope = purgeScope(context.url.pathname);
			if (response.status < 400) {
				// This isolate's settings caches go now; other isolates drop theirs when they see the new generation.
				invalidateFeatures();
				const recorded = db
					? recordSettingsChange(db, scope).catch((error) => console.error("coywolf-pack: could not record the settings change", error))
					: Promise.resolve();
				if (scope) waitUntil(recorded.then(() => purge(scope)));
				else waitUntil(recorded);
			}
			return response;
		}
		// Content writes: EmDash clears the pages tagged with the collection (home page, archives, many
		// posts). With warming on, a run starts a minute after the last such write (scheduleRewarm).
		const method = context.request.method;
		const invalidated =
			method !== "GET" && method !== "HEAD" && context.url.pathname.startsWith("/_emdash/api/")
				? watchInvalidation((context as unknown as { cache?: Parameters<typeof watchInvalidation>[0] }).cache)
				: null;
		const afterWrite = (response: Response): Response => {
			if (invalidated?.() && response.status < 400 && db) {
				waitUntil(
					(async () => {
						if (!(await siteSetting<boolean>(WARM_SETTING, options.database))) return;
						const state = await scheduleRewarm(db);
						if (state) rememberSiteOption(WARM_STATE_OPTION, JSON.stringify(state));
					})().catch((error) => console.error("coywolf-pack: could not schedule cache warming", error)),
				);
			}
			return response;
		};
		// Settings saved in another isolate reach every isolate within the switches' lifetime; pages
		// rendered meanwhile may have used the old ones, so the first request after that purges once more.
		if (db) {
			waitUntil(
				claimSettle(db)
					.then((scope) => (scope ? purge(scope) : undefined))
					.catch((error) => console.error("coywolf-pack: settling purge failed", error)),
			);
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
			(await siteSetting<boolean>(WARM_SETTING, options.database)) &&
			warmingMayHaveWork(await warmDaily(options.database))
		) {
			const self = env.SELF as { fetch(request: Request): Promise<Response> } | undefined;
			if (db && self) {
				warmingUntil = Date.now() + WARM_BUDGET_MS + WARM_EVERY_MS;
				const origin = (context.site ?? context.url).origin;
				waitUntil(
					warmStep(db, self, origin, { budgetMs: WARM_BUDGET_MS, batchSize: 4, daily: await warmDaily(options.database) })
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
					// The pack's own responses (robots.txt, files…) set their own Cache-Control.
					// Without this, a site route rule (e.g. on a catch-all page route) would add
					// its edge lifetime to them too. Redirects set their own edge caching.
					if (!handler.ownsCache) (context as unknown as { cache?: { set?(options: false): void } }).cache?.set?.(false);
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
		return afterWrite(await next());
	};
}

/** Earlier name, kept so existing sites keep working. Serves all pack middleware, not just redirects. */
export const coywolfRedirects = coywolfPack;
