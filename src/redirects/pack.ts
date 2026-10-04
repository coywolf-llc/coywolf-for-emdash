import { registerFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { serveRedirect } from "./middleware.js";
import { type RedirectsOptions, redirectsModule } from "./module.js";

const FEATURES = [
	{
		id: "redirects",
		label: "Redirects",
		description: "External and file-path redirects, regular expressions, hit counts, and import.",
		default: true,
	},
];
registerFeatures(FEATURES);

export function redirectsPack(options: RedirectsOptions): PackModule {
	return {
		id: "redirects",
		label: "Redirects",
		features: FEATURES,
		routes: redirectsModule(options).routes,
		adminPages: [{ path: "/redirects", label: "Redirects", icon: "arrow-bend-up-right" }],
	};
}

export const redirectsMiddleware: PackMiddleware = {
	module: "redirects",
	feature: "redirects",
	handle: (context, env, waitUntil) => serveRedirect(context.url, env, waitUntil),
};
