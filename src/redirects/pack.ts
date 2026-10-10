import { registerFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { serveCachedRedirect } from "./middleware.js";
import { type RedirectsOptions, redirectsModule } from "./module.js";
import { TRASH_PROMPT_FEATURE, removedModule } from "./removed.js";

const FEATURES = [
	{
		id: "redirects",
		label: "Redirects",
		description: "External and file-path redirects, regular expressions, hit counts, and import.",
		default: true,
	},
	{
		id: TRASH_PROMPT_FEATURE,
		label: "Removed content",
		description:
			"When a published entry is trashed or unpublished, ask what its old URL should do: redirect it or return 410 Gone. Undecided URLs stay listed on the Redirects page.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function redirectsPack(options: RedirectsOptions): PackModule {
	const removed = removedModule(options);
	return {
		id: "redirects",
		label: "Redirects",
		features: FEATURES,
		routes: { ...redirectsModule(options).routes, ...removed.routes },
		adminPages: [{ path: "/redirects", label: "Redirects", icon: "arrow-bend-up-right" }],
		hooks: removed.hooks,
		hookFeature: Object.fromEntries(Object.keys(removed.hooks).map((name) => [name, TRASH_PROMPT_FEATURE])),
		storage: removed.storage,
		capabilities: ["content:read"],
	};
}

export const redirectsMiddleware: PackMiddleware = {
	module: "redirects",
	feature: "redirects",
	ownsCache: true,
	handle: serveCachedRedirect,
};
