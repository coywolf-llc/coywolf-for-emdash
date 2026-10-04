import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { discoveryMiddleware } from "./middleware.js";
import { type DiscoveryOptions, FEATURE, discoveryModule } from "./module.js";

const FEATURES = [
	{
		id: FEATURE.main,
		label: "Discovery",
		description: "Help search engines and AI agents find your content: IndexNow, a Google News sitemap, and llms.txt with Markdown versions of entries.",
		default: false,
	},
	{
		id: FEATURE.indexnow,
		label: "IndexNow",
		description: "Tell Bing, Yandex, Seznam, Naver and other IndexNow engines when entries are published, updated, unpublished, or deleted.",
		default: false,
	},
	{
		id: FEATURE.news,
		label: "News sitemap",
		description: "A Google News sitemap at /news-sitemap.xml with entries published in the last 48 hours.",
		default: false,
	},
	{
		id: FEATURE.llms,
		label: "llms.txt and Markdown",
		description: "An llms.txt index at /llms.txt and a Markdown version of each entry at its URL + index.html.md.",
		default: false,
	},
];
registerFeatures(FEATURES);

export type { DiscoveryOptions } from "./module.js";

export function discoveryPack(options: DiscoveryOptions): PackModule {
	const { routes, hooks } = discoveryModule(options);
	return {
		id: "discovery",
		label: "Discovery",
		features: FEATURES,
		routes,
		hooks,
		hookFeature: { "page:fragments": FEATURE.llms },
		adminPages: [{ path: "/discovery", label: "Discovery", icon: "compass" }],
		capabilities: ["content:read", "schema:read", "network:request", "hooks.page-fragments:register"],
		allowedHosts: ["api.indexnow.org", "www.bing.com"],
	};
}

export { discoveryMiddleware };
