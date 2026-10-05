import { PluginRouteError, definePluginRoute } from "emdash";

import { registerFeatures, requireFeature, siteFeatureOn } from "../core/features.js";
import { CLOUDFLARE_API_HOST } from "../images/cloudflare.js";
import { purgeMediaHost } from "../images/module.js";
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

export function pageCachePack(): PackModule {
	return {
		id: "pageCache",
		label: "Page cache",
		features: FEATURES,
		routes: {
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
