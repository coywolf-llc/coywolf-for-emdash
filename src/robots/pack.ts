import type { PluginContext } from "emdash";

import { registerFeatures } from "../core/features.js";
import type { PackMiddleware, PackModule } from "../core/module.js";
import { serveRobots } from "./middleware.js";
import { type RobotsOptions, robotsModule } from "./module.js";
import { OVERLAY_COLLECTION, RADAR_HOST, syncRadar } from "./radar.js";

const FEATURES = [
	{
		id: "robots",
		label: "Robots.txt Rules",
		description:
			"Serve robots.txt from named, plain-English rules: block AI training crawlers, allow search engines, custom path rules, with a URL tester. EmDash's admin, media and sitemap lines are kept.",
		default: false,
	},
	{
		id: "robots.radarSync",
		label: "Weekly crawler list from Cloudflare Radar",
		description: "Refresh the crawler directory every week from the Cloudflare Radar API (needs a Radar API token).",
		default: false,
	},
];
registerFeatures(FEATURES);

export const ROBOTS_TASK = "robots-refresh-bots";

export function robotsPack(options: RobotsOptions): PackModule {
	return {
		id: "robots",
		label: "Robots.txt Rules",
		features: FEATURES,
		routes: robotsModule(options).routes,
		tasks: [
			{
				name: ROBOTS_TASK,
				schedule: "@weekly",
				feature: "robots.radarSync",
				handler: async (ctx: PluginContext) => {
					try {
						await syncRadar(ctx);
					} catch {
						// Already logged and recorded for the admin page.
					}
				},
			},
		],
		adminPages: [{ path: "/robots", label: "Robots.txt", icon: "robot" }],
		storage: { [OVERLAY_COLLECTION]: { indexes: [] } },
		capabilities: ["network:request"],
		allowedHosts: [RADAR_HOST],
	};
}

/** Serves /robots.txt while the feature is on (site database binding "DB"). */
export const robotsMiddleware: PackMiddleware = {
	module: "robots",
	feature: "robots",
	handle: (context, env) => serveRobots(context.url, context.request.method, env),
};
