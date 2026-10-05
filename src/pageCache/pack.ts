import { PluginRouteError, definePluginRoute } from "emdash";
import { z } from "zod";

import { registerFeatures, registerSiteSetting, rememberSiteSetting, requireFeature, siteFeatureOn } from "../core/features.js";
import { parseInput } from "../shared.js";
import { CLOUDFLARE_API_HOST, CloudflareApiError, applyMediaCacheRule, readMediaCacheRule } from "../images/cloudflare.js";
import { mediaApiAccess, purgeMediaHost } from "../images/module.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { purgeIfNewVersion, purgePageCache, versionId } from "./lib.js";

export const PAGE_CACHE_FEATURE = "pageCache";

const FEATURES = [
	{
		id: PAGE_CACHE_FEATURE,
		label: "Page cache",
		description:
			"For sites using Cloudflare Workers Cache (Astro's cacheCloudflare()): clear cached pages after each deploy and whenever Coywolf Pack settings change. EmDash clears pages itself when content changes.",
		default: false,
	},
];
registerFeatures(FEATURES);

/** How long the edge keeps a page, and how long after that it may serve it while refreshing. */
export const LIFETIME_SETTINGS = { maxAgeDays: "pageCacheMaxAgeDays", refreshDays: "pageCacheRefreshDays" } as const;
export const LIFETIME_DEFAULTS = { maxAgeDays: 7, refreshDays: 1 } as const;
registerSiteSetting(LIFETIME_SETTINGS.maxAgeDays);
registerSiteSetting(LIFETIME_SETTINGS.refreshDays);

const lifetimeInput = z.object({
	maxAgeDays: z.number().int().min(1, "Keep pages for at least 1 day.").max(365, "Keep pages for at most 365 days."),
	refreshDays: z.number().int().min(0).max(365, "Refresh for at most 365 days."),
});

const apiError = (error: unknown): never => {
	if (error instanceof CloudflareApiError) throw PluginRouteError.badRequest(error.message);
	throw error;
};

export function pageCachePack(): PackModule {
	return {
		id: "pageCache",
		label: "Page cache",
		features: FEATURES,
		routes: {
			/** The Performance section: page lifetimes and whether the site has Workers Cache. */
			"cache/settings": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Parameters<typeof requireFeature>[0]) => {
					await requireFeature(ctx, PAGE_CACHE_FEATURE);
					const [maxAgeDays, refreshDays] = await Promise.all([
						ctx.settings.get<number>(LIFETIME_SETTINGS.maxAgeDays),
						ctx.settings.get<number>(LIFETIME_SETTINGS.refreshDays),
					]);
					return {
						maxAgeDays: maxAgeDays ?? LIFETIME_DEFAULTS.maxAgeDays,
						refreshDays: refreshDays ?? LIFETIME_DEFAULTS.refreshDays,
						images: await siteFeatureOn("images"),
					};
				},
			},

			"cache/settings/save": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json" },
				handler: async (ctx) => {
					await requireFeature(ctx, PAGE_CACHE_FEATURE);
					const input = parseInput(lifetimeInput, ctx.input);
					await ctx.settings.set(LIFETIME_SETTINGS.maxAgeDays, input.maxAgeDays);
					await ctx.settings.set(LIFETIME_SETTINGS.refreshDays, input.refreshDays);
					rememberSiteSetting(LIFETIME_SETTINGS.maxAgeDays, input.maxAgeDays);
					rememberSiteSetting(LIFETIME_SETTINGS.refreshDays, input.refreshDays);
					// Pages already cached keep their old lifetime; the pack's purge-after-save clears them.
					return input;
				},
			}),

			/** The media host's Cloudflare Cache Rule (read through the Clean Image URLs token). */
			"cache/media": {
				permission: "plugins:manage" as const,
				handler: async (ctx: Parameters<typeof mediaApiAccess>[0]) => {
					await requireFeature(ctx, PAGE_CACHE_FEATURE);
					const access = await mediaApiAccess(ctx);
					if (!("config" in access)) return { host: access.hostname, reason: access.reason, rule: null };
					try {
						const { zone, rule } = await readMediaCacheRule(access.config, access.hostname);
						return { host: access.hostname, zone, rule };
					} catch (error) {
						return { host: access.hostname, reason: error instanceof Error ? error.message : String(error), rule: null };
					}
				},
			},

			"cache/media/apply": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					await requireFeature(ctx, PAGE_CACHE_FEATURE);
					const access = await mediaApiAccess(ctx);
					if (!("config" in access)) throw PluginRouteError.badRequest(access.reason);
					const zone = await applyMediaCacheRule(access.config, access.hostname).catch(apiError);
					ctx.log.info("Media cache rule applied", { host: access.hostname, zone });
					return { host: access.hostname, zone, ...(await readMediaCacheRule(access.config, access.hostname).catch(() => ({ rule: null }))) };
				},
			}),

			/**
			 * Clear every cached page now, and the media host's images in the
			 * zone cache when Clean image URLs has a media host.
			 */
			"cache/purge": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "none" },
				handler: async (ctx) => {
					await requireFeature(ctx, PAGE_CACHE_FEATURE);
					const pages = await purgePageCache();
					const images = (await siteFeatureOn("images")) ? await purgeMediaHost(ctx) : { purged: false, host: null };
					if (!pages && !images.purged) {
						throw PluginRouteError.badRequest(images.message ?? "This site isn't using Workers Cache, so there are no pages to clear.");
					}
					ctx.log.info("Page cache cleared", { pages, images: images.purged ? images.host : false });
					return { pages, images };
				},
			}),
		},
		// The Clear button lives in the Actions section of the Coywolf Pack page.
		adminPages: [],
		// Clearing the media host's images goes through the Cloudflare API.
		capabilities: ["network:request"],
		allowedHosts: [CLOUDFLARE_API_HOST],
	};
}

let checkedVersion = false;

/** Once per isolate: if this is a new deploy, clear the cache (never answers a request). */
export const pageCacheMiddleware: PackMiddleware = {
	module: "pageCache",
	feature: PAGE_CACHE_FEATURE,
	handle: (_context, env, waitUntil) => {
		if (checkedVersion) return undefined;
		checkedVersion = true;
		const id = versionId(env);
		const db = env.DB as D1Database | undefined;
		if (id && db) waitUntil(purgeIfNewVersion(db, id).catch((error) => console.error("coywolf-pack: page cache version check failed", error)));
		return undefined;
	},
};
