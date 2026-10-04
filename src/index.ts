/**
 * Coywolf Pack for EmDash: one native plugin with Coywolf's features for
 * EmDash sites on Cloudflare. Register it in astro.config.mjs:
 *
 * ```js
 * import { coywolfPlugin } from "@coywolf/emdash";
 * emdash({ plugins: [coywolfPlugin({ backups: { name: "mysite" } })] });
 * ```
 *
 * and add `coywolfPack()` from "@coywolf/emdash/middleware" to the site's
 * middleware. Every feature can be turned on or off under Plugins → Features.
 */
import type { PluginCapability, PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

import { composeHooks, hookCapabilities } from "./core/compose.js";
import { configureContentUrls } from "./core/content-url.js";
import { PLUGIN_ID } from "./core/features.js";
import { featuresRoutes } from "./core/features-module.js";
import type { PackModule } from "./core/module.js";
import { MODULES } from "./modules.js";
import type { CoywolfOptions } from "./options.js";

export type { BackupsOptions } from "./backups/module.js";
export type { RedirectsOptions } from "./redirects/module.js";
export type { VideosOptions } from "./videos/module.js";
export type { RobotsOptions } from "./robots/module.js";
export type { CoywolfOptions } from "./options.js";
export type { ContentUrlOptions, TrailingSlash } from "./core/content-url.js";

const VERSION = "0.4.1";
const PACKAGE = "@coywolf/emdash";

function buildModules(options: CoywolfOptions): PackModule[] {
	// Module-level, like the search rate limit: createPlugin() runs when the Worker isolate
	// starts (virtual:emdash/plugins), so middleware and Astro components see it too.
	configureContentUrls({ urls: options.urls, trailingSlash: options.trailingSlash });
	return MODULES.map((factory) => factory(options)).filter((m): m is PackModule => m !== null);
}

function surfaces(modules: PackModule[]) {
	return {
		pages: [{ path: "/features", label: "Features", icon: "toggle-right" }, ...modules.flatMap((m) => m.adminPages ?? [])],
		widgets: modules.flatMap((m) => m.widgets ?? []),
		blocks: modules.flatMap((m) => m.portableTextBlocks ?? []),
		settingsSchema: Object.assign({}, ...modules.map((m) => m.settingsSchema ?? {})),
		storage: Object.assign({}, ...modules.map((m) => m.storage ?? {})),
		capabilities: [...new Set([...modules.flatMap((m) => m.capabilities ?? []), ...hookCapabilities(modules)])] as PluginCapability[],
		allowedHosts: [...new Set(modules.flatMap((m) => m.allowedHosts ?? []))],
	};
}

export function coywolfPlugin(options: CoywolfOptions = {}): PluginDescriptor<CoywolfOptions> {
	const s = surfaces(buildModules(options));
	return {
		id: PLUGIN_ID,
		version: VERSION,
		format: "native",
		entrypoint: PACKAGE,
		adminEntry: `${PACKAGE}/admin`,
		componentsEntry: `${PACKAGE}/astro`,
		options,
		adminPages: s.pages,
		adminWidgets: s.widgets,
		portableTextBlocks: s.blocks,
		...(s.capabilities.length ? { capabilities: s.capabilities } : {}),
	};
}

export function createPlugin(options: CoywolfOptions = {}) {
	const modules = buildModules(options);
	const s = surfaces(modules);
	const { hooks, tasks } = composeHooks(modules, { tasks: [] });

	return definePlugin({
		id: PLUGIN_ID,
		version: VERSION,
		...(s.capabilities.length ? { capabilities: s.capabilities } : {}),
		...(s.allowedHosts.length ? { allowedHosts: s.allowedHosts } : {}),
		storage: s.storage,
		admin: {
			entry: `${PACKAGE}/admin`,
			pages: s.pages,
			widgets: s.widgets,
			settingsSchema: s.settingsSchema,
			...(s.blocks.length ? { portableTextBlocks: s.blocks } : {}),
		},
		// biome-ignore lint/suspicious/noExplicitAny: composed handlers match EmDash's hook types at runtime.
		hooks: hooks as any,
		routes: Object.assign({}, featuresRoutes(modules, tasks), ...modules.map((m) => m.routes ?? {})),
	});
}

export default createPlugin;
