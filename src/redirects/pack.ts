import { registerFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { serveRedirect } from "./middleware.js";
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
			"When a published entry is deleted or unpublished, list its old URL on the Redirects page to redirect it, mark it 410 Gone, or dismiss it.",
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
	handle: (context, env, waitUntil) => serveRedirect(context.url, env, waitUntil),
};
