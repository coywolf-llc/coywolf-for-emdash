import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { type SearchOptions, searchModule } from "./module.js";
import { configureSearchRateLimit } from "./ratelimit.js";

export { searchRateLimitMiddleware } from "./ratelimit.js";

const FEATURES = [
	{
		id: "search",
		label: "Search",
		description: "Tools on top of EmDash's built-in full-text search.",
		default: false,
	},
	{
		id: "search.settings",
		label: "Search settings",
		description: "An admin page for which collections are searchable, field weights, the tokenizer, and index rebuilds.",
		default: false,
	},
	{
		id: "search.box",
		label: "Search box",
		description:
			"The SearchBox component: as-you-type suggestions, and results for any of the words when nothing matches all of them.",
		default: false,
	},
	{
		id: "search.rateLimit",
		label: "Search rate limit",
		description: "Limits how often one visitor can search (120 a minute by default), answering 429 beyond that.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function searchPack(options: SearchOptions): PackModule {
	configureSearchRateLimit({ requestsPerMinute: options.requestsPerMinute, kv: options.kv });
	return {
		id: "search",
		label: "Search",
		features: FEATURES,
		routes: searchModule(options).routes,
		adminPages: [{ path: "/search", label: "Search", icon: "magnifying-glass" }],
	};
}
