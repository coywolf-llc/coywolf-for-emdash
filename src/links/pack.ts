import type { PluginContext } from "emdash";

import { registerFeatures } from "../core/features.js";
import type { PackModule } from "../core/module.js";
import { LINKS_CHECK_TASK, LINKS_SCAN_TASK, linksModule } from "./module.js";
import { STORAGE } from "./store.js";

const FEATURES = [
	{
		id: "links",
		label: "Link Manager",
		description: "An inventory of every link in your content, with bulk replace, unlink, and ignore rules.",
		default: false,
	},
	{
		id: "links.check",
		label: "Scheduled link checking",
		description: "Check links in the background (broken links daily, working links weekly) and flag broken, redirected and blocked ones.",
		default: false,
	},
];
registerFeatures(FEATURES);

export function linksPack(): PackModule {
	const links = linksModule();
	return {
		id: "links",
		label: "Link Manager",
		features: FEATURES,
		routes: links.routes,
		hooks: links.hooks,
		tasks: [
			{ name: LINKS_SCAN_TASK, schedule: "*/5 * * * *", handler: (ctx: PluginContext) => links.scanTask(ctx) },
			{ name: LINKS_CHECK_TASK, schedule: "*/5 * * * *", feature: "links.check", handler: (ctx: PluginContext) => links.checkTask(ctx) },
		],
		adminPages: [{ path: "/links", label: "Link Manager", icon: "link" }],
		widgets: [{ id: "links-status", title: "Links", size: "third" }],
		storage: STORAGE,
		capabilities: ["content:read", "content:write", "content:revisions:read", "content:publish", "schema:read"],
	};
}
